'use strict';
// Persistência das notificações avançadas: mensagens operacionais rastreadas (para encerrá-las quando a ação for resolvida),
// fila de agrupamento de avisos de disponibilidade, estado dos alertas e resumo periódico.
const db = require('../db');
const core = require('./mmCore');
const policy = require('./notifyPolicy');

// ---- mensagens operacionais (botões que precisam deixar de funcionar quando a ação é resolvida) ----
async function trackOp(guildId, userId, kind, ref, channelId, messageId) {
  await db.getPool().query('INSERT INTO minako_mm_op_messages (guild_id,user_id,kind,ref,channel_id,message_id) VALUES ($1,$2,$3,$4,$5,$6)', [guildId, String(userId), kind, String(ref), channelId, messageId]);
}
// Retira (e devolve) as mensagens de uma ação. prefix=true: todas cujo ref começa com `ref` (ex.: todos os pedidos de um grupo).
async function takeOps(guildId, kind, ref, { prefix = false, exceptMessageId = null } = {}) {
  const { rows } = await db.getPool().query(
    `DELETE FROM minako_mm_op_messages WHERE guild_id=$1 AND kind=$2 AND (${prefix ? 'ref LIKE $3' : 'ref = $3'}) AND ($4::text IS NULL OR message_id <> $4)
     RETURNING user_id, channel_id, message_id`, [guildId, kind, prefix ? `${String(ref).replace(/[%_\\]/g, '\\$&')}%` : String(ref), exceptMessageId]);
  return rows.map(r => ({ userId: r.user_id, channelId: r.channel_id, messageId: r.message_id }));
}
async function purgeOps() { return (await db.getPool().query(`DELETE FROM minako_mm_op_messages WHERE created_at < now() - interval '14 days'`)).rowCount; }

// ---- fila de agrupamento (parceiros/favoritos que ficaram disponíveis quase juntos) ----
async function enqueue(guildId, recipientId, category, subjectId, modeLabel = null) {
  await db.getPool().query('INSERT INTO minako_mm_notice_queue (guild_id,recipient_id,category,subject_id,mode_label) VALUES ($1,$2,$3,$4,$5)', [guildId, String(recipientId), category, String(subjectId), modeLabel]);
}
// Pega, de uma vez por destinatário, tudo o que já esperou a janela. DELETE...RETURNING é atômico: duas instâncias nunca enviam o mesmo.
async function claimQueue({ windowMs = policy.LIMITS.groupWindowMs, limit = 50 } = {}) {
  const pool = db.getPool();
  const due = (await pool.query(`SELECT DISTINCT guild_id, recipient_id FROM minako_mm_notice_queue WHERE created_at <= now() - make_interval(secs => $1) LIMIT $2`, [windowMs / 1000, limit])).rows;
  const out = [];
  for (const d of due) {
    const rows = (await pool.query(`DELETE FROM minako_mm_notice_queue WHERE guild_id=$1 AND recipient_id=$2 AND created_at <= now() RETURNING category, subject_id, mode_label, EXTRACT(EPOCH FROM created_at)*1000 AS at_ms`, [d.guild_id, d.recipient_id])).rows;
    if (rows.length) out.push({ guildId: d.guild_id, recipientId: d.recipient_id, items: rows.map(r => ({ category: r.category, subjectId: r.subject_id, modeLabel: r.mode_label, at: Number(r.at_ms) })) });
  }
  await pool.query(`DELETE FROM minako_mm_notice_queue WHERE created_at < now() - interval '1 hour'`);
  return out;
}

