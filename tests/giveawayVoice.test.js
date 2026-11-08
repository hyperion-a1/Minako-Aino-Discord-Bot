'use strict';
// Falas da Minako nos sorteios: toda variação renderiza sem "undefined", sem pingar @everyone,
// em tamanho razoável, e o seletor evita repetir a mesma fala em sequência.
const assert = require('node:assert/strict');
const Module = require('node:module');
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Pool: class Pool { on() {} } };
  return orig.call(this, request, parent, isMain);
};
const { line, LINES } = require('../utils/giveawayVoice');
Module._load = orig;

const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const vars = { name: 'Sorteio X', count: 3, plural, max: 20, min: 5, roles: '<@&1>', wait: 'faltam **2 dias**', link: 'https://discord.com/x',
  when: '<t:1:F>', added: '<@2>', removed: '<@3>', host: '<@4>', thread: '<#5>', failed: '<@6>', reason: 'sem permissão', list: 'um cargo' };

for (const [event, bank] of Object.entries(LINES)) {
  assert.ok(bank.length >= 1, `${event} sem falas`);
  for (const fn of bank) {
    const text = fn(vars);
    assert.ok(typeof text === 'string' && text.length > 5 && text.length < 400, `${event}: tamanho`);
    assert.ok(!/undefined|null|\[object/.test(text), `${event}: variável faltando -> ${text}`);
    assert.ok(!/@everyone|@here/.test(text), `${event}: ping global`);
    assert.ok(!/!{2,}|\?{2,}/.test(text), `${event}: exagero de pontuação -> ${text}`);
    const unicodeEmoji = (text.replace(/<a?:\w+:\d+>/g, '').match(/\p{Extended_Pictographic}/gu) || []).length;
    assert.ok(unicodeEmoji <= 3, `${event}: emojis demais -> ${text}`);
  }
}

// Eventos com 2+ variações não repetem em sequência.
for (const [event, bank] of Object.entries(LINES)) {
  if (bank.length < 2) continue;
  let prev = line(event, vars);
  for (let k = 0; k < 40; k += 1) { const cur = line(event, vars); assert.notEqual(cur, prev, `${event} repetiu`); prev = cur; }
}
assert.equal(line('evento-inexistente'), '');
console.log('giveawayVoice.test.js: OK');
