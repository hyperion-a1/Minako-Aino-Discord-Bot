'use strict';
const assert = require('node:assert/strict');
const v = require('../utils/matchmaking/groupView');
const base = { id: '1', state: 'open', organizerId: 'o', capacity: 5, confirmed: 3, free: 2, joinMethod: 'direct', allowIncomplete: false, members: [{ userId: 'o' }, { userId: 'a' }, { userId: 'b', role: 'Apoio' }], pending: [], requiredRoles: [], eloRange: null };
let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
t('mostra participantes confirmados e vagas reais', () => {
  const x = v.renderAnnouncement(base, 'Ranqueada');
  assert.match(x, /3\/5 confirmados · \*\*2\*\* livres/); assert.match(x, /<@b> \(Apoio\)/); assert.match(x, /Entrada:\*\* direta/);
});
t('pedidos pendentes aparecem só como contagem e não mudam as vagas', () => {
  const x = v.renderAnnouncement({ ...base, joinMethod: 'approval', pending: ['p1', 'p2'] }, 'Normal');
  assert.match(x, /2 pedido\(s\) aguardando/); assert.match(x, /3\/5/); assert.doesNotMatch(x, /<@p1>/);
});
t('estados: procurando substituto, completo, encerrado', () => {
  assert.match(v.renderAnnouncement({ ...base, state: 'searching_replacement', searchUntil: 1_800_000_000_000 }, 'X'), /Procurando substituto\*\* até <t:1800000000:R>/);
  assert.match(v.renderAnnouncement({ ...base, free: 0, confirmed: 5 }, 'X'), /Completo/);
  assert.match(v.renderAnnouncement({ ...base, state: 'closed' }, 'X'), /Encerrado/);
});
t('funções exigidas só listam as ainda abertas; faixa de elo é exibida', () => {
  const x = v.renderAnnouncement({ ...base, requiredRoles: ['Apoio', 'Selva'], eloRange: [2, 4] }, 'X');
  assert.match(x, /Funções necessárias:\*\* Selva/); assert.doesNotMatch(x, /necessárias:\*\* Apoio/); assert.match(x, /Ouro a Diamante|Ouro a Mestre|Ouro a/);
});
t('joinable: só com vaga e estado aberto/substituição', () => {
  assert.ok(v.isJoinable(base)); assert.ok(!v.isJoinable({ ...base, free: 0 })); assert.ok(!v.isJoinable({ ...base, state: 'confirmed' }));
});
console.log(`\n${n} testes passaram.`);
