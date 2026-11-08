'use strict';
const assert = require('node:assert/strict');
const b = require('../utils/matchmaking/backupFormat');
let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
const tables = Object.fromEntries(b.INSERT_ORDER.map(x => [x, []]));
tables.minako_mm_groups = [{ id: 7, guild_id: 'g', roles: ['a'], created_at: '2026-10-15T00:00:00.000Z' }];
tables.minako_mm_group_members = [{ group_id: 7, user_id: 'u', status: 'confirmed' }];
const backup = { schema: b.FORMAT, guildId: 'g', tables };
t('valida formato, servidor e tabelas', () => {
  assert.ok(b.validateBackup(backup, 'g'));
  assert.throws(() => b.validateBackup(backup, 'outro'), /outro servidor/); assert.throws(() => b.validateBackup({ schema: 'x' }, 'g'), /inválido/);
  assert.throws(() => b.validateBackup({ ...backup, tables: { ...tables, minako_mm_matches: undefined } }, 'g'), /incompleto/);
});
t('plano: apaga filhos antes dos pais e insere pais antes dos filhos', () => {
  const p = b.buildRestorePlan(backup, 'g'); const idx = (t, kind) => p.steps.findIndex(s => s.table === t && s.sql.startsWith(kind));
  assert.ok(idx('minako_mm_group_members', 'DELETE') < idx('minako_mm_groups', 'DELETE'));
  assert.ok(idx('minako_mm_groups', 'INSERT') < idx('minako_mm_group_members', 'INSERT'));
  assert.ok(p.steps.findIndex(s => s.sql.startsWith('INSERT')) > p.steps.findLastIndex(s => s.sql.startsWith('DELETE')));
});
t('apaga só o servidor informado e converte JSON para o banco', () => {
  const p = b.buildRestorePlan(backup, 'g'); assert.ok(p.steps.filter(s => s.sql.startsWith('DELETE')).every(s => /\$1/.test(s.sql) && s.params[0] === 'g'));
  const ins = p.steps.find(s => s.sql.startsWith('INSERT INTO minako_mm_groups')); assert.equal(ins.params[ins.sql.includes('"roles"') ? 2 : 0] !== undefined, true);
  assert.ok(ins.params.includes('["a"]')); assert.equal(p.counts.minako_mm_groups, 1);
  assert.ok(p.steps.at(-1).sql.includes('setval'));
});
console.log(`\n${n} testes passaram.`);
