'use strict';
// Notificações de ENGAJAMENTO: avisos agrupados de parceiros/favoritos, alerta de atividade da comunidade, resumo periódico
// de oportunidades e os atalhos de configuração dentro de cada mensagem. Tudo é opt-in, respeita pausa geral, horário
// silencioso e limites de frequência, e nunca usa outro canal sem autorização (ver notify.js).
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const store = require('./store');
const estore = require('./engagementStore');
const notify = require('./notify');
const policy = require('./notifyPolicy');
const core = require('./mmCore');

const V2 = MessageFlags.IsComponentsV2;
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });
const row = (...c) => new ActionRowBuilder().addComponents(c);
const btn = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
const box = (text, rows = []) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (rows.length) { c.addSeparatorComponents(new SeparatorBuilder()); rows.forEach(r => c.addActionRowComponents(r)); }
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
};
const LABEL = { partners: 'Parceiros disponíveis', favorites: 'Favoritos disponíveis', community: 'Atividade da comunidade', digest: 'Resumo de oportunidades' };
const DEST_LABEL = { dm: 'Mensagem privada', off: 'Não avisar', daily: 'Todo dia, às 19h', weekly: 'Toda sexta, às 19h' };

// Toda mensagem de engajamento leva atalhos: ajustar ESTA categoria e pausar tudo por 24 h (sem abrir o servidor).
function engagementPayload(text, category, guildId) {
  return box(text, [row(btn(`minako-mm:eng:cfg:${category}:${guildId}`, 'Ajustar este aviso', '⚙️'), btn(`minako-mm:eng:pause:${guildId}:24`, 'Pausar avisos por 24 h', '⏸️'))]);
}
const quickPanel = (category, guildId, prefs, notice = '') => {
  const paused = policy.isPaused(prefs, Date.now());
  const sel = new StringSelectMenuBuilder().setCustomId(`minako-mm:eng:set:${category}:${guildId}`).setPlaceholder(LABEL[category] || 'Aviso')
    .addOptions(core.NOTIF_OPTIONS[category].map(v => ({ label: DEST_LABEL[v], value: v, default: prefs.notif[category] === v })));
  const rows = [row(sel), row(...(paused ? [btn(`minako-mm:eng:resume:${guildId}`, 'Retomar avisos', '▶️', ButtonStyle.Success)] : [btn(`minako-mm:eng:pause:${guildId}:1`, 'Pausar 1 h', '⏸️'), btn(`minako-mm:eng:pause:${guildId}:24`, 'Pausar 24 h', '⏸️'), btn(`minako-mm:eng:pause:${guildId}:168`, 'Pausar 7 dias', '⏸️')]))];
  return box(`## ⚙️ ${LABEL[category] || 'Avisos'}\n**Agora:** ${DEST_LABEL[prefs.notif[category]]}${paused ? `\n⏸️ **Todos os avisos de engajamento estão pausados** até <t:${Math.floor(prefs.pausedUntil / 1000)}:f>.` : ''}${notice ? `\n\n${notice}` : ''}\n\n-# Isto não afeta propostas, pedidos e decisões que precisam da sua resposta. Ajustes completos (horário silencioso etc.) ficam em **Minhas preferências**, na Central.`, rows);
};

// ---------- Fila agrupada (parceiros/favoritos) ----------
async function flushQueue(client, now = Date.now()) {
  let sent = 0;
  for (const batch of await estore.claimQueue()) {
    for (const g of policy.groupItems(batch.items, now)) {
      const modeLabel = g.subjects.length === 1 ? batch.items.find(i => i.category === g.category && String(i.subjectId) === g.subjects[0])?.modeLabel : null;
      const r = await notify.send(client, batch.guildId, batch.recipientId, g.category, engagementPayload(policy.groupedText(g.category, g.subjects, modeLabel), g.category, batch.guildId));
      if (r.sent) sent++;
    }
  }
  return sent;
}

