const { PHRASES } = require('./phraseBank');
const { isSeasonalPackageEnabled } = require('./seasonal');
const db = require('../db');

function weekKey(date = new Date(), timeZone = 'America/Sao_Paulo') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', weekday:'short' }).formatToParts(date).map(p => [p.type, p.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const dayNumber = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function availablePhrases(event, config) {
  return PHRASES.filter(p => p.event === event && (!p.seasonalPackage || isSeasonalPackageEnabled(config, p.seasonalPackage)));
}

async function choosePhrase(guildId, event, config, now = new Date()) {
  const candidates = availablePhrases(event, config);
  if (!candidates.length) throw new Error(`Nenhuma fala disponível para o evento ${event}.`);
  const key = weekKey(now, config?.timezone || 'America/Sao_Paulo');
  const state = await db.loadPersonalityState(guildId);
  const used = state?.weekId === key && Array.isArray(state.usedPhraseIds) ? state.usedPhraseIds : [];
  const eligible = candidates.filter(p => !used.includes(p.id));
  const pool = eligible.length ? eligible : candidates.filter(p => p.id !== state?.lastPhraseId);
  const source = pool.length ? pool : candidates;
  const phrase = source[Math.floor(Math.random() * source.length)];
  const nextUsed = [...new Set([...used, phrase.id])];
  await db.savePersonalityState(guildId, { weekId:key, usedPhraseIds:nextUsed, lastPhraseId:phrase.id });
  return phrase;
}

async function pickRecentNickname(guild, channelIds = []) {
  const members = [];
  const seen = new Set();
  for (const channelId of [...new Set(channelIds)]) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) continue;
    if (!channel.messages?.fetch) continue;
    const messages = await channel.messages.fetch({ limit: 15 }).catch(() => null);
    if (!messages) continue;
    for (const message of messages.values()) {
      const member = message.member;
      if (!member || member.user?.bot || seen.has(member.id)) continue;
      seen.add(member.id);
      const nickname = String(member.nickname || member.user?.globalName || member.user?.username || '').trim();
      if (nickname) members.push(nickname);
    }
  }
  return members.length ? members[Math.floor(Math.random() * members.length)] : null;
}

async function renderPhrase(guild, config, event, now = new Date(), channelIds = []) {
  const phrase = await choosePhrase(guild.id, event, config, now);
  let text = phrase.text;
  if (phrase.usesNickname) {
    const nickname = await pickRecentNickname(guild, channelIds);
    if (nickname) text = text.replaceAll('{apelido}', nickname);
    else text = text.replaceAll('{apelido}', 'você');
  }
  return { ...phrase, text };
}

module.exports = { weekKey, availablePhrases, choosePhrase, pickRecentNickname, renderPhrase };
