'use strict';
// Leitura/revisão do histórico de confiabilidade. A ESCRITA dos registros acontece dentro das transações do store
// (relRecord), para nunca divergir do que realmente aconteceu. Aqui: consulta, pedido de revisão, correção e retenção.
const db = require('../db');
const store = require('./store');
const rel = require('./reliability');
const { MmError, withTx } = store;

const view = (r) => r && ({ id: String(r.id), guildId: r.guild_id, userId: r.user_id, kind: r.kind, groupId: r.group_id == null ? null : String(r.group_id), matchId: r.match_id == null ? null : String(r.match_id),
  at: new Date(r.at).getTime(), status: r.status, note: r.note, disputedAt: r.disputed_at ? new Date(r.disputed_at).getTime() : null, resolvedBy: r.resolved_by });
const err = (code) => new MmError(code, rel.DISPUTE_ERRORS[code] || code);

async function listForUser(guildId, userId, { days = rel.RULES.windowDays, limit = 500 } = {}) {
  const { rows } = await db.getPool().query(`SELECT * FROM minako_mm_reliability WHERE guild_id=$1 AND user_id=$2 AND at > now() - make_interval(days => $3) ORDER BY at DESC LIMIT $4`, [guildId, String(userId), days, limit]);
  return rows.map(view);
}
async function recentForUser(guildId, userId, limit = 10) {
  const { rows } = await db.getPool().query('SELECT * FROM minako_mm_reliability WHERE guild_id=$1 AND user_id=$2 ORDER BY at DESC LIMIT $3', [guildId, String(userId), limit]);
  return rows.map(view);
}
async function getRecord(guildId, id) {
  const { rows } = await db.getPool().query('SELECT * FROM minako_mm_reliability WHERE guild_id=$1 AND id=$2', [guildId, id]);
  return view(rows[0]);
}
async function overview(guildId, userId, now = Date.now()) {
  const all = await listForUser(guildId, userId);
  return { summary: rel.summarize(all, now), recent: (await recentForUser(guildId, userId, 10)) };
}
// Pedir revisão: só o dono, uma vez por registro, com teto de pedidos abertos. Enquanto disputado, o registro não entra na conta.
async function dispute(guildId, userId, recordId) {
  return withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mmrel:${guildId}:${userId}`]);
    const r = view((await c.query('SELECT * FROM minako_mm_reliability WHERE guild_id=$1 AND id=$2 FOR UPDATE', [guildId, recordId])).rows[0]);
    if (!r) throw err('NOT_FOUND');
    const open = (await c.query(`SELECT count(*)::int n FROM minako_mm_reliability WHERE guild_id=$1 AND user_id=$2 AND status='disputed'`, [guildId, String(userId)])).rows[0].n;
    const d = rel.canDispute(r, userId, open);
    if (!d.ok) throw err(d.code);
    await c.query(`UPDATE minako_mm_reliability SET status='disputed', disputed_at=now() WHERE id=$1`, [recordId]);
    await store.logEvent(guildId, 'reliability.disputed', { recordId: String(recordId) }).catch(() => {});
    return { ...r, status: 'disputed' };
  });
}
// Decisão da revisão (ou correção administrativa): remover (comprovadamente incorreto) ou manter.
async function resolve(guildId, recordId, byId, decision, note = null) {
  if (!['remove', 'keep'].includes(decision)) throw new MmError('BAD_ACTION');
  return withTx(async (c) => {
    const r = view((await c.query('SELECT * FROM minako_mm_reliability WHERE guild_id=$1 AND id=$2 FOR UPDATE', [guildId, recordId])).rows[0]);
    if (!r) throw err('NOT_FOUND');
    if (r.status === 'removed') throw err('BAD_STATE');
    if (decision === 'keep' && r.status !== 'disputed') throw err('BAD_STATE');
    const u = (await c.query(`UPDATE minako_mm_reliability SET status=$2, note=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 RETURNING *`,
      [recordId, decision === 'remove' ? 'removed' : 'active', note || (decision === 'remove' ? 'Removido pela revisão.' : 'Mantido pela revisão.'), String(byId)])).rows[0];
    await store.logEvent(guildId, `reliability.${decision}`, { recordId: String(recordId), by: String(byId) }).catch(() => {});
    return view(u);
  });
}
// Retenção: registros mais antigos que o limite são apagados (minimização de dados).
async function purge() {
  const { rowCount } = await db.getPool().query(`DELETE FROM minako_mm_reliability WHERE at < now() - make_interval(days => $1)`, [rel.RULES.retentionDays]);
  return rowCount;
}

module.exports = { listForUser, recentForUser, getRecord, overview, dispute, resolve, purge };
