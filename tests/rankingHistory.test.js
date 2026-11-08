const assert = require('node:assert/strict');
const { buildHistoryByWeek, historyTopMap, hasConsecutiveWeeks } = require('../utils/rankingHistory');

const manual = [
  { week_id: '2026-09-14', user_id: 'A', position: 1, messages: 100 },
  { week_id: '2026-09-14', user_id: 'B', position: 2, messages: 90 },
  { week_id: '2026-09-21', user_id: 'A', position: 2, messages: 110 },
  { week_id: '2026-09-21', user_id: 'C', position: 1, messages: 120 }
];
const snapshots = [
  // Snapshot congelado deve substituir a semana inteira do histórico manual.
  { week_id: '2026-09-21', user_id: 'D', position: 1, messages: 130 },
  { week_id: '2026-09-21', user_id: 'E', position: 2, messages: 125 },
  { week_id: '2026-09-28', user_id: 'A', position: 1, messages: 140 }
];

const history = buildHistoryByWeek(manual, snapshots, '2026-09-28');
assert.deepEqual([...history.keys()].sort(), ['2026-09-14', '2026-09-21']);
assert.deepEqual(history.get('2026-09-21').map(r => r.user_id), ['D', 'E']);
assert.equal(history.get('2026-09-14').length, 2);
assert.equal(history.has('2026-09-28'), false, 'semana em edição não pode usar snapshot antigo como histórico');

const top = historyTopMap(history);
assert.deepEqual(top.get('2026-09-21'), ['D', 'E']);
assert.equal(hasConsecutiveWeeks(history, '2026-09-28', 1), true);
assert.equal(hasConsecutiveWeeks(history, '2026-09-28', 2), true);
assert.equal(hasConsecutiveWeeks(history, '2026-09-28', 3), false, 'lacunas não podem ser tratadas como semanas registradas');

console.log('rankingHistory.test.js: OK');
