const db = require('./db');
const { shiftWeekId } = require('./week');

function normalizeWeekId(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('A semana deve estar no formato YYYY-MM-DD.');
  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error('A data informada não é válida.');
  return text;
}

function isConfiguredWeekStart(weekId, config) {
  const date = new Date(`${weekId}T12:00:00Z`);
  return date.getUTCDay() === Number(config.weekStartDay);
}

function recalculate(rows) {
  const weeks = [...new Set(rows.map(r => r.week_id))].sort();
  const byWeek = new Map();
  for (const week of weeks) byWeek.set(week, rows.filter(r => r.week_id === week));

  const appearances = new Map();
  const currentStreak = new Map();
  const maxStreak = new Map();
  const previousRow = new Map();
  const metrics = [];

  for (const weekId of weeks) {
    const weekRows = byWeek.get(weekId);
    const prevWeek = shiftWeekId(weekId, -1);
    const prevRows = byWeek.get(prevWeek) || [];
    const prevByUser = new Map(prevRows.map(r => [r.user_id, r]));

    for (const row of weekRows) {
      const userId = row.user_id;
      const total = (appearances.get(userId) || 0) + 1;
      const prev = prevByUser.get(userId);
      const streak = prev ? (currentStreak.get(userId) || 1) + 1 : 1;
      const max = Math.max(maxStreak.get(userId) || 1, streak);
      const growth = prev && Number(prev.messages) > 0
        ? ((Number(row.messages) - Number(prev.messages)) / Number(prev.messages)) * 100
        : null;

      appearances.set(userId, total);
      currentStreak.set(userId, streak);
      maxStreak.set(userId, max);
      previousRow.set(userId, row);

      metrics.push({
        weekId,
        userId,
        streak,
        maxStreak: max,
        totalAppearances: total,
        growthPercent: growth === null ? null : Number(growth.toFixed(2))
      });
    }
  }

  return { metrics, appearances, maxStreak };
}

async function registerManualWeek(guildId, weekId, rows) {
  await db.upsertManualWeeklyRanking(guildId, weekId, rows);
  const allRows = await db.loadManualHistoryRankings(guildId);
  const recalculated = recalculate(allRows);
  await db.updateManualHistoryMetrics(guildId, recalculated.metrics);

  const selected = new Map(recalculated.metrics.filter(m => m.weekId === weekId).map(m => [m.userId, m]));
  return rows.map(row => ({
    ...row,
    totalAppearances: selected.get(row.userId)?.totalAppearances || 1,
    maxStreak: selected.get(row.userId)?.maxStreak || 1,
    streak: selected.get(row.userId)?.streak || 1
  }));
}

module.exports = { normalizeWeekId, isConfiguredWeekStart, recalculate, registerManualWeek };
