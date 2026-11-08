'use strict';
// Histórico de confiabilidade na interface: visão própria (em Minhas preferências), pedido de revisão, decisão da equipe e retenção.
// Nada é público: só a própria pessoa e a administração consultam. Nenhuma pontuação, nenhuma punição automática.
const {
  ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const store = require('./store');
const rstore = require('./reliabilityStore');
const rel = require('./reliability');
const notify = require('./notify');
const perms = require('./permissions');

const EPH = MessageFlags.Ephemeral; const V2 = MessageFlags.IsComponentsV2;
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });
const box = (text, buttons = [], { eph = false, roles = [] } = {}) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (buttons.length) c.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  return { components: [c], flags: V2 | (eph ? EPH : 0), allowedMentions: { parse: [], roles } };
};
const btn = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
const STATUS = { active: '', disputed: ' · em revisão', removed: ' · removido' };
const line = (r) => `• #${r.id} · ${rel.LABEL[r.kind]}${r.groupId ? ` · grupo #${r.groupId}` : ''} · <t:${Math.floor(r.at / 1000)}:d>${STATUS[r.status] || ''}${r.note && r.status !== 'active' ? ` — ${r.note}` : ''}`;
const known = (e) => e && Object.keys(rel.DISPUTE_ERRORS).includes(e.code);

// Texto da visão (própria ou administrativa). Só descreve; nunca pontua.
function overviewText(ov, { admin = false, userId = null } = {}) {
  const who = admin ? `**Histórico de <@${userId}>** (visível só à administração)\n` : 'Só **você** e a **administração** veem isto. Não existe pontuação pública e nenhum registro gera punição.\n';
  const recent = ov.recent.length ? `\n\n**Registros recentes:**\n${ov.recent.map(line).join('\n')}` : '\n\nAinda não há registros.';
  return `${who}${rel.describe(ov.summary)}${recent}`;
}

// Pedido de revisão pelo próprio usuário → encaminha à equipe de revisão e devolve a mensagem para a pessoa.
async function requestReview(client, guildId, userId, recordId) {
  let r;
  try { r = await rstore.dispute(guildId, userId, recordId); }
  catch (e) { if (known(e)) return { ok: false, text: `🚫 ${e.message}` }; throw e; }
  const routed = await routeDispute(client, guildId, r);
  return { ok: true, text: routed ? '📝 Pedido de revisão enviado. Enquanto isso, esse registro **não entra na conta**. Você será avisado do resultado.' : '📝 Pedido registrado e o registro **não entra mais na conta**, mas não consegui avisar a equipe de revisão agora; a administração será alertada.' };
}
async function routeDispute(client, guildId, r) {
  const cfg = await store.getSettings(guildId);
  const channel = cfg.settings.reviewChannelId ? await client.channels.fetch(cfg.settings.reviewChannelId).catch(() => null) : null;
  const ping = cfg.settings.reviewRoleId ? `<@&${cfg.settings.reviewRoleId}> ` : '';
  if (!channel?.send) { await store.logEvent(guildId, 'reliability.review_unrouted', { recordId: r.id }).catch(() => {}); return false; }
  try {
    await channel.send(box(`## 📋 Pedido de revisão de registro\n${ping}<@${r.userId}> pediu revisão do registro **#${r.id}**: ${rel.LABEL[r.kind]}${r.groupId ? ` (grupo #${r.groupId})` : ''}, em <t:${Math.floor(r.at / 1000)}:f>.\n\n-# Mantenha só se o registro estiver correto. Registros comprovadamente incorretos devem ser removidos. Nada disso gera punição.`, [
      btn(`minako-mm:rel:r:${r.id}`, 'Remover registro', '🧹', ButtonStyle.Success), btn(`minako-mm:rel:k:${r.id}`, 'Manter registro', '✅')], { roles: cfg.settings.reviewRoleId ? [cfg.settings.reviewRoleId] : [] }));
    return true;
  } catch (e) { await store.logEvent(guildId, 'reliability.review_unrouted', { recordId: r.id, error: String(e.message).slice(0, 200) }).catch(() => {}); return false; }
}

// Botões da equipe: minako-mm:rel:r:<id> (remover) / k:<id> (manter). Exigem o nível de revisão.
async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:rel:')) return false;
  const [, , action, rid] = id.split(':');
  if (!interaction.guildId) { await interaction.reply({ content: 'Use isto no servidor.', flags: EPH }); return true; }
  if (!(await perms.can(interaction, 'match.review'))) { await interaction.reply({ content: '🚫 Apenas a equipe de revisão pode decidir isso.', flags: EPH }); return true; }
  let r;
  try { r = await rstore.resolve(interaction.guildId, rid, interaction.user.id, action === 'r' ? 'remove' : 'keep'); }
  catch (e) { if (known(e)) { await interaction.reply({ content: `🚫 ${e.message}`, flags: EPH }); return true; } throw e; }
  await interaction.update(U(box(`## 📋 Registro #${r.id} resolvido\n${r.status === 'removed' ? '🧹 Removido' : '✅ Mantido'} por <@${interaction.user.id}>.`)));
  await notify.send(interaction.client, interaction.guildId, r.userId, 'actions', box(r.status === 'removed'
    ? `📋 A revisão do registro **#${r.id}** concluiu que ele estava incorreto, e ele foi **removido**. Obrigado por avisar!`
    : `📋 A revisão do registro **#${r.id}** concluiu que ele está correto, então foi **mantido**. Isso não gera punição, e um evento isolado nunca é tratado como padrão.`));
  return true;
}

// Retenção: no máximo uma limpeza por hora.
let lastPurge = 0;
async function sweeps(now = Date.now()) {
  if (now - lastPurge < 3600_000) return 0;
  lastPurge = now;
  try { return await rstore.purge(); } catch (e) { console.error('[matchmaking] retenção de confiabilidade:', e.message); return 0; }
}
const _resetPurge = () => { lastPurge = 0; };

module.exports = { overviewText, requestReview, routeDispute, handleInteraction, sweeps, _resetPurge };
