'use strict';

/**
 * Executa tarefas em ordem de solicitação, sem deixar uma falha bloquear
 * as tarefas seguintes. A Promise retornada por enqueue continua refletindo
 * o sucesso ou a falha da tarefa individual.
 */
function createSerialQueue() {
  let tail = Promise.resolve();

  function enqueue(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('A tarefa da fila precisa ser uma função.'));
    }
    const current = tail.then(task, task);
    tail = current.catch(() => {});
    return current;
  }

  enqueue.flush = () => tail;
  return enqueue;
}

module.exports = { createSerialQueue };
