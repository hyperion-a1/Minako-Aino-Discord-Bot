function partsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function zonedDateKey(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return { year:+p.year, month:+p.month, day:+p.day, hour:+p.hour, minute:+p.minute, second:+p.second };
}
function dateOnlyUtc(year, month, day) { return new Date(Date.UTC(year, month-1, day)); }
function weekStartFor(date) {
  // A coleta da Ami é fixa: segunda-feira 00:00 em America/Sao_Paulo.
  const p = zonedDateKey(date, 'America/Sao_Paulo');
  const d = dateOnlyUtc(p.year, p.month, p.day);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d;
}
function weekIdFor(date) {
  const d = weekStartFor(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function shiftWeekId(weekId, delta) {
  const d = new Date(`${weekId}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+delta*7);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function weekLabel(weekId, timeZone='America/Sao_Paulo') {
  const d = new Date(`${weekId}T12:00:00Z`);
  return new Intl.DateTimeFormat('pt-BR',{timeZone,day:'2-digit',month:'2-digit',year:'numeric'}).format(d);
}
module.exports = { partsInZone, zonedDateKey, weekStartFor, weekIdFor, shiftWeekId, weekLabel };
