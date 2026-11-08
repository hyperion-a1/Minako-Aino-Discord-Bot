'use strict';
// Registro de partida: "Registrar conclusão", "Ainda estamos jogando" e "A partida não aconteceu".
// Confirmação/contestação dos participantes numa janela configurável. Silêncio não confirma nem invalida.
// Contestação => revisão por quem tem o cargo de revisor (configurável); sem punição e sem recompensa final.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const store = require('./store');
const groupFlow = require('./groupFlow');
const central = require('./central');
const perms = require('./permissions');

const EPH = MessageFlags.Ephemeral; const V2 = MessageFlags.IsComponentsV2;
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });
const box = (text, rows = [], { eph = true, roles = [] } = {}) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (rows.length) { c.addSeparatorComponents(new SeparatorBuilder()); rows.forEach(r => c.addActionRowComponents(r)); }
  return { components: [c], flags: V2 | (eph ? EPH : 0), allowedMentions: { parse: [], roles } };
};
const row = (...c) => new ActionRowBuilder().addComponents(c);
const btn = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

const ERR = {
  NOT_ORGANIZER: 'Apenas o organizador pode fazer isso.', BAD_STATE: 'Isso não é possível no estado atual do grupo.', GROUP_NOT_FOUND: 'Esse grupo não existe mais.',
  NOT_PARTICIPANT: 'Você não participou dessa partida.', IS_ORGANIZER: 'Você registrou a conclusão, então não precisa confirmar.', MATCH_NOT_FOUND: 'Esse registro não existe mais.',
};
const errText = (e) => ERR[e.code] || null;

async function postToThread(client, threadId, payload) {
  if (!threadId) return false;
  try { const th = await client.channels.fetch(threadId); await th.send(payload); return true; } catch { return false; }
}

function windowPayload(match) {
  return box(`## 🏁 Conclusão registrada\n<@${match.organizerId}> registrou que a partida do grupo **#${match.groupId}** foi concluída.\n\n` +
    `Participantes: confirmem ou contestem até <t:${Math.floor(match.windowEndsAt / 1000)}:R>.\n` +
    `-# O silêncio não conta como confirmação nem como contestação. Contestar apenas pede uma revisão; ninguém é punido.`, [
    row(btn(`minako-mm:m:ok:${match.id}`, 'Confirmar', '✅', ButtonStyle.Success), btn(`minako-mm:m:ct:${match.id}`, 'Contestar', '⚠️'))], { eph: false });
}

async function register(interaction, groupId) {
  const guildId = interaction.guildId; const cfg = await store.getSettings(guildId);
  let r;
  try { r = await store.registerMatch(guildId, groupId, interaction.user.id, cfg.settings.confirmationWindowSec, cfg.settings.archiveAfterSec); }
  catch (e) { const m = errText(e); if (m) return interaction.reply(box(`🚫 ${m}`)); throw e; }
  if (!r.created) return interaction.reply(box('Essa conclusão já foi registrada. ✅'));
  const group = await store.getGroup(guildId, groupId);
  const posted = await postToThread(interaction.client, group?.threadId, windowPayload(r.match));
  if (!posted) await store.logEvent(guildId, 'match.window_unposted', { matchId: r.match.id });
  await groupFlow.refreshAnnouncement(interaction.client, guildId, groupId);
  return interaction.reply(box(posted ? '🏁 Conclusão registrada! Os participantes já podem confirmar no tópico.' : '🏁 Conclusão registrada, mas não consegui avisar no tópico. Avise os participantes para confirmarem pelo botão do anúncio.'));
}
async function still(interaction, groupId) {
  const g = await store.getGroup(interaction.guildId, groupId);
  if (!g) return interaction.reply(box(`🚫 ${ERR.GROUP_NOT_FOUND}`));
  if (g.organizerId !== interaction.user.id) return interaction.reply(box(`🚫 ${ERR.NOT_ORGANIZER}`));
  await store.logEvent(interaction.guildId, 'group.still_playing', { groupId });
  return interaction.reply(box('🎮 Combinado! Quando terminarem, volte e use **Registrar conclusão**.'));
}
async function notPlayed(interaction, groupId) {
  const guildId = interaction.guildId; const cfg = await store.getSettings(guildId);
  let r;
  try { r = await store.markNotPlayed(guildId, groupId, interaction.user.id, cfg.settings.archiveAfterSec); }
  catch (e) { const m = errText(e); if (m) return interaction.reply(box(`🚫 ${m}`)); throw e; }
  if (!r.created) return interaction.reply(box('Esse grupo já tem um desfecho registrado.'));
  const group = await store.getGroup(guildId, groupId);
  await postToThread(interaction.client, group?.threadId, box('🚫 O organizador informou que a partida **não aconteceu**. O grupo foi encerrado, sem penalidade para ninguém. O tópico será arquivado em breve.', [], { eph: false }));
  await groupFlow.refreshAnnouncement(interaction.client, guildId, groupId);
  return interaction.reply(box('🚫 Registrado como "a partida não aconteceu".'));
}

