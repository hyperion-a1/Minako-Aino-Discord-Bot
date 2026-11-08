const { shiftWeekId } = require('./week');

/**
 * Combina o histórico manual legado com edições congeladas do quadro.
 * Quando há as duas fontes para a mesma semana, o snapshot vence: ele é o
 * registro imutável do Top 5 que foi efetivamente fechado/publicado.
 */
function buildHistoryByWeek(manualRows = [], snapshotRows = [], excludeWeekId = null) {
  const byWeek = new Map();
  const group = rows => {
    for (const row of rows || []) {
      const weekId = String(row.week_id || row.weekId || '');
      if (!weekId || weekId === excludeWeekId) continue;
      if (!byWeek.has(weekId)) byWeek.set(weekId, []);
      byWeek.get(weekId).push(row);
    }
  };

  group(manualRows);
  // Snapshots são aplicados por último e substituem a semana inteira.
  const snapshotWeeks = new Set((snapshotRows || []).map(r => String(r.week_id || r.weekId || '')).filter(Boolean));
  for (const weekId of snapshotWeeks) byWeek.delete(weekId);
  group(snapshotRows);

  for (const [weekId, rows] of byWeek) {
    rows.sort((a, b) => Number(a.position) - Number(b.position));
    byWeek.set(weekId, rows.slice(0, 5));
  }
  return byWeek;
}

function historyTopMap(byWeek) {
  return new Map([...byWeek].map(([weekId, rows]) => [
    weekId,
    rows.slice().sort((a, b) => Number(a.position) - Number(b.position)).map(r => String(r.user_id ?? r.userId))
  ]));
}

function hasConsecutiveWeeks(byWeek, weekId, count) {
  for (let n = 1; n <= count; n++) {
    if (!byWeek.has(shiftWeekId(weekId, -n))) return false;
  }
  return true;
}

module.exports = { buildHistoryByWeek, historyTopMap, hasConsecutiveWeeks };