// ---- alerta de atividade da comunidade ----
// Reivindica o alerta do servidor (atômico): só uma instância dispara dentro do intervalo mínimo.
async function claimCommunityAlert(guildId, cooldownSec) {
  const { rowCount } = await db.getPool().query(
    `INSERT INTO minako_mm_alert_state (guild_id,kind,last_at) VALUES ($1,'community',now())
     ON CONFLICT (guild_id,kind) DO UPDATE SET last_at=now() WHERE minako_mm_alert_state.last_at < now() - make_interval(secs => $2)`, [guildId, cooldownSec]);
  return rowCount === 1;
}
async function lastCommunityAlert(guildId) {
  const { rows } = await db.getPool().query(`SELECT EXTRACT(EPOCH FROM last_at)*1000 AS ms FROM minako_mm_alert_state WHERE guild_id=$1 AND kind='community'`, [guildId]);
  return rows[0] ? Number(rows[0].ms) : null;
}
const prefsRowToObj = (r) => core.normalizePrefs({ notif: r.notif, quiet: r.quiet, pausedUntil: r.paused_ms == null ? null : Number(r.paused_ms) });
// Quem optou por alertas de atividade, quem já está jogando/disponível, e os avisos recentes (para os limites).
async function communityInputs(guildId) {
  const pool = db.getPool();
  const cands = (await pool.query(`SELECT user_id, notif, quiet, EXTRACT(EPOCH FROM paused_until)*1000 AS paused_ms FROM minako_mm_prefs WHERE guild_id=$1 AND notif->>'community'='dm' LIMIT 500`, [guildId])).rows;
  if (!cands.length) return { candidates: [], busy: new Set(), log: [] };
  const ids = cands.map(r => r.user_id);
  const busyRows = (await pool.query(
    `SELECT user_id FROM minako_mm_availability WHERE guild_id=$1 AND user_id = ANY($2) AND status='active' AND expires_at>now()
     UNION SELECT m.user_id FROM minako_mm_group_members m JOIN minako_mm_groups g ON g.id=m.group_id WHERE g.guild_id=$1 AND m.user_id = ANY($2) AND m.status='confirmed' AND g.state IN ('open','confirmed','searching_replacement')`, [guildId, ids])).rows;
  const log = (await pool.query(`SELECT recipient_id, category, EXTRACT(EPOCH FROM at)*1000 AS at_ms FROM minako_mm_notice_log WHERE guild_id=$1 AND recipient_id = ANY($2) AND at > now() - interval '24 hours'`, [guildId, ids])).rows
    .map(r => ({ recipient: r.recipient_id, category: r.category, at: Number(r.at_ms) }));
  return { candidates: cands.map(r => ({ userId: r.user_id, prefs: prefsRowToObj(r) })), busy: new Set(busyRows.map(r => r.user_id)), log };
}
async function logNotice(guildId, recipientId, subjectId, category) {
  await db.getPool().query('INSERT INTO minako_mm_notice_log (guild_id,recipient_id,subject_id,category) VALUES ($1,$2,$3,$4)', [guildId, String(recipientId), String(subjectId), category]);
}

// ---- resumo periódico ----
async function digestCandidates(guildId) {
  const { rows } = await db.getPool().query(`SELECT user_id, notif, quiet, EXTRACT(EPOCH FROM paused_until)*1000 AS paused_ms, EXTRACT(EPOCH FROM digest_last_at)*1000 AS last_ms FROM minako_mm_prefs WHERE guild_id=$1 AND notif->>'digest' IN ('daily','weekly') LIMIT 1000`, [guildId]);
  return rows.map(r => ({ userId: r.user_id, prefs: prefsRowToObj(r), lastAt: r.last_ms == null ? null : Number(r.last_ms) }));
}
// Marca o envio ANTES de enviar (no máximo um resumo a cada 12 h por pessoa, mesmo com duas instâncias).
async function claimDigest(guildId, userId) {
  const { rowCount } = await db.getPool().query(`UPDATE minako_mm_prefs SET digest_last_at=now() WHERE guild_id=$1 AND user_id=$2 AND (digest_last_at IS NULL OR digest_last_at < now() - interval '12 hours')`, [guildId, String(userId)]);
  return rowCount === 1;
}

module.exports = { trackOp, takeOps, purgeOps, enqueue, claimQueue, claimCommunityAlert, lastCommunityAlert, communityInputs, logNotice, digestCandidates, claimDigest };