async function routeReview(client, guildId, match, contestedBy) {
  const cfg = await store.getSettings(guildId);
  const channel = cfg.settings.reviewChannelId ? await client.channels.fetch(cfg.settings.reviewChannelId).catch(() => null) : null;
  const ping = cfg.settings.reviewRoleId ? `<@&${cfg.settings.reviewRoleId}> ` : '';
  if (!channel?.send) { await store.logEvent(guildId, 'match.review_unrouted', { matchId: match.id }); return false; }
  try {
    await channel.send(box(`## ⚖️ Registro em revisão\n${ping}O registro da partida do grupo **#${match.groupId}** foi contestado por <@${contestedBy}>.\n**Organizador:** <@${match.organizerId}>\n**Participantes:** ${match.participantIds.map(id => `<@${id}>`).join(', ')}\n\n-# Contestar não gera punição. Registros em revisão não liberam recompensas finais.`, [
      row(btn(`minako-mm:m:rv:${match.id}:v`, 'Validar registro', '✅', ButtonStyle.Success), btn(`minako-mm:m:rv:${match.id}:r`, 'Rejeitar registro', '✖️'))], { eph: false, roles: cfg.settings.reviewRoleId ? [cfg.settings.reviewRoleId] : [] }));
    return true;
  } catch (e) { await store.logEvent(guildId, 'match.review_unrouted', { matchId: match.id, error: String(e.message).slice(0, 200) }); return false; }
}

async function answer(interaction, matchId, ans) {
  const guildId = interaction.guildId;
  let r;
  try { r = await store.respondMatch(guildId, matchId, interaction.user.id, ans); }
  catch (e) { const m = errText(e); if (m) return interaction.reply(box(`🚫 ${m}`)); throw e; }
  if (r.stale) return interaction.reply(box('A janela de confirmação desse registro já foi encerrada.'));
  if (ans === 'contested') {
    const routed = r.newlyContested ? await routeReview(interaction.client, guildId, r.match, interaction.user.id) : true;
    return interaction.reply(box(routed ? '⚠️ Contestação registrada. A equipe de revisão vai analisar — sem punição para ninguém.' : '⚠️ Contestação registrada. Não consegui avisar a revisão agora, mas ela ficou salva e a administração será alertada.'));
  }
  void central.requestRefresh(interaction.client, guildId);
  return interaction.reply(box(r.match.status === 'validated' ? '✅ Obrigado! Todos confirmaram — o registro foi validado.' : '✅ Obrigado! Sua confirmação foi registrada.'));
}

async function review(interaction, matchId, decision) {
  const guildId = await store.matchGuildId(matchId);
  if (!guildId) return interaction.reply(box(`🚫 ${ERR.MATCH_NOT_FOUND}`));
  const cfg = await store.getSettings(guildId);
  if (!(await perms.can(interaction, 'match.review', cfg))) return interaction.reply(box('🚫 Apenas a equipe de revisão pode decidir isso.'));
  let m;
  try { m = await store.resolveReview(guildId, matchId, interaction.user.id, decision === 'v' ? 'valid' : 'reject'); }
  catch (e) { if (e.code === 'BAD_STATE') return interaction.reply(box('Esse registro já foi resolvido.')); const t = errText(e); if (t) return interaction.reply(box(`🚫 ${t}`)); throw e; }
  const group = await store.getGroup(guildId, m.groupId);
  await postToThread(interaction.client, group?.threadId, box(m.status === 'validated' ? '✅ A revisão validou o registro da partida.' : '✖️ A revisão não validou o registro da partida. Ninguém foi penalizado.', [], { eph: false }));
  void central.requestRefresh(interaction.client, guildId);
  return interaction.update(U(box(`## ⚖️ Registro resolvido\nGrupo **#${m.groupId}** — ${m.status === 'validated' ? '✅ validado' : '✖️ rejeitado'} por <@${interaction.user.id}>.`, [], { eph: false })));
}

async function sweeps(client) {
  for (const m of await store.sweepMatchWindows()) {
    const group = await store.getGroup(m.guildId, m.groupId);
    await postToThread(client, group?.threadId, box(m.status === 'validated' ? '✅ A janela de confirmação terminou e o registro foi validado.' : '🏁 A janela de confirmação terminou. O registro permanece, sem contestações. Quem não respondeu não foi penalizado.', [], { eph: false }));
    void central.requestRefresh(client, m.guildId);
  }
}

async function handleInteraction(interaction) {
  const [, kind, action, ...rest] = (interaction.customId || '').split(':');
  if (!(interaction.customId || '').startsWith('minako-mm:') || kind !== 'm') return false;
  if (!interaction.guildId && action !== 'rv') { await interaction.reply(box('Use isto no servidor.')); return true; }
  const id = rest[0];
  if (action === 'done') await register(interaction, id);
  else if (action === 'still') await still(interaction, id);
  else if (action === 'no') await notPlayed(interaction, id);
  else if (action === 'ok') await answer(interaction, id, 'confirmed');
  else if (action === 'ct') await answer(interaction, id, 'contested');
  else if (action === 'rv') await review(interaction, id, rest[1]);
  else return false;
  return true;
}

module.exports = { windowPayload, routeReview, sweeps, handleInteraction };
