'use strict';
// Favoritos e parcerias: ações compartilhadas pelo painel "Minhas preferências" e pelos botões de DM,
// mais o aviso de disponibilidade a parceiros/favoritos. Regras de privacidade (social.js):
//  - favoritos são privados e unilaterais: ninguém recebe aviso de ser favoritado e nenhuma mensagem lista quem favoritou;
//  - parceria só com aceite de ambos; qualquer parte encerra sem penalidade; recusa não é comunicada ao convidante;
//  - avisos de disponibilidade: opt-in por categoria, respeitam a visibilidade escolhida por quem ficou disponível e limites de frequência.
const {
  ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const store = require('./store');
const sstore = require('./socialStore');
const notify = require('./notify');
const estore = require('./engagementStore');
const social = require('./social');
const central = require('./central');

const V2 = MessageFlags.IsComponentsV2;
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });
const box = (text, buttons = []) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (buttons.length) c.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
};
const btn = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

function invitePayload(p, state = 'pending') {
  const head = `## 🤝 Convite de parceria\n<@${p.inviterId}> quer ser seu **parceiro recorrente** no matchmaking.\n`;
  if (state === 'pending') return box(`${head}Parceria só existe se **os dois** quiserem. Você pode encerrar quando quiser, sem penalidade. O convite vale até <t:${Math.floor(p.expiresAt / 1000)}:D>.`, [
    btn(`minako-mm:soc:pa:${p.id}`, 'Aceitar', '✅', ButtonStyle.Success), btn(`minako-mm:soc:pd:${p.id}`, 'Recusar', '✖️')]);
  return box(`${head}${{ active: '✅ Vocês agora são parceiros.', declined: 'Você recusou. Tudo bem, sem nenhum problema.', expired: '⌛ Esse convite expirou.', ended: 'Essa parceria foi encerrada.' }[state] || ''}`);
}

// Resultado legível de um convite. `target` = { id, bot }.
async function invite(client, guildId, inviterId, target) {
  let r;
  try { r = await sstore.invitePartner(guildId, inviterId, target.id, { targetIsBot: Boolean(target.bot) }); }
  catch (e) { if (e.code && social.INVITE_ERRORS[e.code]) return { ok: false, text: `🚫 ${e.message}` }; throw e; }
  if (r.action === 'activated') {
    await notify.send(client, guildId, target.id, 'actions', box(`🤝 <@${inviterId}> também queria ser seu parceiro: vocês agora são **parceiros recorrentes**.`));
    return { ok: true, text: `🤝 <@${target.id}> já tinha convidado você: vocês agora são parceiros!` };
  }
  const p = await sstore.getPartnership(r.id);
  const sent = await notify.send(client, guildId, target.id, 'actions', invitePayload(p), { track: { kind: 'pinv', ref: r.id } });
  if (sent.sent && sent.message) await sstore.setPartnershipDm(r.id, sent.message.channelId, sent.message.id);
  return { ok: true, text: sent.sent
    ? `📨 Convite enviado para <@${target.id}>. Se a pessoa aceitar, vocês viram parceiros; recusas não são comunicadas.`
    : `📨 Convite registrado para <@${target.id}>, mas não consegui avisar por mensagem privada. Ela pode aceitar em **Minhas preferências → Parceiros**. Não uso outro canal sem autorização.` };
}

// Aceitar/recusar (DM ou painel). Devolve { ok, status, text } e atualiza a DM do convite.
async function respond(client, userId, partnershipId, accept, { exceptMessageId = null } = {}) {
  let r;
  try { r = await sstore.respondPartnership(partnershipId, userId, accept); }
  catch (e) { if (['NOT_FOUND', 'NOT_PARTICIPANT', 'NOT_TARGET', 'LIMIT'].includes(e.code)) return { ok: false, status: e.code, text: `🚫 ${e.message}` }; throw e; }
  const p = await sstore.getPartnership(partnershipId);
  await notify.closeOps(client, p.guildId, 'pinv', partnershipId, { exceptMessageId, text: 'Você já respondeu a este convite.' });
  if (r.stale) return { ok: true, status: r.status, partnership: p, text: r.status === 'expired' ? '⌛ Esse convite já expirou.' : 'Esse convite já foi respondido.' };
  if (r.status === 'active') {
    await notify.send(client, p.guildId, p.inviterId, 'actions', box(`🤝 <@${userId}> aceitou seu convite: vocês agora são **parceiros recorrentes**!`));
    void central.requestRefresh(client, p.guildId);
  }   // recusa: o convidante NÃO é avisado (sem constrangimento e sem punição)
  return { ok: true, status: r.status, partnership: p, text: r.status === 'active' ? '🤝 Parceria criada!' : 'Convite recusado. Sem problema nenhum. ✨' };
}

// `subjectId` ficou disponível (chamado só quando a disponibilidade é CRIADA, nunca em renovações).
// Quem pode ser avisado já foi decidido por social.selectWatchRecipients (opt-in, visibilidade, pausa, silêncio, limites).
// Os avisos entram numa fila e saem AGRUPADOS (engagementFlow.flushQueue): vários parceiros disponíveis viram uma mensagem só.
async function announceAvailability(client, guildId, subjectId, modeLabel) {
  let recipients = [];
  try { recipients = await sstore.watchRecipients(guildId, subjectId); } catch (e) { console.error('[matchmaking] avisos de disponibilidade:', e.message); return 0; }
  let queued = 0;
  for (const r of recipients) {
    try { await estore.enqueue(guildId, r.userId, r.category, subjectId, modeLabel || null); queued++; } catch (e) { console.error('[matchmaking] fila de avisos:', e.message); }
  }
  return queued;
}

// Convites vencidos: a DM do convite é atualizada; ninguém é punido nem avisado além disso.
async function sweepInvites(client) {
  for (const p of await sstore.sweepExpiredInvites()) {
    if (!p.dmMessageId) continue;
    try { const target = p.inviterId === p.userA ? p.userB : p.userA; const u = await client.users.fetch(target); const dm = await u.createDM(); const m = await dm.messages.fetch(p.dmMessageId); await m.edit(U(invitePayload(p, 'expired'))); } catch { /* DM indisponível: nada a fazer */ }
  }
}

// Botões de DM: minako-mm:soc:pa:<id> (aceitar) / pd:<id> (recusar). Na DM não há guildId; ele vem do convite.
async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:soc:')) return false;
  const [, , action, pid] = id.split(':');
  if (!['pa', 'pd'].includes(action)) return false;
  const r = await respond(interaction.client, interaction.user.id, pid, action === 'pa', { exceptMessageId: interaction.message?.id });
  if (!r.ok || !r.partnership) return interaction.update(U(box(r.text))).then(() => true);
  const state = r.status === 'active' ? 'active' : r.status === 'declined' ? 'declined' : r.status === 'expired' ? 'expired' : 'ended';
  await interaction.update(U(invitePayload(r.partnership, state)));
  return true;
}

module.exports = { invitePayload, invite, respond, announceAvailability, sweepInvites, handleInteraction };
