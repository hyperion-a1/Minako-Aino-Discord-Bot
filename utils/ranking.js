const db = require('./db');
const { shiftWeekId } = require('./week');
const { buildHistoryByWeek, historyTopMap } = require('./rankingHistory');

function visibleStats(row, excludedChannels) {
  const excluded = new Set((excludedChannels || []).map(String));
  let hidden = 0;
  const channels = row.channels && typeof row.channels === 'object' ? row.channels : {};
  for (const [id, count] of Object.entries(channels)) {
    if (excluded.has(String(id))) hidden += Number(count) || 0;
  }
  const messages = Math.max(0, (Number(row.messages) || 0) - hidden);
  return { messages, points: messages };
}

async function fetchMembers(guild, ids) {
  const map = new Map();
  for (const id of ids) {
    try { map.set(id, await guild.members.fetch({ user: id, force: true })); } catch {}
  }
  return map;
}

function compare(a, b) {
  if (b.messages !== a.messages) return b.messages - a.messages;
  const at = a.firstMessageAt ? Date.parse(a.firstMessageAt) : Infinity;
  const bt = b.firstMessageAt ? Date.parse(b.firstMessageAt) : Infinity;
  if (at !== bt) return at - bt;
  return a.userId.localeCompare(b.userId);
}

async function buildRanking(guild, weekId, options = {}) {
  const snapshotRows = options.ignoreSnapshot ? [] : await db.loadActivitySnapshot(guild.id, weekId);
  if (!options.ignoreSnapshot && snapshotRows.length === 5) {
    return snapshotRows.map(r => ({
      userId: r.user_id,
      messages: Number(r.messages) || 0,
      points: Number(r.points) || Number(r.messages) || 0,
      firstMessageAt: r.first_message_at ? new Date(r.first_message_at).toISOString() : null,
      sourceType: 'activity_snapshot',
      position: Number(r.position),
      previousPosition: r.previous_position === null || r.previous_position === undefined ? null : Number(r.previous_position),
      movement: r.movement || (r.is_returner ? 'return' : 'steady'),
      streak: Number(r.streak) || 1,
      maxStreak: Number(r.max_streak) || 1,
      totalAppearances: Number(r.total_appearances) || 1,
      growthPercent: r.growth_percent === null || r.growth_percent === undefined ? null : Number(r.growth_percent),
      isReturner: Boolean(r.is_returner)
    })).sort((a,b)=>a.position-b.position);
  }
  const [activityRows, manualRows, activityConfig, snapshotHistoryRows] = await Promise.all([
    db.listActivityWeeks(guild.id),
    db.loadManualHistoryRankings(guild.id),
    db.loadActivityConfig(guild.id),
    db.listActivitySnapshots(guild.id)
  ]);

  const excludedChannels = activityConfig.excluded_channel_ids || [];
  const excludedRoles = new Set((activityConfig.excluded_role_ids || []).map(String));
  const liveByWeek = new Map();
  for (const row of activityRows) {
    if (!liveByWeek.has(row.week_id)) liveByWeek.set(row.week_id, []);
    const visible = visibleStats(row, excludedChannels);
    if (visible.messages <= 0) continue;
    liveByWeek.get(row.week_id).push({
      userId: row.user_id,
      messages: visible.messages,
      points: visible.points,
      firstMessageAt: row.first_message_at ? new Date(row.first_message_at).toISOString() : null,
      sourceType: 'activity'
    });
  }

  const historicalByWeek = buildHistoryByWeek(manualRows, snapshotHistoryRows, weekId);
  const historicalTop = historyTopMap(historicalByWeek);
  const historicalWeeks = [...historicalByWeek.keys()].sort();
  const currentMembers = await fetchMembers(guild, (liveByWeek.get(weekId) || []).map(x => x.userId));
  const currentCandidates = (liveByWeek.get(weekId) || []).filter(x => {
    const member = currentMembers.get(x.userId);
    return member && !member.roles.cache.some(r => excludedRoles.has(String(r.id)));
  });
  currentCandidates.sort(compare);
  const currentTop = currentCandidates.slice(0, 5);

  const historyTop = new Map(historicalTop);
  historyTop.set(weekId, currentTop.map(x => x.userId));

  const knownWeeks = new Set([...historicalWeeks, weekId]);

  function wasTopInWeek(userId, wk) {
    return (historyTop.get(wk) || []).includes(String(userId));
  }

  function countCurrentStreak(userId) {
    let streak = 1;
    for (let n = 1; n < 1000; n++) {
      const wk = shiftWeekId(weekId, -n);
      if (!knownWeeks.has(wk)) break;
      if (!wasTopInWeek(userId, wk)) break;
      streak++;
    }
    return streak;
  }

  function countAppearances(userId) {
    let count = 0;
    for (const wk of knownWeeks) if (wasTopInWeek(userId, wk)) count++;
    return count;
  }

  function maxStreak(userId) {
    const weeks = [...knownWeeks].sort();
    let best = 0;
    let run = 0;
    let previous = null;
    for (const wk of weeks) {
      if (!wasTopInWeek(userId, wk)) {
        run = 0;
        previous = wk;
        continue;
      }
      if (previous && shiftWeekId(previous, 1) === wk) run++;
      else run = 1;
      best = Math.max(best, run);
      previous = wk;
    }
    return best || 1;
  }

  function getPreviousPosition(userId) {
    const previousTop = historyTop.get(shiftWeekId(weekId, -1)) || [];
    const index = previousTop.indexOf(userId);
    return index >= 0 ? index + 1 : null;
  }

  function hasPriorAppearance(userId) {
    return historicalWeeks.some(wk => wk < weekId && wasTopInWeek(userId, wk));
  }

  function spentFourFullWeeksOut(userId) {
    for (let n = 1; n <= 4; n++) {
      const wk = shiftWeekId(weekId, -n);
      if (!historicalByWeek.has(wk) || wasTopInWeek(userId, wk)) return false;
    }
    return true;
  }

  const previousWeek = shiftWeekId(weekId, -1);
  const previousRows = historicalByWeek.get(previousWeek) || [];

  return currentTop.map((entry, i) => {
    const position = i + 1;
    const previousPosition = getPreviousPosition(entry.userId);
    const previousRow = previousRows.find(x => String(x.user_id ?? x.userId) === String(entry.userId)) || null;
    const priorTop = hasPriorAppearance(entry.userId);
    const isReturner = priorTop && previousPosition === null && spentFourFullWeeksOut(entry.userId);
    const streak = countCurrentStreak(entry.userId);
    const totalAppearances = countAppearances(entry.userId);
    const previousMessages = previousRow ? Number(previousRow.messages) : 0;
    const growthPercent = previousPosition !== null && previousRow && previousMessages > 0
      ? ((entry.messages - previousMessages) / previousMessages) * 100
      : null;

    let movement = 'first';
    if (previousPosition !== null) {
      if (previousPosition > position) movement = 'up';
      else if (previousPosition < position) movement = 'down';
      else movement = 'steady';
    } else if (isReturner) movement = 'return';
    else if (priorTop) movement = 'steady';

    return {
      ...entry,
      position,
      previousPosition,
      movement,
      streak,
      maxStreak: maxStreak(entry.userId),
      totalAppearances,
      growthPercent,
      isReturner
    };
  });
}


async function captureActivitySnapshot(guild, weekId, snapshotAt = new Date()) {
  const existing = await db.loadActivitySnapshot(guild.id, weekId);
  if (existing.length === 5) return existing;
  const ranking = await buildRanking(guild, weekId, { ignoreSnapshot: true });
  if (ranking.length !== 5) throw new Error('Ainda não há cinco membros elegíveis para congelar o Top 5.');
  await db.createActivitySnapshot(guild.id, weekId, ranking, snapshotAt);
  return db.loadActivitySnapshot(guild.id, weekId);
}

module.exports = { buildRanking, captureActivitySnapshot };
