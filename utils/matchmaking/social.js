'use strict';
// Regras PURAS de favoritos e parcerias recorrentes. Sem Discord, sem banco, sem relógio global.
// Princípios do briefing (2.15): favoritos são PRIVADOS e unilaterais (nunca revelados a quem foi favoritado);
// parcerias só existem com interesse MÚTUO; qualquer parte encerra sem penalidade; notificações independentes.
const policy = require('./notifyPolicy');
const LIMITS = Object.freeze({
  maxFavorites: 25, maxPartners: 10, maxPendingOut: 5,
  inviteTtlMs: 7 * 86400_000, reinviteCooldownMs: 7 * 86400_000,
  watchCooldownMs: 6 * 3600_000, watchDailyCap: 5,   // limites de frequência das notificações de disponibilidade
});

const pair = (a, b) => (String(a) < String(b) ? [String(a), String(b)] : [String(b), String(a)]);
const pairKey = (a, b) => pair(a, b).join('|');
const other = (p, me) => (p.userA === me ? p.userB : p.userA);

// Pode `inviter` convidar `target` para uma parceria? ctx vem do banco (dados brutos), a decisão é pura.
//   ctx: { targetIsBot, activePartners:[ids do inviter], targetActiveCount, pendingOutCount, existing: {status, at, inviterId}|null, lastClosed: {status, at}|null, reversePending: bool }
function canInvite(inviterId, targetId, ctx, now) {
  if (String(inviterId) === String(targetId)) return { ok: false, code: 'SELF' };
  if (ctx.targetIsBot) return { ok: false, code: 'BOT' };
  if (ctx.existing?.status === 'active') return { ok: false, code: 'ALREADY_PARTNERS' };
  if (ctx.reversePending) return { ok: true, auto: true };                       // o outro já tinha convidado: interesse mútuo, aceita sozinho
  if (ctx.existing?.status === 'pending') return { ok: false, code: 'ALREADY_INVITED' };
  if (ctx.activePartners.length >= LIMITS.maxPartners) return { ok: false, code: 'MY_LIMIT' };
  if (ctx.targetActiveCount >= LIMITS.maxPartners) return { ok: false, code: 'TARGET_LIMIT' };
  if (ctx.pendingOutCount >= LIMITS.maxPendingOut) return { ok: false, code: 'TOO_MANY_PENDING' };
  // Não repetir o mesmo convite sem que algo mude: recusado/expirado só pode ser refeito após o intervalo.
  if (ctx.lastClosed && ['declined', 'expired'].includes(ctx.lastClosed.status) && now - ctx.lastClosed.at < LIMITS.reinviteCooldownMs) return { ok: false, code: 'COOLDOWN' };
  return { ok: true, auto: false };
}

// Favoritos: privados. Só valida limite e duplicata; nada aqui expõe quem favoritou quem.
function canFavorite(userId, targetId, { count, isBot, already }) {
  if (String(userId) === String(targetId)) return { ok: false, code: 'SELF' };
  if (isBot) return { ok: false, code: 'BOT' };
  if (already) return { ok: false, code: 'ALREADY' };
  if (count >= LIMITS.maxFavorites) return { ok: false, code: 'LIMIT' };
  return { ok: true };
}

// Quem deve ser AVISADO de que `subjectId` ficou disponível. Decisão de privacidade e de frequência em um só lugar.
//   visibility: escolha do próprio sujeito. 'none' => ninguém; 'partners' => só parceiros; 'favorites' => parceiros + quem o favoritou
//               (o sujeito NÃO descobre quem o favoritou: a mensagem vai só ao favoritador).
//   prefsBy: { userId: { notif: {partners, favorites} } }   log: [{ recipient, subject, at }] (avisos recentes)
function selectWatchRecipients({ subjectId, visibility, partners, favoriters, prefsBy, log, now }) {
  if (visibility === 'none') return [];
  const subject = String(subjectId);
  const wanted = new Map();                                      // userId -> categoria ('partners' vence 'favorites')
  for (const id of partners) wanted.set(String(id), 'partners');
  if (visibility === 'favorites') for (const id of favoriters) if (!wanted.has(String(id))) wanted.set(String(id), 'favorites');
  const out = [];
  for (const [userId, category] of wanted) {
    if (userId === subject) continue;
    if (prefsBy[userId]?.notif?.[category] !== 'dm') continue;    // opt-in independente por categoria
    if (!policy.engagementAllowed(prefsBy[userId], now).ok) continue; // pausa geral e horário silencioso
    const mine = log.filter(l => String(l.recipient) === userId);
    if (mine.some(l => String(l.subject) === subject && now - l.at < LIMITS.watchCooldownMs)) continue;   // não repetir o mesmo aviso
    if (mine.filter(l => now - l.at < 86400_000).length + out.filter(o => o.userId === userId).length >= LIMITS.watchDailyCap) continue; // teto diário
    out.push({ userId, category });
  }
  return out;
}

const INVITE_ERRORS = Object.freeze({
  SELF: 'Você não pode convidar a si mesmo.', BOT: 'Bots não podem ser parceiros.', ALREADY_PARTNERS: 'Vocês já são parceiros.',
  ALREADY_INVITED: 'Você já convidou essa pessoa e o convite ainda está aberto.', MY_LIMIT: `Você já tem ${LIMITS.maxPartners} parceiros. Encerre uma parceria para convidar outra pessoa.`,
  TARGET_LIMIT: 'Essa pessoa já atingiu o limite de parcerias.', TOO_MANY_PENDING: `Você já tem ${LIMITS.maxPendingOut} convites abertos. Aguarde as respostas.`,
  COOLDOWN: 'Esse convite foi recusado ou expirou há pouco. Para não incomodar, espere alguns dias para tentar de novo.',
});
const FAVORITE_ERRORS = Object.freeze({ SELF: 'Você não pode favoritar a si mesmo.', BOT: 'Bots não podem ser favoritados.', ALREADY: 'Essa pessoa já está nos seus favoritos.', LIMIT: `Você atingiu o limite de ${LIMITS.maxFavorites} favoritos.` });

module.exports = { LIMITS, pair, pairKey, other, canInvite, canFavorite, selectWatchRecipients, INVITE_ERRORS, FAVORITE_ERRORS };
