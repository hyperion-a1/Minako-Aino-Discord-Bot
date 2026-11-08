'use strict';
// Formato do backup e plano de restauração. PURO (sem banco): o script só executa o plano.
const FORMAT = 'minako-mm-backup-v1';
// Ordem de exclusão (filhos primeiro) e inserção (pais primeiro) respeitando as chaves estrangeiras.
const OPTIONAL = ['minako_mm_prefs', 'minako_mm_favorites', 'minako_mm_partnerships', 'minako_mm_notice_log', 'minako_mm_teams', 'minako_mm_team_members', 'minako_mm_reliability']; // ausente em backups feitos antes da v1.1
const DELETE_ORDER = ['minako_mm_events', 'minako_mm_matches', 'minako_mm_proposal_members', 'minako_mm_proposals', 'minako_mm_blocked_pairs', 'minako_mm_group_members', 'minako_mm_groups', 'minako_mm_team_members', 'minako_mm_teams', 'minako_mm_reliability', 'minako_mm_availability', 'minako_mm_prefs', 'minako_mm_favorites', 'minako_mm_partnerships', 'minako_mm_notice_log', 'minako_mm_settings'];
const INSERT_ORDER = [...DELETE_ORDER].reverse();
const SEQUENCES = { minako_mm_groups: 'id', minako_mm_proposals: 'id', minako_mm_matches: 'id', minako_mm_events: 'id', minako_mm_partnerships: 'id', minako_mm_notice_log: 'id', minako_mm_teams: 'id', minako_mm_reliability: 'id' };

function validateBackup(b, guildId) {
  if (!b || b.schema !== FORMAT) throw new Error(`Arquivo inválido: formato esperado "${FORMAT}".`);
  if (!guildId || String(b.guildId) !== String(guildId)) throw new Error('O backup é de outro servidor. Informe --guild com o mesmo ID do arquivo.');
  for (const t of INSERT_ORDER) if (!OPTIONAL.includes(t) && !Array.isArray(b.tables?.[t])) throw new Error(`Backup incompleto: tabela ${t} ausente.`);
  return true;
}
const jsonCols = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
function insertStatement(table, row) {
  const cols = Object.keys(row);
  return { sql: `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, params: cols.map(c => jsonCols(row[c])) };
}
// Tabelas sem guild_id são restauradas pelos pais (groups/proposals) do servidor.
function deleteStatements(guildId) {
  return [
    ['minako_mm_events', 'DELETE FROM minako_mm_events WHERE guild_id=$1'], ['minako_mm_matches', 'DELETE FROM minako_mm_matches WHERE guild_id=$1'],
    ['minako_mm_proposal_members', 'DELETE FROM minako_mm_proposal_members WHERE proposal_id IN (SELECT id FROM minako_mm_proposals WHERE guild_id=$1)'],
    ['minako_mm_proposals', 'DELETE FROM minako_mm_proposals WHERE guild_id=$1'], ['minako_mm_blocked_pairs', 'DELETE FROM minako_mm_blocked_pairs WHERE guild_id=$1'],
    ['minako_mm_group_members', 'DELETE FROM minako_mm_group_members WHERE group_id IN (SELECT id FROM minako_mm_groups WHERE guild_id=$1)'],
    ['minako_mm_groups', 'DELETE FROM minako_mm_groups WHERE guild_id=$1'],
    ['minako_mm_team_members', 'DELETE FROM minako_mm_team_members WHERE team_id IN (SELECT id FROM minako_mm_teams WHERE guild_id=$1)'], ['minako_mm_teams', 'DELETE FROM minako_mm_teams WHERE guild_id=$1'], ['minako_mm_reliability', 'DELETE FROM minako_mm_reliability WHERE guild_id=$1'], ['minako_mm_availability', 'DELETE FROM minako_mm_availability WHERE guild_id=$1'], ['minako_mm_prefs', 'DELETE FROM minako_mm_prefs WHERE guild_id=$1'], ['minako_mm_favorites', 'DELETE FROM minako_mm_favorites WHERE guild_id=$1'], ['minako_mm_partnerships', 'DELETE FROM minako_mm_partnerships WHERE guild_id=$1'], ['minako_mm_notice_log', 'DELETE FROM minako_mm_notice_log WHERE guild_id=$1'],
    ['minako_mm_settings', 'DELETE FROM minako_mm_settings WHERE guild_id=$1'],
  ].map(([table, sql]) => ({ table, sql, params: [guildId] }));
}
function buildRestorePlan(backup, guildId) {
  validateBackup(backup, guildId);
  const del = deleteStatements(guildId);
  const ins = INSERT_ORDER.flatMap(t => (backup.tables[t] || []).map(r => ({ table: t, ...insertStatement(t, r) })));
  const seq = Object.entries(SEQUENCES).map(([t, c]) => ({ table: t, sql: `SELECT setval(pg_get_serial_sequence('${t}','${c}'), COALESCE((SELECT max(${c}) FROM ${t}),0)+1, false)`, params: [] }));
  const counts = Object.fromEntries(INSERT_ORDER.map(t => [t, (backup.tables[t] || []).length]));
  return { steps: [...del, ...ins, ...seq], counts };
}
module.exports = { FORMAT, DELETE_ORDER, INSERT_ORDER, validateBackup, insertStatement, buildRestorePlan };
