'use strict';
const assert = require('node:assert/strict');
const r = require('../utils/matchmaking/reliability');
let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
const NOW = 1_800_000_000_000; const D = 86400_000;
const rec = (kind, daysAgo = 1, status = 'active') => ({ kind, at: NOW - daysAgo * D, status });
const many = (kind, count, o = {}) => Array.from({ length: count }, (_, i) => rec(kind, 1 + i, o.status));
t('resumo conta só a janela e só registros ativos (disputados e removidos ficam de fora)', () => {
  const s = r.summarize([...many('joined', 3), rec('joined', 100), rec('completed', 2), rec('left_late', 3, 'disputed'), rec('left_early', 4, 'removed')], NOW);
  assert.deepEqual(s.counts, { joined: 3, completed: 1, left_early: 0, left_late: 0 }); assert.equal(s.disputed, 1);
});
t('um cancelamento isolado NUNCA vira padrão, mesmo sem outros dados', () => {
  assert.equal(r.summarize([rec('left_late')], NOW).pattern, 'insufficient');
  assert.equal(r.summarize([...many('joined', 6), rec('left_late')], NOW).pattern, 'steady');
  assert.equal(r.summarize([...many('joined', 6), ...many('left_late', 2)], NOW).pattern, 'steady');   // abaixo do mínimo de saídas tardias
});
t('"atenção" exige volume e proporção: ≥5 entradas, ≥3 saídas tardias e ≥40%', () => {
  assert.equal(r.summarize([...many('joined', 6), ...many('left_late', 3)], NOW).pattern, 'attention');        // 50%
  assert.equal(r.summarize([...many('joined', 10), ...many('left_late', 3)], NOW).pattern, 'steady');           // 30%
  assert.equal(r.summarize([...many('joined', 4), ...many('left_late', 4)], NOW).pattern, 'insufficient');      // poucas entradas
});
t('registros em disputa não geram "atenção" até a revisão', () => {
  assert.equal(r.summarize([...many('joined', 6), ...many('left_late', 3, { status: 'disputed' })], NOW).pattern, 'steady');
});
t('texto é neutro: sem número de pontuação, sem acusação, e avisa que não há punição', () => {
  const txt = r.describe(r.summarize([...many('joined', 6), ...many('left_late', 3)], NOW));
  assert.match(txt, /não há punição/); assert.match(txt, /peça revisão/); assert.doesNotMatch(txt, /pontua|score|nota|confiável|inconfiável|ruim/i);
  assert.match(r.describe(r.summarize([], NOW)), /um cancelamento isolado nunca é tratado como padrão/);
  assert.match(r.describe(r.summarize([...many('joined', 2), rec('left_late', 1, 'disputed')], NOW)), /em revisão não entra na conta/);
});
t('saída: antes de a equipe fechar é "cedo"; depois é "tarde"', () => {
  assert.equal(r.exitKind('open'), 'left_early'); assert.equal(r.exitKind('confirmed'), 'left_late'); assert.equal(r.exitKind('searching_replacement'), 'left_late');
});
t('pedido de revisão: só o dono do registro, uma vez, com teto de pedidos abertos', () => {
  const base = { userId: 'u', status: 'active', disputedAt: null };
  assert.ok(r.canDispute(base, 'u', 0).ok); assert.equal(r.canDispute(base, 'x', 0).code, 'NOT_YOURS'); assert.equal(r.canDispute({ ...base, status: 'disputed' }, 'u', 0).code, 'ALREADY_DISPUTED');
  assert.equal(r.canDispute({ ...base, status: 'removed' }, 'u', 0).code, 'ALREADY_REMOVED'); assert.equal(r.canDispute({ ...base, disputedAt: 1 }, 'u', 0).code, 'ALREADY_REVIEWED'); assert.equal(r.canDispute(base, 'u', 5).code, 'TOO_MANY');
  for (const c of ['NOT_YOURS', 'ALREADY_REMOVED', 'ALREADY_DISPUTED', 'ALREADY_REVIEWED', 'TOO_MANY', 'NOT_FOUND', 'BAD_STATE']) assert.ok(r.DISPUTE_ERRORS[c]);
});
t('o que NÃO é registrado: silêncio e recusa não têm tipo de registro', () => {
  assert.deepEqual([...r.KINDS], ['joined', 'completed', 'left_early', 'left_late']); assert.ok(!r.KINDS.some(k => /declin|recus|silen|expir|no_response/i.test(k)));
});
console.log(`\n${n} testes passaram.`);
