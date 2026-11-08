'use strict';
// Persistência de favoritos (privados) e parcerias (mútuas). Decisões vêm de social.js (puro);
// aqui só há transações, travas e leitura/escrita. Favoritos NUNCA são lidos "ao contrário" para exibição:
// a única leitura por favoritado é interna, em watchRecipients, e devolve apenas quem será avisado.
const db = require('../db');
const store = require('./store');
const core = require('./mmCore');
const social = require('./social');
const { MmError, withTx } = store;

async function lockUsers(c, guildId, ids) {
  for (const id of [...new Set(ids.map(String))].sort()) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mmsoc:${guildId}:${id}`]);
}
const ms = (v) => (v == null ? null : new Date(v).getTime());
const view = (r) => r && ({ id: String(r.id), guildId: r.guild_id, userA: r.user_a, userB: r.user_b, inviterId: r.inviter_id, status: r.status, expiresAt: ms(r.expires_at), createdAt: ms(r.created_at), respondedAt: ms(r.responded_at), dmChannelId: r.dm_channel_id, dmMessageId: r.dm_message_id });

// ---------- Favoritos (privados, unilaterais) ----------
async function listFavorites(guildId, userId) {
  const { rows } = await db.getPool().query('SELECT target_id FROM minako_mm_favorites WHERE guild_id=$1 AND user_id=$2 ORDER BY created_at', [guildId, userId]);
  return rows.map(r => r.target_id);
}
async function addFavorite(guildId, userId, targetId, { isBot = false } = {}) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, [userId]);
    const { rows } = await c.query('SELECT target_id FROM minako_mm_favorites WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
    const d = social.canFavorite(userId, targetId, { count: rows.length, isBot, already: rows.some(r => r.target_id === String(targetId)) });
    if (!d.ok) throw new MmError(d.code, social.FAVORITE_ERRORS[d.code]);
    await c.query('INSERT INTO minako_mm_favorites (guild_id,user_id,target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [guildId, userId, String(targetId)]);
    return rows.length + 1;
  });
}
async function removeFavorite(guildId, userId, targetId) {
  const { rowCount } = await db.getPool().query('DELETE FROM minako_mm_favorites WHERE guild_id=$1 AND user_id=$2 AND target_id=$3', [guildId, userId, String(targetId)]);
  return rowCount === 1;
}

// ---------- Parcerias (mútuas) ----------
async function getPartnership(id, c = db.getPool()) {
  const { rows } = await c.query('SELECT * FROM minako_mm_partnerships WHERE id=$1', [id]);
  return view(rows[0]);
}
async function listPartnerships(guildId, userId) {
  const { rows } = await db.getPool().query(
    `SELECT * FROM minako_mm_partnerships WHERE guild_id=$1 AND (user_a=$2 OR user_b=$2) AND (status='active' OR (status='pending' AND expires_at>now())) ORDER BY created_at`, [guildId, userId]);
  const all = rows.map(view);
  return {
    partners: all.filter(p => p.status === 'active').map(p => ({ id: p.id, partnerId: social.other(p, userId), since: p.respondedAt })),
    incoming: all.filter(p => p.status === 'pending' && p.inviterId !== userId).map(p => ({ id: p.id, from: p.inviterId, expiresAt: p.expiresAt })),
    outgoing: all.filter(p => p.status === 'pending' && p.inviterId === userId).map(p => ({ id: p.id, to: social.other(p, userId), expiresAt: p.expiresAt })),
  };
}
const activeCount = async (c, guildId, userId) => (await c.query(`SELECT count(*)::int n FROM minako_mm_partnerships WHERE guild_id=$1 AND (user_a=$2 OR user_b=$2) AND status='active'`, [guildId, userId])).rows[0].n;

async function invitePartner(guildId, inviterId, targetId, { targetIsBot = false, now = Date.now() } = {}) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, [inviterId, targetId]);
    const [a, b] = social.pair(inviterId, targetId);
    await c.query(`UPDATE minako_mm_partnerships SET status='expired', responded_at=now() WHERE guild_id=$1 AND user_a=$2 AND user_b=$3 AND status='pending' AND expires_at<=now()`, [guildId, a, b]);
    const live = view((await c.query(`SELECT * FROM minako_mm_partnerships WHERE guild_id=$1 AND user_a=$2 AND user_b=$3 AND status IN ('pending','active') FOR UPDATE`, [guildId, a, b])).rows[0]);
    const closed = view((await c.query(`SELECT * FROM minako_mm_partnerships WHERE guild_id=$1 AND user_a=$2 AND user_b=$3 AND status IN ('declined','expired','ended') ORDER BY COALESCE(responded_at, created_at) DESC LIMIT 1`, [guildId, a, b])).rows[0]);
    const myActive = (await c.query(`SELECT user_a, user_b FROM minako_mm_partnerships WHERE guild_id=$1 AND (user_a=$2 OR user_b=$2) AND status='active'`, [guildId, inviterId])).rows;
    const pendingOut = (await c.query(`SELECT count(*)::int n FROM minako_mm_partnerships WHERE guild_id=$1 AND inviter_id=$2 AND status='pending' AND expires_at>now()`, [guildId, inviterId])).rows[0].n;
    const d = social.canInvite(inviterId, targetId, {
      targetIsBot, activePartners: myActive, targetActiveCount: await activeCount(c, guildId, targetId), pendingOutCount: pendingOut,
      existing: live && { status: live.status }, reversePending: Boolean(live && live.status === 'pending' && live.inviterId === String(targetId)),
      lastClosed: closed && { status: closed.status, at: closed.respondedAt ?? closed.createdAt },
    }, now);
    if (!d.ok) throw new MmError(d.code, social.INVITE_ERRORS[d.code]);
    if (d.auto) {   // convites cruzados = interesse mútuo: vira parceria na hora
      await c.query(`UPDATE minako_mm_partnerships SET status='active', responded_at=now() WHERE id=$1`, [live.id]);
      return { action: 'activated', id: live.id };
    }
    const r = (await c.query(`INSERT INTO minako_mm_partnerships (guild_id,user_a,user_b,inviter_id,status,expires_at) VALUES ($1,$2,$3,$4,'pending', now() + make_interval(secs=>$5)) RETURNING *`,
      [guildId, a, b, String(inviterId), social.LIMITS.inviteTtlMs / 1000])).rows[0];
    await store.logEvent(guildId, 'partner.invited', { id: String(r.id) }).catch(() => {});
    return { action: 'invited', id: String(r.id), expiresAt: ms(r.expires_at) };
  });
}
// Responder convite: só o convidado. Idempotente; convite vencido nunca é reativado.
async function respondPartnership(id, userId, accept) {
  return withTx(async (c) => {
    const r = view((await c.query('SELECT * FROM minako_mm_partnerships WHERE id=$1 FOR UPDATE', [id])).rows[0]);
    if (!r) throw new MmError('NOT_FOUND', 'Esse convite não existe mais.');
    if (![r.userA, r.userB].includes(String(userId))) throw new MmError('NOT_PARTICIPANT', 'Esse convite não é seu.');
    if (r.inviterId === String(userId)) throw new MmError('NOT_TARGET', 'Você enviou esse convite; quem responde é a outra pessoa.');
    await lockUsers(c, r.guildId, [r.userA, r.userB]);
    if (r.status !== 'pending') return { stale: true, status: r.status, partnership: r };
    if (r.expiresAt <= Date.now()) { await c.query(`UPDATE minako_mm_partnerships SET status='expired', responded_at=now() WHERE id=$1`, [id]); return { stale: true, status: 'expired', partnership: r }; }
    if (!accept) { await c.query(`UPDATE minako_mm_partnerships SET status='declined', responded_at=now() WHERE id=$1`, [id]); return { status: 'declined', partnership: r }; }
    if ((await activeCount(c, r.guildId, r.userA)) >= social.LIMITS.maxPartners || (await activeCount(c, r.guildId, r.userB)) >= social.LIMITS.maxPartners) throw new MmError('LIMIT', 'Uma das pessoas já atingiu o limite de parcerias.');
    await c.query(`UPDATE minako_mm_partnerships SET status='active', responded_at=now() WHERE id=$1`, [id]);
    await store.logEvent(r.guildId, 'partner.activated', { id: String(id) }).catch(() => {});
    return { status: 'active', partnership: r };
  });
}
async function endPartnership(guildId, userId, otherId) {
  const [a, b] = social.pair(userId, otherId);
  const { rowCount } = await db.getPool().query(`UPDATE minako_mm_partnerships SET status='ended', ended_by=$4, responded_at=now() WHERE guild_id=$1 AND user_a=$2 AND user_b=$3 AND status='active'`, [guildId, a, b, String(userId)]);
  return rowCount === 1;
}
async function setPartnershipDm(id, channelId, messageId) {
  await db.getPool().query('UPDATE minako_mm_partnerships SET dm_channel_id=$2, dm_message_id=$3 WHERE id=$1', [id, channelId, messageId]);
}
async function sweepExpiredInvites(limit = 50) {
  const { rows } = await db.getPool().query(`UPDATE minako_mm_partnerships SET status='expired', responded_at=now() WHERE id IN (SELECT id FROM minako_mm_partnerships WHERE status='pending' AND expires_at<=now() LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit]);
  return rows.map(view);
}

