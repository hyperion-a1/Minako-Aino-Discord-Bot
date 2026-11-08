const { EMOJIS } = require('./minakoEmojis');

const LANES = ['Rota Superior', 'Selva', 'Rota do Meio', 'Apoio', 'Rota Inferior'];
const LANE_EMOJI = {
  'Rota Superior': EMOJIS.rotaSuperior,
  Selva: EMOJIS.caca,
  'Rota do Meio': EMOJIS.rotaMeio,
  Apoio: EMOJIS.apoio,
  'Rota Inferior': EMOJIS.rotaInferior,
};
const TEAM_KEYS = ['blue', 'red'];
const TEAM_NAMES = { blue: 'Time Azul', red: 'Time Vermelho' };
const TEAM_EMOJI_TAG = {
  blue: EMOJIS.arcoAzul,
  red: EMOJIS.arcoVermelho,
};
const VERSATILE_VALUE = '__versatil__';

function parseCustomEmojiTag(tag) {
  const match = tag?.match(/^<(a)?:(\w+):(\d+)>$/);
  if (!match) return null;
  const [, animated, name, id] = match;
  return { id, name, animated: Boolean(animated) };
}

const TEAM_EMOJI_OBJ = {
  blue: parseCustomEmojiTag(TEAM_EMOJI_TAG.blue),
  red: parseCustomEmojiTag(TEAM_EMOJI_TAG.red),
};
const LANE_EMOJI_OBJ = Object.fromEntries(
  LANES.map((lane) => [lane, parseCustomEmojiTag(LANE_EMOJI[lane])])
);

function getOccupancy(match) {
  const occ = { blue: {}, red: {} };
  for (const team of TEAM_KEYS) for (const lane of LANES) occ[team][lane] = null;
  for (const [userId, p] of Object.entries(match.players)) {
    if (p.allocated) occ[p.allocated.team][p.allocated.lane] = userId;
  }
  return occ;
}

function countTeamAllocated(match, team) {
  return Object.values(match.players).filter((p) => p.allocated?.team === team).length;
}

function countAllocated(match) {
  return Object.values(match.players).filter((p) => p.allocated).length;
}

function getUnallocated(match) {
  return Object.entries(match.players)
    .filter(([, p]) => !p.allocated)
    .map(([userId]) => userId);
}

function pickTeamOrder(match) {
  const counts = { blue: countTeamAllocated(match, 'blue'), red: countTeamAllocated(match, 'red') };
  if (counts.blue === counts.red) return Math.random() < 0.5 ? ['blue', 'red'] : ['red', 'blue'];
  return [...TEAM_KEYS].sort((a, b) => counts[a] - counts[b]);
}

function acceptableSlotsInOrder(match, player) {
  const lanes = player.versatile ? LANES : player.lanes;
  const slots = [];
  for (const lane of lanes) {
    for (const team of pickTeamOrder(match)) slots.push({ team, lane });
  }
  return slots;
}

function tryAssign(match, userId, visited) {
  const player = match.players[userId];
  if (!player) return false;

  for (const slot of acceptableSlotsInOrder(match, player)) {
    const key = `${slot.team}:${slot.lane}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const occ = getOccupancy(match);
    const occupantId = occ[slot.team][slot.lane];
    if (!occupantId) {
      player.allocated = slot;
      return true;
    }
    if (occupantId === userId) continue;
    if (tryAssign(match, occupantId, visited)) {
      player.allocated = slot;
      return true;
    }
  }
  return false;
}

function tryAllocatePlayer(match, userId) {
  const player = match.players[userId];
  if (!player) return false;
  if (player.allocated) return true;
  return tryAssign(match, userId, new Set());
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function backfillWaitlist(match) {
  const waiting = Object.entries(match.players).filter(([, p]) => !p.allocated);
  for (const [userId] of waiting) tryAllocatePlayer(match, userId);
}

function shuffleAllocate(match) {
  for (const p of Object.values(match.players)) p.allocated = null;
  const entries = Object.entries(match.players);
  const nonVersatile = shuffle(entries.filter(([, p]) => !p.versatile));
  const versatile = shuffle(entries.filter(([, p]) => p.versatile));
  for (const [userId] of nonVersatile) tryAllocatePlayer(match, userId);
  for (const [userId] of versatile) tryAllocatePlayer(match, userId);
  const unallocated = entries.filter(([, p]) => !p.allocated).map(([userId]) => userId);
  return { unallocated };
}

module.exports = {
  LANES,
  LANE_EMOJI,
  LANE_EMOJI_OBJ,
  TEAM_KEYS,
  TEAM_NAMES,
  TEAM_EMOJI_TAG,
  TEAM_EMOJI_OBJ,
  VERSATILE_VALUE,
  getOccupancy,
  countAllocated,
  getUnallocated,
  tryAllocatePlayer,
  backfillWaitlist,
  shuffleAllocate,
};
