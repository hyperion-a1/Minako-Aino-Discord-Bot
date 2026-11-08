'use strict';
// Ressorteio: o host escolhe N ganhadores atuais; N novos ganhadores assumem essas vagas.
// Usa um "pg" falso que imita só as consultas do redrawTx (a SQL real precisa de homologação).
const assert = require('node:assert/strict');
const Module = require('node:module');

let row; let entries; let updated;
const client = {
  async query(sql, params) {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/FOR UPDATE/.test(sql)) return { rows: row ? [row] : [] };
    if (/FROM minako_giveaway_entries/.test(sql)) return { rows: entries.map((u) => ({ user_id: u })) };
    if (/^UPDATE minako_giveaways SET winners/.test(sql)) { updated = JSON.parse(params[1]); row = { ...row, winners: updated }; return { rows: [row] }; }
    throw new Error(`SQL inesperada: ${sql}`);
  },
  release() {},
};
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Pool: class Pool { on() {} async connect() { return client; } async query(...a) { return client.query(...a); } } };
  return orig.call(this, request, parent, isMain);
};
process.env.DATABASE_URL = 'postgres://fake/fake';
const store = require('../utils/giveawayStore');
Module._load = orig;

const W = ['w1', 'w2', 'w3'].map((x) => `1000000000000000${x.slice(1)}`);
const base = () => ({ id: 1, guild_id: 'g', name: 'T', status: 'drawn', host_id: '9', channel_id: '1', winners: [...W], config: {}, redraw_count: 0, attempts: 0 });
const everyone = [...W, 'a1', 'a2', 'a3', 'a4'].map((x, n) => (W.includes(x) ? x : `2000000000000000${n}`));
const rng = () => 0;

(async () => {
  // substitui 2 de 3: entram 2 novos nas posições dos substituídos; o terceiro permanece
  row = base(); entries = [...everyone];
  let r = await store.redrawTx('g', 1, { replaceIds: [W[0], W[2]], rng });
  assert.equal(r.kind, 'redrawn');
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.removed, [W[0], W[2]]);
  assert.equal(r.winners[1], W[1]);
  assert.equal(r.winners[0], r.added[0]); assert.equal(r.winners[2], r.added[1]);
  assert.ok(r.added.every((u) => !W.includes(u)), 'ninguém dos ganhadores atuais volta');
  assert.equal(new Set(r.winners).size, 3);

  // substitui 1
  row = base(); r = await store.redrawTx('g', 1, { replaceIds: [W[1]], rng });
  assert.equal(r.added.length, 1); assert.equal(r.winners[0], W[0]); assert.equal(r.winners[2], W[2]);

  // evitar pessoas e inválidos
  row = base(); r = await store.redrawTx('g', 1, { replaceIds: [W[0]], excludedIds: [everyone[3]], invalidIds: new Set([everyone[4]]), rng });
  assert.ok(![everyone[3], everyone[4]].includes(r.added[0]));

  // pool insuficiente: precisa de 3, só existem 2 elegíveis
  row = base(); r = await store.redrawTx('g', 1, { replaceIds: W, excludedIds: [everyone[3], everyone[4]], rng });
  assert.equal(r.kind, 'not_enough'); assert.equal(r.needed, 3); assert.equal(r.available, 2);
  assert.deepEqual(row.winners, W, 'nada muda quando não há gente suficiente');

  // alvo inválido / vazio / duplicado
  row = base(); assert.equal((await store.redrawTx('g', 1, { replaceIds: ['999999999999999999'] })).kind, 'bad_target');
  row = base(); assert.equal((await store.redrawTx('g', 1, { replaceIds: [] })).kind, 'bad_target');
  row = base(); r = await store.redrawTx('g', 1, { replaceIds: [W[0], W[0]], rng }); assert.equal(r.added.length, 1);

  // só em sorteio "drawn"
  row = { ...base(), status: 'concluded' }; assert.equal((await store.redrawTx('g', 1, { replaceIds: [W[0]] })).kind, 'not_drawn');
  row = null; assert.equal((await store.redrawTx('g', 1, { replaceIds: [W[0]] })).kind, 'missing');
  console.log('giveawayRedraw.test.js: OK');
})().catch((e) => { console.error(e); process.exit(1); }).then(() => process.exit(0));
