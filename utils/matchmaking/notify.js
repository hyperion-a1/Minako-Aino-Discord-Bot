'use strict';
// Entrega de notificações respeitando o destino escolhido por categoria e a política de engajamento.
// Regras do briefing: se o destino escolhido estiver indisponível, NUNCA usar outro canal sem autorização —
// registra o problema (visível em "Minhas preferências") e segue. Alterar notificações não mexe em disponibilidade.
// OPERACIONAIS chegam sempre que o destino permitir; ENGAJAMENTO também respeita pausa geral e horário silencioso.
const {
  ContainerBuilder, TextDisplayBuilder, MessageFlags,
} = require('discord.js');
const store = require('./store');
const estore = require('./engagementStore');
const core = require('./mmCore');
const policy = require('./notifyPolicy');

async function problem(guildId, userId, category, via, reason) {
  await store.recordDeliveryIssue(guildId, userId, category, via).catch(() => {});
  await store.logEvent(guildId, 'notify.delivery_failed', { userId, category, via, reason }).catch(() => {});
}
async function track(opts, guildId, userId, message) {
  if (!opts?.track || !message) return;
  try { await estore.trackOp(guildId, userId, opts.track.kind, opts.track.ref, message.channelId || message.channel?.id || '', message.id); } catch { /* rastrear nunca atrapalha a entrega */ }
}

// category: 'actions' | 'groups' | 'expiry' | 'partners' | 'favorites' | 'community' | 'digest'.
// opts.threadId: tópico do grupo (destino "tópico"). opts.track: { kind, ref } para encerrar a mensagem quando a ação for resolvida.
async function send(client, guildId, userId, category, payload, opts = {}) {
  const prefs = await store.getPrefs(guildId, userId);
  let dest = prefs.notif[category] ?? core.DEFAULT_PREFS.notif[category];
  if (['daily', 'weekly'].includes(dest)) dest = 'dm';                    // resumo: a cadência escolhe QUANDO; o destino é a mensagem privada
  if (dest === 'off') return { sent: false, reason: 'off' };
  if (policy.isEngagement(category)) { const ok = policy.engagementAllowed(prefs, Date.now()); if (!ok.ok) return { sent: false, reason: ok.reason }; }
  if (dest === 'thread') {
    if (!opts.threadId) return { sent: false, reason: 'no_thread' };      // sem tópico ainda: não desvia para DM
    try { const th = await client.channels.fetch(opts.threadId); const message = await th.send(payload); await track(opts, guildId, userId, message); return { sent: true, via: 'thread', message }; }
    catch (e) { await problem(guildId, userId, category, 'thread', String(e.message).slice(0, 120)); return { sent: false, reason: 'failed' }; }
  }
  try { const u = await client.users.fetch(userId); const message = await u.send(payload); await track(opts, guildId, userId, message); return { sent: true, via: 'dm', message }; }
  catch (e) { await problem(guildId, userId, category, 'dm', String(e.message).slice(0, 120)); return { sent: false, reason: 'failed' }; }
}

// Encerra mensagens operacionais de uma ação resolvida: os botões somem e o texto vira um desfecho claro.
// Falhas (DM apagada, canal inacessível) são ignoradas: o estado real está no banco.
async function closeOps(client, guildId, kind, ref, { text = 'Esta ação já foi resolvida.', prefix = false, exceptMessageId = null } = {}) {
  let rows = [];
  try { rows = await estore.takeOps(guildId, kind, ref, { prefix, exceptMessageId }); } catch { return 0; }
  let closed = 0;
  for (const r of rows) {
    try {
      let channel; try { channel = await client.channels.fetch(r.channelId); } catch { channel = null; }
      if (!channel) channel = await (await client.users.fetch(r.userId)).createDM();
      const msg = await channel.messages.fetch(r.messageId);
      const c = new ContainerBuilder().setAccentColor(0x777777).addTextDisplayComponents(new TextDisplayBuilder().setContent(`✔️ ${text}`));
      await msg.edit({ components: [c], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }); closed++;
    } catch { /* mensagem indisponível */ }
  }
  return closed;
}

module.exports = { send, closeOps };
