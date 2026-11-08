'use strict';
const assert = require('node:assert/strict');
const c = require('../utils/matchmaking/mmCore');
const S = c.normalizeSettings({});
const NOW = 1_000_000_000_000;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const mode = (o = {}) => c.makeMode({ id: 'ranqueada', idealSize: 2, minSize: 2, eloRelevant: true, eloWindow: 1, ...o });
const av = (id, o = {}) => ({ ...c.makeAvailability({ userId: id, modeId: 'ranqueada', elo: 'ouro', now: NOW, ttlSec: 7200 }), ...o });

t('ordem dos elos: Grão-Mestre, Mítico, Épico, Lenda', () => {
  assert.deepEqual(c.RANKS.slice(-4).map(r => r[0]), ['grao-mestre', 'mitico', 'epico', 'lenda']);
});
t('padrões aprovados', () => {
  assert.equal(S.proposalTtlSec, 120); assert.equal(S.availabilityTtlSec, 7200);
  assert.equal(S.replacementTtlSec, 300); assert.equal(S.archiveAfterSec, 3 * 86400);
  assert.equal(S.confirmationWindowSec, 86400); assert.equal(S.groupInactivityTtlSec, 7200); assert.deepEqual(S.relaxAfterSec, [300, 600]);
});
t('configurações validam limites e IDs de revisão', () => {
  const x = c.normalizeSettings({ proposalTtlSec: 5, reviewChannelId: '1557770673819222137', reviewRoleId: 'abc' });
  assert.equal(x.proposalTtlSec, 30); assert.equal(x.reviewChannelId, '1557770673819222137'); assert.equal(x.reviewRoleId, null);
});
t('disponibilidade expira, pausa, renova e encerra', () => {
  const a = av('1'); assert.ok(c.isAvailabilityValid(a, NOW + 1000));
  assert.ok(!c.isAvailabilityValid(a, NOW + 7200_001));
  assert.ok(!c.isAvailabilityValid(c.pauseAvailability(a, NOW), NOW));
  assert.ok(c.isAvailabilityValid(c.renewAvailability(c.pauseAvailability(a, NOW), NOW + 5000, 7200), NOW + 6000));
  assert.equal(c.renewAvailability(c.endAvailability(a), NOW, 7200), null);
});
t('elo obrigatório nunca é relaxado, mesmo após muito tempo', () => {
  const q = [av('1', { elo: 'bronze', waitingSince: NOW - 3600_000 }), av('2', { elo: 'lenda', waitingSince: NOW - 3600_000 })];
  assert.equal(c.buildProposals(q, mode(), NOW, S).length, 0);
});
t('forma proposta com compatíveis e respeita expiração configurável', () => {
  const p = c.buildProposals([av('1'), av('2', { elo: 'prata' })], mode(), NOW, S);
  assert.equal(p.length, 1); assert.deepEqual(p[0].userIds.sort(), ['1', '2']); assert.equal(p[0].expiresAt, NOW + 120_000);
});
t('disponibilidade expirada/pausada não entra na fila', () => {
  const q = [av('1'), av('2', { status: 'paused' }), av('3', { expiresAt: NOW - 1 })];
  assert.equal(c.buildProposals(q, mode(), NOW, S).length, 0);
});
t('voz opcional: conflito bloqueia no início e é relaxado depois de 10 min', () => {
  const q = (w) => [av('1', { voice: 'yes', waitingSince: NOW - w }), av('2', { voice: 'no', waitingSince: NOW - w })];
  assert.equal(c.buildProposals(q(60_000), mode(), NOW, S).length, 0);
  assert.equal(c.buildProposals(q(601_000), mode(), NOW, S).length, 1);
});
t('grupo incompleto só após relaxar e se o modo permitir', () => {
  const m = mode({ idealSize: 3, minSize: 2, allowIncomplete: true, eloRelevant: false });
  const q = (w) => [av('1', { waitingSince: NOW - w }), av('2', { waitingSince: NOW - w })];
  assert.equal(c.buildProposals(q(10_000), m, NOW, S).length, 0);
  const p = c.buildProposals(q(301_000), m, NOW, S);
  assert.equal(p.length, 1); assert.ok(p[0].incomplete);
  const strict = mode({ idealSize: 3, minSize: 3, allowIncomplete: false, eloRelevant: false });
  assert.equal(c.buildProposals(q(900_000), strict, NOW, S).length, 0);
});
t('função obrigatória na vaga é considerada', () => {
  const m = mode({ eloRelevant: false, slots: [{ role: 'Selva' }, { role: 'Apoio' }] });
  assert.equal(c.buildProposals([av('1', { roles: ['Selva'] }), av('2', { roles: ['Selva'] })], m, NOW, S).length, 0);
  assert.equal(c.buildProposals([av('1', { roles: ['Selva'] }), av('2', { roles: ['Apoio'] })], m, NOW, S).length, 1);
});
t('mesmo usuário não entra em duas propostas e busy é respeitado', () => {
  const m = mode({ eloRelevant: false });
  const p = c.buildProposals([av('1'), av('2'), av('3')], m, NOW, S);
  assert.equal(p.length, 1);
  assert.equal(c.buildProposals([av('1'), av('2')], m, NOW, S, { busy: new Set(['1']) }).length, 0);
});
t('proposta só confirma com todas as aceitações', () => {
  const pr = { userIds: ['1', '2'], expiresAt: NOW + 1000 };
  assert.equal(c.resolveProposal(pr, { 1: 'accepted' }, NOW).outcome, 'pending');
  assert.equal(c.resolveProposal(pr, { 1: 'accepted', 2: 'accepted' }, NOW).outcome, 'confirmed');
});
t('expirada: sem punição, quem segue disponível volta à fila', () => {
  const pr = { userIds: ['1', '2', '3'], expiresAt: NOW - 1 };
  const r = c.resolveProposal(pr, { 1: 'accepted' }, NOW, id => id !== '3');
  assert.equal(r.outcome, 'expired'); assert.deepEqual(r.requeue, ['1', '2']); assert.equal(r.penalty, null);
});
t('recusa: demais continuam na fila, combinação não se repete e sem punição', () => {
  const pr = { userIds: ['1', '2'], expiresAt: NOW + 1000 };
  const r = c.resolveProposal(pr, { 1: 'accepted', 2: 'declined' }, NOW);
  assert.equal(r.outcome, 'declined'); assert.deepEqual(r.requeue, ['1']); assert.equal(r.penalty, null);
  const again = c.buildProposals([av('1'), av('2')], mode({ eloRelevant: false }), NOW, S, { blocked: new Set(r.blockedPairs) });
  assert.equal(again.length, 0);
});
t('proposta já encerrada não é reativada', () => {
  const r = c.resolveProposal({ userIds: ['1', '2'], expiresAt: NOW - 1, status: 'expired' }, { 1: 'accepted', 2: 'accepted' }, NOW);
  assert.equal(r.outcome, 'expired');
});
const grp = (o = {}) => ({ state: 'open', capacity: 2, members: [{ userId: 'o', status: 'confirmed' }], ...o });
t('última vaga: segunda decisão após a primeira é negada (recontagem na transação)', () => {
  const g = grp(); const m = mode({ eloRelevant: false });
  assert.equal(c.decideJoin(g, { userId: 'a' }, m).action, 'confirm');
  g.members.push({ userId: 'a', status: 'confirmed' });
  assert.equal(c.decideJoin(g, { userId: 'b' }, m).code, 'NO_SLOT');
  assert.equal(c.freeSlots(g), 0);
});
t('pedido pendente não ocupa vaga; ao aprovar revalida a vaga', () => {
  const g = grp(); const m = mode({ eloRelevant: false });
  assert.equal(c.decideJoin(g, { userId: 'a' }, m, { organizerApproval: true }).action, 'request_pending');
  g.members.push({ userId: 'a', status: 'pending' });
  assert.equal(c.freeSlots(g), 1);
  g.members.push({ userId: 'x', status: 'confirmed' });
  assert.equal(c.decideJoin(g, { userId: 'a' }, m, { organizerApproval: true, approved: true }).code, 'NO_SLOT');
});
t('requisitos e compromissos incompatíveis bloqueiam entrada', () => {
  const m = mode();
  assert.equal(c.decideJoin(grp({ eloRange: [3, 5] }), { userId: 'a', elo: 'bronze' }, m).code, 'ELO_REQUIREMENT');
  assert.equal(c.decideJoin(grp(), { userId: 'a', elo: 'ouro', busyElsewhere: true }, m).code, 'INCOMPATIBLE_COMMITMENT');
  assert.equal(c.decideJoin(grp({ state: 'closed' }), { userId: 'a', elo: 'ouro' }, m).code, 'GROUP_NOT_OPEN');
});
t('saída em grupo confirmado inicia busca por substituto', () => {
  const g = grp({ state: 'confirmed', capacity: 2, members: [{ userId: 'o', status: 'confirmed' }] });
  assert.deepEqual(c.afterLeave(g), { state: 'searching_replacement', searchReplacement: true });
});
t('máquina de estados', () => {
  assert.ok(c.canTransition('confirmed', 'searching_replacement'));
  assert.ok(!c.canTransition('completed', 'open')); assert.ok(!c.canTransition('closed', 'open'));
});
t('registro: contestação vai a revisão sem recompensa; silêncio não valida nem invalida', () => {
  const base = { participantIds: ['o', 'a', 'b'], organizerId: 'o', windowEndsAt: NOW + 1000 };
  assert.deepEqual(c.resolveMatchRecord({ ...base, responses: { a: 'contested' } }, NOW), { status: 'review', final: false, rewards: false });
  assert.equal(c.resolveMatchRecord({ ...base, responses: { a: 'confirmed' } }, NOW).status, 'pending_window');
  const end = c.resolveMatchRecord({ ...base, responses: { a: 'confirmed' } }, NOW + 2000);
  assert.equal(end.status, 'recorded'); assert.equal(end.rewards, false);
  assert.equal(c.resolveMatchRecord({ ...base, responses: { a: 'confirmed', b: 'confirmed' } }, NOW + 2000).status, 'validated');
});
console.log(`\n${n} testes passaram.`);
// ---- funções exigidas (reserva de vagas)
(() => {
  const m = mode({ eloRelevant: false });
  const g = (o) => ({ state: 'open', capacity: 3, members: [{ userId: 'o', status: 'confirmed', role: 'Selva' }], ...o });
  t('função exigida: com vagas todas reservadas, função é obrigatória e deve estar aberta', () => {
    const grp = g({ requiredRolesOpen: ['Apoio', 'Meio'] }); // 2 vagas livres, 2 funções abertas
    assert.equal(c.decideJoin(grp, { userId: 'a' }, m).code, 'ROLE_REQUIRED');
    assert.equal(c.decideJoin(grp, { userId: 'a' }, m, { role: 'Selva' }).code, 'ROLE_UNAVAILABLE');
    assert.equal(c.decideJoin(grp, { userId: 'a' }, m, { role: 'Apoio' }).action, 'confirm');
  });
  t('função exigida: com vaga flexível sobrando, função é opcional', () => {
    const grp = g({ requiredRolesOpen: ['Apoio'] }); // 2 livres, 1 função reservada
    assert.equal(c.decideJoin(grp, { userId: 'a' }, m).action, 'confirm');
  });
  console.log(`\n${n} testes passaram no total.`);
})();
