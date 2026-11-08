const DAY_KEYS = Object.freeze(['domingo','segunda','terca','quarta','quinta','sexta','sabado']);

function cleanList(value, limit = 12) {
  if (Array.isArray(value)) value = value.join(',');
  return String(value || '').split(/[,;\n]+/).map(item => item.trim()).filter(Boolean).slice(0, limit);
}
function normalizeText(value, max = 120) { return String(value || '').trim().slice(0, max); }

function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return {};
  const result = {};
  for (const day of DAY_KEYS) {
    const value = schedule[day];
    if (Array.isArray(value)) {
      const slots = value.map(v => String(v).trim()).filter(Boolean).slice(0, 6);
      if (slots.length) result[day] = [...new Set(slots)];
    } else if (String(value || '').trim()) {
      // Compatibilidade com a Fase 1 anterior, que salvava texto por dia.
      result[day] = [String(value).trim().slice(0, 120)];
    }
  }
  return result;
}

function parseScheduleText(text) {
  const aliases = {
    domingo: 'domingo', dom: 'domingo',
    segunda: 'segunda', 'segunda-feira': 'segunda', seg: 'segunda',
    terca: 'terca', 'terça': 'terca', 'terça-feira': 'terca', ter: 'terca',
    quarta: 'quarta', 'quarta-feira': 'quarta', qua: 'quarta',
    quinta: 'quinta', 'quinta-feira': 'quinta', qui: 'quinta',
    sexta: 'sexta', 'sexta-feira': 'sexta', sex: 'sexta',
    sabado: 'sabado', sábado: 'sabado', sab: 'sabado'
  };
  const result = {};
  for (const rawLine of String(text || '').split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^:=-]+)\s*[:=-]\s*(.+)$/);
    if (!match) continue;
    const key = aliases[match[1].trim().toLowerCase()];
    if (key) result[key] = [normalizeText(match[2], 120)];
  }
  return result;
}

function scheduleToText(schedule) {
  const labels = { domingo: 'Domingo', segunda: 'Segunda', terca: 'Terça', quarta: 'Quarta', quinta: 'Quinta', sexta: 'Sexta', sabado: 'Sábado' };
  return DAY_KEYS.filter(day => schedule?.[day]?.length).map(day => `${labels[day]}: ${schedule[day].join(', ')}`).join('\n');
}

function normalizeProfile(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    currentRank: row.current_rank || '',
    peakRank: row.peak_rank || '',
    heroes: Array.isArray(row.heroes) ? row.heroes : [],
    routes: Array.isArray(row.routes) ? row.routes : [],
    modes: Array.isArray(row.modes) ? row.modes : [],
    groupSize: row.group_size || 'duo',
    schedule: normalizeSchedule(row.schedule),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isComplete(profile) {
  return Boolean(profile && profile.currentRank && profile.peakRank && profile.heroes.length && profile.routes.length && profile.modes.length && profile.groupSize && Object.keys(profile.schedule).length);
}

module.exports = { DAY_KEYS, cleanList, normalizeText, normalizeSchedule, parseScheduleText, scheduleToText, normalizeProfile, isComplete };
