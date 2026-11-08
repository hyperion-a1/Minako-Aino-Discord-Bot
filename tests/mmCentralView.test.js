'use strict';
const assert = require('node:assert/strict');
const v = require('../utils/matchmaking/centralView');
const core = require('../utils/matchmaking/mmCore');
const NOW = 1_800_000_000_000; let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
t('tempo relativo', () => {
  assert.equal(v.relativeTime(NOW - 10_000, NOW), 'agora há pouco');
  assert.equal(v.relativeTime(NOW - 120_000, NOW), 'há 2 min');
  assert.equal(v.relativeTime(NOW - 3 * 3600_000, NOW), 'há 3 h');
});
t('estado vazio claro, sem inventar atividade', () => {
  const vm = v.buildView({}, core.DEFAULT_MODES, NOW);
  assert.ok(vm.empty);
  const txt = v.renderText(vm);
  assert.match(txt, /Ninguém está procurando/); assert.doesNotMatch(txt, /Atividade recente/); assert.doesNotMatch(txt, /Costuma ter mais gente/);
});
t('previsão só com dados suficientes', () => {
  const hourly = Array(24).fill(0); hourly[20] = 30; hourly[21] = 30;
  assert.equal(v.peakWindow({ hourly, days: 5 }), null);
  assert.equal(v.peakWindow({ hourly: Array(24).fill(1), days: 20 }), null);
  assert.deepEqual(v.peakWindow({ hourly, days: 20 }), { startHour: 20, endHour: 22 });
  const vm = v.buildView({ availableNow: 1, hourlyActivity: { hourly, days: 20 } }, core.DEFAULT_MODES, NOW);
  assert.match(v.renderText(vm), /20h–22h/);
});
t('números e vagas refletem os dados; propostas só agregadas', () => {
  const vm = v.buildView({ availableNow: 3, pendingProposals: 2, matchesToday: 4, openGroups: [{ id: '1', modeId: 'ranqueada', free: 2, capacity: 5, confirmed: 3 }] }, core.DEFAULT_MODES, NOW);
  const txt = v.renderText(vm);
  assert.match(txt, /Disponíveis agora:\*\* 3/); assert.match(txt, /1 \| ?|Grupos abertos:\*\* 1 · \*\*2\*\* vagas/); assert.match(txt, /Ranqueada — 3\/5/);
  assert.match(txt, /Propostas em andamento:\*\* 2/); assert.match(txt, /registradas hoje:\*\* 4/);
});
t('atividade recente: nomes só em grupo público; disponibilidade e propostas não vazam nomes', () => {
  const vm = v.buildView({ recentEvents: [
    { type: 'availability.set', payload: { userId: '9' }, at: NOW - 1000 },
    { type: 'group.joined', payload: { userId: '7' }, at: NOW - 120_000 },
    { type: 'proposal.confirmed', payload: { userIds: ['1', '2'] }, at: NOW - 300_000 },
  ] }, core.DEFAULT_MODES, NOW);
  const txt = v.renderText(vm);
  assert.match(txt, /<@7> entrou em um grupo · há 2 min/); assert.match(txt, /equipe foi formada pela fila/);
  assert.doesNotMatch(txt, /<@9>/); assert.doesNotMatch(txt, /<@1>/);
});
console.log(`\n${n} testes passaram.`);