// ---------- Alerta de atividade da comunidade ----------
async function communityTick(client, guildId, now = Date.now()) {
  const cfg = await store.getSettings(guildId);
  const { communityAlertMin: min, communityAlertCooldownSec: cooldown } = cfg.settings;
  if (!min) return 0;
  const availableNow = await store.countActiveAvailability(guildId);
  if (!policy.communityAlertDue({ availableNow, min, lastAlertAt: await estore.lastCommunityAlert(guildId), cooldownSec: cooldown, now })) return 0;
  const inputs = await estore.communityInputs(guildId);
  const recipients = policy.selectCommunityRecipients({ ...inputs, now });
  if (!recipients.length) return 0;
  if (!(await estore.claimCommunityAlert(guildId, cooldown))) return 0;           // outra instância já alertou dentro do intervalo
  let sent = 0;
  for (const userId of recipients) {
    await estore.logNotice(guildId, userId, 'community', 'community').catch(() => {});
    const r = await notify.send(client, guildId, userId, 'community', engagementPayload(`## 🔥 A comunidade está movimentada\nHá **${availableNow}** pessoas disponíveis para jogar agora. Quer entrar? Use **Quero jogar agora** ou veja os **Grupos abertos** na Central.`, 'community', guildId));
    if (r.sent) sent++;
  }
  await store.logEvent(guildId, 'engagement.community_alert', { recipients: recipients.length, sent }).catch(() => {});
  return sent;
}

// ---------- Resumo periódico ----------
async function digestTick(client, guildId, now = Date.now()) {
  const due = (await estore.digestCandidates(guildId)).filter(c => policy.digestDue(c.prefs, c.lastAt, now));
  if (!due.length) return 0;
  const groups = (await store.listOpenGroups(guildId)).filter(g => g.free > 0);
  const cfg = await store.getSettings(guildId);
  const text = policy.buildDigest({ availableNow: await store.countActiveAvailability(guildId), groups: groups.map(g => ({ mode: cfg.modes.find(m => m.id === g.modeId)?.label || g.modeId, confirmed: g.confirmed, capacity: g.capacity, free: g.free })) });
  if (!text) return 0;                                                            // nada a dizer: nenhum resumo vazio e nenhuma marcação de envio
  let sent = 0;
  for (const c of due) {
    if (!(await estore.claimDigest(guildId, c.userId))) continue;                // no máximo um a cada 12 h, mesmo com duas instâncias
    if ((await notify.send(client, guildId, c.userId, 'digest', engagementPayload(text, 'digest', guildId))).sent) sent++;
  }
  return sent;
}

// ---------- Atalhos dentro das mensagens (funcionam na DM: o servidor vem no customId) ----------
async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:eng:')) return false;
  const [, , action, a1, a2] = id.split(':');
  const userId = interaction.user.id;
  const show = async (category, guildId, notice) => interaction.update(U(quickPanel(category, guildId, await store.getPrefs(guildId, userId), notice)));
  if (action === 'cfg') { const prefs = await store.getPrefs(a2, userId); await interaction.reply(quickPanel(a1, a2, prefs)); return true; }
  if (action === 'set') {
    const value = interaction.values[0];
    if (!core.NOTIF_OPTIONS[a1]?.includes(value)) { await interaction.reply({ content: 'Opção inválida.', flags: MessageFlags.Ephemeral }); return true; }
    await store.savePrefs(a2, userId, { notif: { [a1]: value } }); await show(a1, a2, '✅ Salvo.'); return true;
  }
  if (action === 'pause') {
    const hours = Math.min(168, Math.max(1, Number(a2) || 24)); const until = Date.now() + hours * 3600_000;
    await store.savePrefs(a1, userId, { pausedUntil: until });
    await interaction.update(U(box(`⏸️ Avisos de engajamento pausados até <t:${Math.floor(until / 1000)}:f>. Propostas e pedidos que precisam da sua resposta continuam chegando.`, [row(btn(`minako-mm:eng:resume:${a1}`, 'Retomar agora', '▶️', ButtonStyle.Success))]))); return true;
  }
  if (action === 'resume') { await store.savePrefs(a1, userId, { pausedUntil: null }); await interaction.update(U(box('▶️ Avisos de engajamento retomados.'))); return true; }
  return false;
}

// Ciclo do agendador. Cada parte é isolada: uma falha não derruba as outras.
let lastOpsPurge = 0;
async function sweeps(client, now = Date.now()) {
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { console.error(`[matchmaking] ${label}:`, e.message); return 0; } };
  await safe('fila de avisos', () => flushQueue(client, now));
  for (const guildId of await safe('servidores', () => store.listCentralGuilds()) || []) {
    await safe('alerta de atividade', () => communityTick(client, guildId, now));
    await safe('resumo de oportunidades', () => digestTick(client, guildId, now));
  }
  if (now - lastOpsPurge >= 3600_000) { lastOpsPurge = now; await safe('retenção de mensagens operacionais', () => estore.purgeOps()); }
}
const _resetPurge = () => { lastOpsPurge = 0; };

module.exports = { engagementPayload, quickPanel, flushQueue, communityTick, digestTick, handleInteraction, sweeps, _resetPurge, DEST_LABEL, LABEL };
