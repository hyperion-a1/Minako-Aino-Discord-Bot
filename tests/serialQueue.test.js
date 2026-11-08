'use strict';

const assert = require('node:assert/strict');
const { createSerialQueue } = require('../utils/serialQueue');

(async () => {
  const enqueue = createSerialQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = enqueue(async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  const second = enqueue(async () => { order.push('second'); });
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);

  await assert.rejects(enqueue(async () => { throw new Error('expected'); }), /expected/);
  await enqueue(async () => { order.push('after-failure'); });
  assert.equal(order.at(-1), 'after-failure', 'uma falha não pode bloquear a fila');
  await enqueue.flush();

  console.log('serialQueue.test.js: todos os testes passaram.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
