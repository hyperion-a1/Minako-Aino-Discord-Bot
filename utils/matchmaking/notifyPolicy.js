'use strict';
// Política de notificações (briefing 2.16). PURA: sem Discord, sem banco, sem relógio global.
//  - OPERACIONAIS (propostas, pedidos, decisões, lembrete de expiração): ligadas a uma ação que a pessoa iniciou; chegam
//    mesmo em pausa/horário silencioso (o usuário só escolhe o destino ou "não avisar").
//  - ENGAJAMENTO (parceiros/favoritos disponíveis, atividade da comunidade, resumos): opt-in, respeitam pausa geral,
//    horário silencioso, limites de frequência e são agrupadas quando parecidas.
const TZ = 'America/Sao_Paulo';
const KIND = Object.freeze({ actions: 'operational', groups: 'operational', expiry: 'operational', partners: 'engagement', favorites: 'engagement', community: 'engagement', digest: 'engagement' });
const isEngagement = (category) => KIND[category] === 'engagement';
const LIMITS = Object.freeze({
  dailyCap: 5,                    // máximo de avisos de engajamento por pessoa a cada 24 h (todas as categorias)
  categoryCooldownMs: 6 * 3600_000,
  groupWindowMs: 45_000,          // avisos parecidos nessa janela viram UMA mensagem
  staleMs: 15 * 60_000,           // aviso de disponibilidade que ficou velho é descartado, não entregue atrasado
  communityMaxRecipients: 40,
});
const DIGEST = Object.freeze({ hour: 19, weeklyDay: 5 });   // 19h; semanal = sexta (fuso do servidor)

function localParts(now, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const o = Object.fromEntries(f.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { hour: Number(o.hour), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday), dateKey: `${o.year}-${o.month}-${o.day}` };
}
// Horário silencioso pode atravessar a meia-noite (ex.: 22 → 8).
function inQuiet(quiet, hour) {
  if (!quiet) return false;
  return quiet.from < quiet.to ? hour >= quiet.from && hour < quiet.to : hour >= quiet.from || hour < quiet.to;
}
const isPaused = (prefs, now) => Boolean(prefs?.pausedUntil && prefs.pausedUntil > now);
// Decisão única para qualquer aviso de ENGAJAMENTO (a escolha de destino/“não avisar” é checada à parte).
function engagementAllowed(prefs, now) {
  if (isPaused(prefs, now)) return { ok: false, reason: 'paused' };
  if (inQuiet(prefs?.quiet, localParts(now).hour)) return { ok: false, reason: 'quiet' };
  return { ok: true };
}

// ---- Resumo periódico de oportunidades ----
// lastAt: ms do último resumo enviado (ou null). Diário: depois das 19h, uma vez por dia. Semanal: sextas, depois das 19h.
function digestDue(prefs, lastAt, now) {
  const cadence = prefs?.notif?.digest;
  if (!['daily', 'weekly'].includes(cadence)) return false;
  if (!engagementAllowed(prefs, now).ok) return false;
  const p = localParts(now);
  if (p.hour < DIGEST.hour) return false;
  if (cadence === 'weekly' && p.weekday !== DIGEST.weeklyDay) return false;
  return !(lastAt && localParts(lastAt).dateKey === p.dateKey);
}
// Nunca envia resumo vazio.
function buildDigest({ availableNow, groups }) {
  if (!groups.length && availableNow < 2) return null;
  const lines = ['## 📬 Resumo de oportunidades'];
  lines.push(`**Disponíveis agora:** ${availableNow} · **Grupos com vaga:** ${groups.length}`);
  for (const g of groups.slice(0, 3)) lines.push(`• ${g.mode} — ${g.confirmed}/${g.capacity} (${g.free} vaga${g.free === 1 ? '' : 's'})`);
  if (groups.length > 3) lines.push(`• …e mais ${groups.length - 3} grupo(s)`);
  lines.push('', 'Use **Grupos abertos** ou **Quero jogar agora** na Central.');
  return lines.join('\n');
}

// ---- Alerta de atividade da comunidade ----
function communityAlertDue({ availableNow, min, lastAlertAt, cooldownSec, now }) {
  if (!min || min <= 0) return false;
  if (availableNow < min) return false;
  return !(lastAlertAt && now - lastAlertAt < cooldownSec * 1000);
}
// candidates: [{ userId, prefs }] · busy: Set de quem já está disponível/em grupo · log: [{ recipient, category, at }]
function selectCommunityRecipients({ candidates, busy, log, now, max = LIMITS.communityMaxRecipients }) {
  const out = [];
  for (const c of candidates) {
    if (out.length >= max) break;
    if (c.prefs?.notif?.community !== 'dm' || busy.has(String(c.userId))) continue;
    if (!engagementAllowed(c.prefs, now).ok) continue;
    const mine = log.filter(l => String(l.recipient) === String(c.userId));
    if (mine.some(l => l.category === 'community' && now - l.at < LIMITS.categoryCooldownMs)) continue;
    if (mine.filter(l => now - l.at < 86400_000).length >= LIMITS.dailyCap) continue;
    out.push(String(c.userId));
  }
  return out;
}

// ---- Agrupamento de avisos parecidos (ex.: vários parceiros ficaram disponíveis quase juntos) ----
// items: [{ category, subjectId, at }]  -> uma lista por categoria, sem repetir pessoa, só os recentes.
function groupItems(items, now) {
  const fresh = items.filter(i => now - i.at <= LIMITS.staleMs);
  const by = new Map();
  for (const i of fresh) { if (!by.has(i.category)) by.set(i.category, new Set()); by.get(i.category).add(String(i.subjectId)); }
  return [...by].map(([category, set]) => ({ category, subjects: [...set] }));
}
function groupedText(category, subjects, modeLabel = null) {
  const who = subjects.slice(0, 5).map(id => `<@${id}>`).join(', ') + (subjects.length > 5 ? ` e mais ${subjects.length - 5}` : '');
  const mode = modeLabel ? ` (${modeLabel})` : '';
  if (category === 'partners') return subjects.length === 1 ? `🟢 Seu parceiro ${who} ficou disponível para jogar${mode}.` : `🟢 **${subjects.length} parceiros** ficaram disponíveis para jogar: ${who}.`;
  return subjects.length === 1 ? `🟢 ${who} ficou disponível para jogar${mode}.` : `🟢 **${subjects.length} favoritos** ficaram disponíveis para jogar: ${who}.`;
}

module.exports = { TZ, KIND, isEngagement, LIMITS, DIGEST, localParts, inQuiet, isPaused, engagementAllowed, digestDue, buildDigest, communityAlertDue, selectCommunityRecipients, groupItems, groupedText };
