const TIMEZONE = 'America/Sao_Paulo';
function parseTime(value) {
  const m = /^(?:([01]\d|2[0-3]):([0-5]\d))$/.exec(String(value || ''));
  if (!m) throw new Error(`Horário inválido: ${value}. Use HH:MM.`);
  return Number(m[1]) * 60 + Number(m[2]);
}
function zoneParts(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function localKey(p) { return `${p.year}-${p.month}-${p.day}`; }
function localMinute(p) { return Number(p.hour) * 60 + Number(p.minute); }
function isNightMinute(minute, start, end) { if (start === end) return false; return start < end ? minute >= start && minute < end : minute >= start || minute < end; }
function eventForNow(date, config) {
  const start = parseTime(config.nightModeStartTime), end = parseTime(config.nightModeEndTime);
  const p = zoneParts(date, config.timezone || TIMEZONE), minute = localMinute(p);
  return { start, end, active:isNightMinute(minute,start,end), startWarning:((minute-start+1440)%1440)===1410, endWarning:((minute-end+1440)%1440)===1410, overnight:start>end, localDate:localKey(p), minute, parts:p };
}
function validateNightConfig(config) {
  if (!config.nightModeEnabled) return { ok:true };
  const timezone = String(config.timezone || TIMEZONE);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
  catch { throw new Error(`O fuso horário configurado (${timezone}) é inválido.`); }
  const start=parseTime(config.nightModeStartTime), end=parseTime(config.nightModeEndTime);
  if (start===end) throw new Error('O horário de início e o horário de fim do Modo Noturno não podem ser iguais.');
  const categories = Array.isArray(config.nightModeCategoryIds) ? config.nightModeCategoryIds.filter(Boolean) : [];
  const affected = Array.isArray(config.nightModeAffectedChannelIds) ? config.nightModeAffectedChannelIds.filter(Boolean) : [];
  const immune = Array.isArray(config.nightModeImmuneChannelIds) ? config.nightModeImmuneChannelIds.filter(Boolean) : [];
  if (!categories.length && !affected.length) throw new Error('Escolha pelo menos uma categoria ou um canal para o Modo Noturno afetar.');
  if (!Array.isArray(config.nightModeNoticeChannelIds) || config.nightModeNoticeChannelIds.length < 1) throw new Error('Escolha pelo menos um canal para receber os comunicados do Modo Noturno.');
  if (!/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(String(config.nightModeNoticeUrl||''))) throw new Error('O link do aviso principal precisa ser um link de mensagem do Discord válido.');
  return {ok:true,start,end,categoryIds:categories,affectedChannelIds:affected,immuneChannelIds:immune};
}
module.exports={TIMEZONE,parseTime,zoneParts,localKey,localMinute,isNightMinute,eventForNow,validateNightConfig};