// Parceiros disponíveis agora — só os que permitem (visibilidade diferente de "ninguém").
async function partnersAvailableNow(guildId, userId) {
  const { rows } = await db.getPool().query(
    `SELECT CASE WHEN p.user_a=$2 THEN p.user_b ELSE p.user_a END AS partner_id
       FROM minako_mm_partnerships p
       JOIN minako_mm_availability av ON av.guild_id=p.guild_id AND av.user_id = CASE WHEN p.user_a=$2 THEN p.user_b ELSE p.user_a END AND av.status='active' AND av.expires_at>now()
       LEFT JOIN minako_mm_prefs pr ON pr.guild_id=p.guild_id AND pr.user_id=av.user_id
      WHERE p.guild_id=$1 AND p.status='active' AND (p.user_a=$2 OR p.user_b=$2) AND COALESCE(pr.visibility,'partners')<>'none'`, [guildId, userId]);
  return new Set(rows.map(r => r.partner_id));
}

// Quem avisar quando `subjectId` fica disponível. Decide em social.selectWatchRecipients e REGISTRA o aviso (frequência).
async function watchRecipients(guildId, subjectId, now = Date.now()) {
  return withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mmwatch:${guildId}:${subjectId}`]);
    const subj = await store.getPrefs(guildId, subjectId, c);
    if (subj.visibility === 'none') return [];
    const partners = (await c.query(`SELECT CASE WHEN user_a=$2 THEN user_b ELSE user_a END AS id FROM minako_mm_partnerships WHERE guild_id=$1 AND status='active' AND (user_a=$2 OR user_b=$2)`, [guildId, subjectId])).rows.map(r => r.id);
    const favoriters = subj.visibility === 'favorites' ? (await c.query('SELECT user_id FROM minako_mm_favorites WHERE guild_id=$1 AND target_id=$2', [guildId, subjectId])).rows.map(r => r.user_id) : [];
    const ids = [...new Set([...partners, ...favoriters])];
    if (!ids.length) return [];
    const prefsRows = (await c.query('SELECT user_id, notif FROM minako_mm_prefs WHERE guild_id=$1 AND user_id = ANY($2)', [guildId, ids])).rows;
    const prefsBy = Object.fromEntries(prefsRows.map(r => [r.user_id, core.normalizePrefs({ notif: r.notif })]));
    for (const id of ids) prefsBy[id] ||= core.normalizePrefs({});
    const log = (await c.query(`SELECT recipient_id, subject_id, EXTRACT(EPOCH FROM at)*1000 AS at_ms FROM minako_mm_notice_log WHERE guild_id=$1 AND recipient_id = ANY($2) AND at > now() - interval '24 hours'`, [guildId, ids])).rows
      .map(r => ({ recipient: r.recipient_id, subject: r.subject_id, at: Number(r.at_ms) }));
    const out = social.selectWatchRecipients({ subjectId, visibility: subj.visibility, partners, favoriters, prefsBy, log, now });
    for (const r of out) await c.query('INSERT INTO minako_mm_notice_log (guild_id,recipient_id,subject_id,category) VALUES ($1,$2,$3,$4)', [guildId, r.userId, String(subjectId), r.category]);
    await c.query(`DELETE FROM minako_mm_notice_log WHERE guild_id=$1 AND at < now() - interval '7 days'`, [guildId]);
    return out;
  });
}

module.exports = { listFavorites, addFavorite, removeFavorite, getPartnership, listPartnerships, invitePartner, respondPartnership, endPartnership, setPartnershipDm, sweepExpiredInvites, partnersAvailableNow, watchRecipients };
