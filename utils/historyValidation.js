const db = require('./db');
const { shiftWeekId } = require('./week');

function pct(a, b) {
  if (!b || b <= 0) return null;
  return ((a - b) / b) * 100;
}

function sameNumber(a, b, epsilon = 0.0001) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

async function validateHistoricalRankings(guildId) {
  const { rows } = await db.getPool().query(`
    SELECT guild_id, week_id, user_id, position, messages, points,
           first_message_at, streak, total_appearances, growth_percent, is_returner
    FROM minako_weekly_rankings
    WHERE guild_id=$1
    ORDER BY week_id ASC, position ASC`, [guildId]);

  const byWeek = new Map();
  for (const row of rows) {
    if (!byWeek.has(row.week_id)) byWeek.set(row.week_id, []);
    byWeek.get(row.week_id).push(row);
  }

  const weeks = [...byWeek.keys()].sort();
  const knownWeeks = new Set(weeks);
  const anomalies = [];
  const warnings = [];

  for (const weekId of weeks) {
    const weekRows = byWeek.get(weekId);
    const positions = weekRows.map(r => Number(r.position));
    const positionSet = new Set(positions);

    if (weekRows.length !== 5) {
      anomalies.push({
        type: 'week_size', weekId,
        message: `A semana possui ${weekRows.length} registros; esperado: 5.`,
        userIds: weekRows.map(r => r.user_id)
      });
    }

    if (positionSet.size !== positions.length || ![1,2,3,4,5].every(p => positionSet.has(p))) {
      anomalies.push({
        type: 'positions', weekId,
        message: 'As posições armazenadas não formam exatamente 1, 2, 3, 4 e 5.',
        positions
      });
    }

    for (const row of weekRows) {
      if (Number(row.messages) <= 0) {
        anomalies.push({ type: 'invalid_messages', weekId, userId: row.user_id, message: 'Quantidade de mensagens não é positiva.' });
      }
      if (Number(row.points) !== Number(row.messages)) {
        anomalies.push({ type: 'points_mismatch', weekId, userId: row.user_id, points: Number(row.points), messages: Number(row.messages) });
      }
    }
  }

  for (let i = 1; i < weeks.length; i++) {
    const expected = shiftWeekId(weeks[i - 1], 1);
    if (weeks[i] !== expected) {
      warnings.push({
        type: 'week_gap',
        from: weeks[i - 1],
        to: weeks[i],
        message: `Existe uma lacuna entre ${weeks[i - 1]} e ${weeks[i]}. Indicadores que dependem de semanas consecutivas não podem ser validados atravessando essa lacuna.`
      });
    }
  }

  const topByWeek = new Map(weeks.map(w => [w, byWeek.get(w)]));
  const users = new Set(rows.map(r => r.user_id));
  const indicatorMismatches = [];

  for (const row of rows) {
    const previousWeek = shiftWeekId(row.week_id, -1);
    const previousRows = topByWeek.get(previousWeek) || [];
    const previous = previousRows.find(r => r.user_id === row.user_id) || null;

    // If the immediately previous week is absent from the imported history,
    // we cannot prove a streak/return/growth relationship across that gap.
    const contiguousPreviousKnown = knownWeeks.has(previousWeek);

    let expectedTotal = 0;
    for (const wk of weeks) {
      if ((topByWeek.get(wk) || []).some(r => r.user_id === row.user_id)) expectedTotal++;
    }

    let expectedStreak = 1;
    let streakValidationPossible = true;
    for (let n = 1; n < 1000; n++) {
      const wk = shiftWeekId(row.week_id, -n);
      if (!knownWeeks.has(wk)) {
        streakValidationPossible = false;
        break;
      }
      if (!(topByWeek.get(wk) || []).some(r => r.user_id === row.user_id)) break;
      expectedStreak++;
    }

    let expectedGrowth = null;
    if (contiguousPreviousKnown && previous && Number(previous.messages) > 0) {
      expectedGrowth = pct(Number(row.messages), Number(previous.messages));
    }

    const hasPriorAppearance = weeks.some(wk => wk < row.week_id && (topByWeek.get(wk) || []).some(r => r.user_id === row.user_id));
    let expectedReturner = false;
    if (hasPriorAppearance && !previous && contiguousPreviousKnown) {
      expectedReturner = true;
      for (let n = 1; n <= 4; n++) {
        const wk = shiftWeekId(row.week_id, -n);
        if (!knownWeeks.has(wk) || (topByWeek.get(wk) || []).some(r => r.user_id === row.user_id)) {
          expectedReturner = false;
          break;
        }
      }
    }

    if (Number(row.total_appearances) !== expectedTotal) {
      indicatorMismatches.push({
        type: 'total_appearances', weekId: row.week_id, userId: row.user_id,
        stored: Number(row.total_appearances), expected: expectedTotal
      });
    }

    if (streakValidationPossible && Number(row.streak) !== expectedStreak) {
      indicatorMismatches.push({
        type: 'streak', weekId: row.week_id, userId: row.user_id,
        stored: Number(row.streak), expected: expectedStreak
      });
    }

    if (contiguousPreviousKnown && !sameNumber(row.growth_percent == null ? null : Number(row.growth_percent), expectedGrowth)) {
      indicatorMismatches.push({
        type: 'growth_percent', weekId: row.week_id, userId: row.user_id,
        stored: row.growth_percent == null ? null : Number(row.growth_percent),
        expected: expectedGrowth
      });
    }

    if (contiguousPreviousKnown && Boolean(row.is_returner) !== expectedReturner) {
      indicatorMismatches.push({
        type: 'is_returner', weekId: row.week_id, userId: row.user_id,
        stored: Boolean(row.is_returner), expected: expectedReturner
      });
    }
  }

  // A user should not appear twice in the same weekly Top 5. The PK already
  // prevents exact duplicates, but this explicitly validates the imported set.
  for (const weekId of weeks) {
    const counts = new Map();
    for (const row of byWeek.get(weekId)) counts.set(row.user_id, (counts.get(row.user_id) || 0) + 1);
    for (const [userId, count] of counts) {
      if (count > 1) anomalies.push({ type: 'duplicate_user', weekId, userId, count });
    }
  }

  return {
    guildId,
    status: anomalies.length || indicatorMismatches.length ? 'ATTENTION' : 'OK',
    summary: {
      editions: weeks.length,
      rows: rows.length,
      expectedRowsIfEveryEditionHasTop5: weeks.length * 5,
      anomalies: anomalies.length,
      indicatorMismatches: indicatorMismatches.length,
      warnings: warnings.length,
      distinctUsers: users.size,
      firstWeek: weeks[0] || null,
      lastWeek: weeks.at(-1) || null
    },
    anomalies,
    indicatorMismatches,
    warnings
  };
}

module.exports = { validateHistoricalRankings };
