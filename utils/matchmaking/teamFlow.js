'use strict';
// Equipes e duplas recorrentes: painel "Minhas equipes", convites de membro, sessão da equipe (cada membro confirma
// CADA sessão; as vagas ficam reservadas e só as realmente abertas aparecem para quem é de fora) e varreduras.
// A sessão é um GRUPO comum: anúncio, vagas, aprovação, tópico privado e registro de partida são os de sempre.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const store = require('./store');
const tstore = require('./teamStore');
const teams = require('./teams');
const notify = require('./notify');
const groupFlow = require('./groupFlow');
const central = require('./central');

const EPH = MessageFlags.Ephemeral; const V2 = MessageFlags.IsComponentsV2;
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });
const row = (...c) => new ActionRowBuilder().addComponents(c);
const btn = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
const box = (text, rows = [], { eph = true } = {}) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (rows.length) { c.addSeparatorComponents(new SeparatorBuilder()); rows.forEach(r => c.addActionRowComponents(r)); }
  return { components: [c], flags: V2 | (eph ? EPH : 0), allowedMentions: { parse: [] } };
};
const errMsg = (e) => (e?.code && (teams.TEAM_ERRORS[e.code] || e.message)) || null;
const KNOWN = new Set([...Object.keys(teams.TEAM_ERRORS), 'NOT_INVITED', 'NOT_MEMBER', 'OWNER_CANNOT_BE_REMOVED', 'INCOMPATIBLE_COMMITMENT', 'GROUP_NOT_FOUND']);
const known = (e) => e && KNOWN.has(e.code);

// ---------- Telas ----------
function mainPanel(my, labels = {}, notice = '') {
  const lines = my.teams.length ? my.teams.map(t => `• **${t.name}** · ${teams.teamKind(t.activeCount)} · ${t.activeCount} membro${t.activeCount === 1 ? '' : 's'}${t.isOwner ? ' · você lidera' : ''}`).join('\n') : 'Você ainda não está em nenhuma equipe.';
  const inv = my.invites.length ? `\n\n**Convites recebidos:**\n${my.invites.map(i => `• **${i.name}** (de <@${i.invitedBy}>)`).join('\n')}` : '';
  const rows = [];
  if (my.teams.length) rows.push(row(new StringSelectMenuBuilder().setCustomId('minako-mm:team:view').setPlaceholder('Abrir uma equipe').addOptions(my.teams.slice(0, 25).map(t => ({ label: t.name.slice(0, 100), value: t.id })))));
  const b = [btn('minako-mm:team:new', 'Criar equipe', '➕', ButtonStyle.Success)];
  for (const i of my.invites.slice(0, 2)) b.push(btn(`minako-mm:team:ia:${i.teamId}`, `Aceitar ${i.name}`.slice(0, 40), '✅', ButtonStyle.Primary), btn(`minako-mm:team:id:${i.teamId}`, 'Recusar', '✖️'));
  rows.push(row(...b.slice(0, 5)));
  return box(`## 👥 Minhas equipes\nEquipes e duplas reutilizáveis. **Entrar numa equipe não é ficar disponível:** a cada sessão, cada membro confirma se vem. Sair ou não confirmar nunca gera penalidade.\n\n${lines}${inv}${notice ? `\n\n${notice}` : ''}`, rows);
}

function detailPanel(d, me, labels = {}, notice = '') {
  const active = d.members.filter(m => m.status === 'active'); const invited = d.members.filter(m => m.status === 'invited');
  const isOwner = d.ownerId === me; const isMember = active.some(m => m.userId === me);
  const list = active.map(m => `<@${m.userId}>${m.userId === d.ownerId ? ' 👑' : ''}`).join(', ');
  const pend = invited.length ? `\n**Convites abertos:** ${invited.map(m => `<@${m.userId}>`).join(', ')}` : '';
  const session = d.liveGroupId ? `\n**Sessão em andamento:** grupo **#${d.liveGroupId}**` : '';
  const text = `## 👥 ${d.name}\n**${teams.teamKind(active.length)}** · ${active.length}/${teams.LIMITS.maxMembers} membros · equipe **#${d.id}**\n**Membros:** ${list}${pend}${session}${notice ? `\n\n${notice}` : ''}`;
  const rows = [];
  const actions = [];
  if (isMember && !d.liveGroupId) actions.push(btn(`minako-mm:team:play:${d.id}`, 'Procurar partida', '🎮', ButtonStyle.Success));
  if (isMember) actions.push(btn(`minako-mm:team:leave:${d.id}`, 'Sair da equipe', '🚪'));
  actions.push(btn('minako-mm:team', 'Voltar', '↩️'));
  if (isOwner) {
    rows.push(row(new UserSelectMenuBuilder().setCustomId(`minako-mm:team:invite:${d.id}`).setPlaceholder('Convidar alguém para a equipe').setMinValues(1).setMaxValues(1)));
    const removable = d.members.filter(m => m.userId !== d.ownerId);
    if (removable.length) rows.push(row(new StringSelectMenuBuilder().setCustomId(`minako-mm:team:remove:${d.id}`).setPlaceholder('Remover um membro').addOptions(removable.slice(0, 25).map(m => ({ label: (labels[m.userId] || `Usuário …${m.userId.slice(-4)}`).slice(0, 100), value: m.userId, description: m.status === 'invited' ? 'convite aberto' : undefined })))));
    actions.push(btn(`minako-mm:team:disband:${d.id}`, 'Dissolver', '🗑️', ButtonStyle.Danger));
  }
  rows.push(row(...actions.slice(0, 5)));
  return box(text, rows);
}

function sessionPanel(d, cfg, sel) {
  const active = d.members.filter(m => m.status === 'active').length;
  const modes = cfg.modes.filter(m => m.active && m.idealSize >= active);
  const mode = modes.find(m => m.id === sel.mode) || modes[0];
  if (!mode) return box(`## 🎮 Procurar partida\nNenhum modo ativo comporta ${active} membros. Peça à administração para ajustar os modos.`, [row(btn(`minako-mm:team:v:${d.id}`, 'Voltar', '↩️'))]);
  const jm = sel.jm === 'd' ? 'd' : 'a';
  const free = mode.idealSize - active;
  const text = `## 🎮 Procurar partida · ${d.name}\n**Modo:** ${mode.label} (${mode.idealSize} jogadores)\n**Entrada de jogadores de fora:** ${jm === 'a' ? 'com sua aprovação' : 'direta'}\n\nVou convidar os outros membros para **confirmarem esta sessão** (eles têm tempo limitado) e ${free > 0 ? `abrir ${free} vaga${free === 1 ? '' : 's'} para quem é de fora` : 'a equipe já completa o modo'}. As vagas dos membros ficam reservadas e só as realmente abertas aparecem no anúncio.`;
  return box(text, [
    row(new StringSelectMenuBuilder().setCustomId(`minako-mm:team:pm:${d.id}:${jm}`).setPlaceholder('Modo').addOptions(modes.map(m => ({ label: m.label, value: m.id, default: m.id === mode.id })))),
    row(new StringSelectMenuBuilder().setCustomId(`minako-mm:team:pj:${d.id}:${mode.id}`).setPlaceholder('Entrada de jogadores de fora').addOptions([{ label: 'Com aprovação', value: 'a', default: jm === 'a' }, { label: 'Direta', value: 'd', default: jm === 'd' }])),
    row(btn(`minako-mm:team:go:${d.id}:${mode.id}:${jm}`, 'Começar sessão', '▶️', ButtonStyle.Success), btn(`minako-mm:team:v:${d.id}`, 'Voltar', '↩️')),
  ]);
}

function reservationPayload(team, group, starterId, expiresAt, state = 'pending') {
  const head = `## 👥 Sessão da equipe ${team.name}\n<@${starterId}> está procurando partida com a equipe (${group.modeLabel || group.modeId}).\n`;
  if (state === 'pending') return box(`${head}**Você vem nesta sessão?** Responda <t:${Math.floor(expiresAt / 1000)}:R>. Ser da equipe não obriga ninguém a jogar; recusar ou não responder não tem penalidade.`, [
    row(btn(`minako-mm:team:yes:${group.id}`, 'Eu vou', '✅', ButtonStyle.Success), btn(`minako-mm:team:no:${group.id}`, 'Não posso agora', '✖️'))], { eph: false });
  const t = { confirmed: '✅ **Confirmado!** Quando a equipe fechar, o espaço privado é criado.', declined: 'Tudo bem! A sua vaga foi aberta. Sem penalidade.', expired: '⌛ O tempo para confirmar acabou e a vaga já foi preenchida.', closed: 'Essa sessão não está mais recebendo membros.', already: 'Você já confirmou esta sessão. ✅', none: 'Não encontrei uma reserva sua nessa sessão.' }[state];
  return box(`${head}${t}`, [], { eph: false });
}

// ---------- Entrada ----------
async function openMain(interaction, notice = '') {
  const my = await tstore.listMyTeams(interaction.guildId, interaction.user.id);
  const payload = mainPanel(my, {}, notice);
  return interaction.isMessageComponent?.() ? interaction.update(U(payload)) : interaction.reply(payload);
}
async function showDetail(interaction, teamId, notice = '') {
  const d = await tstore.getTeamDetail(interaction.guildId, teamId);
  if (!d || d.status !== 'active') return interaction.update(U(mainPanel(await tstore.listMyTeams(interaction.guildId, interaction.user.id), {}, `🚫 ${teams.TEAM_ERRORS.TEAM_DISBANDED}`)));
  const labels = {};
  await Promise.all(d.members.slice(0, 25).map(async (m) => { try { labels[m.userId] = (await interaction.guild?.members?.fetch?.(m.userId))?.displayName; } catch { /* sem rótulo */ } }));
  return interaction.update(U(detailPanel(d, interaction.user.id, labels, notice)));
}

// ---------- Convites de membro ----------
function invitePayload(team, invitedBy, expiresAt, state = 'pending') {
  const head = `## 👥 Convite para a equipe **${team.name}**\n<@${invitedBy}> convidou você.\n`;
  if (state === 'pending') return box(`${head}Entrar na equipe **não** obriga você a jogar: a cada sessão você decide se vai. Pode sair quando quiser, sem penalidade. O convite vale até <t:${Math.floor(expiresAt / 1000)}:D>.`, [
    row(btn(`minako-mm:team:ia:${team.id}`, 'Aceitar', '✅', ButtonStyle.Success), btn(`minako-mm:team:id:${team.id}`, 'Recusar', '✖️'))], { eph: false });
  return box(`${head}${{ active: '✅ Você agora faz parte da equipe.', declined: 'Você recusou. Tudo bem, sem problema nenhum.', expired: '⌛ Esse convite expirou.', disbanded: 'Essa equipe foi dissolvida.' }[state] || 'Esse convite já foi respondido.'}`, [], { eph: false });
}
async function sendInvite(client, guildId, teamId, inviterId, target) {
  let r;
  try { r = await tstore.inviteMember(guildId, teamId, inviterId, target.id, { targetIsBot: Boolean(target.bot) }); }
  catch (e) { if (known(e)) return `🚫 ${errMsg(e)}`; throw e; }
  const inv = await tstore.getInvite(teamId, target.id);
  const sent = await notify.send(client, guildId, target.id, 'actions', invitePayload(r.team, inviterId, inv.expiresAt), { track: { kind: 'tinv', ref: `${teamId}:${target.id}` } });
  if (sent.sent && sent.message) await tstore.setInviteDm(teamId, target.id, sent.message.channelId, sent.message.id);
  return sent.sent ? `📨 Convite enviado para <@${target.id}>. Recusas não são comunicadas.` : `📨 Convite registrado para <@${target.id}>, mas não consegui avisar por mensagem privada. Ela pode aceitar em **Minhas equipes**. Não uso outro canal sem autorização.`;
}
async function answerInvite(client, teamId, userId, accept, { exceptMessageId = null } = {}) {
  let r;
  try { r = await tstore.respondInvite(teamId, userId, accept); }
  catch (e) { if (known(e)) return { ok: false, text: `🚫 ${errMsg(e)}` }; throw e; }
  await notify.closeOps(client, r.team.guildId, 'tinv', `${teamId}:${userId}`, { exceptMessageId, text: 'Você já respondeu a este convite.' });
  if (r.stale) return { ok: true, state: r.status, team: r.team, text: r.status === 'expired' ? '⌛ Esse convite expirou.' : r.status === 'disbanded' ? 'Essa equipe foi dissolvida.' : 'Esse convite já foi respondido.' };
  if (r.status === 'active') await notify.send(client, r.team.guildId, r.team.ownerId, 'actions', box(`👥 <@${userId}> entrou na sua equipe **${r.team.name}**.`, [], { eph: false }));
  return { ok: true, state: r.status, team: r.team, text: r.status === 'active' ? `👥 Você agora faz parte da equipe **${r.team.name}**!` : 'Convite recusado. Sem problema nenhum. ✨' };
}

// ---------- Sessão ----------
async function startSession(interaction, teamId, modeId, jm) {
  const guildId = interaction.guildId; const cfg = await store.getSettings(guildId);
  const mode = cfg.modes.find(m => m.id === modeId && m.active);
  if (!mode) return interaction.update(U(box('Esse modo não está mais disponível.')));
  if (!cfg.groupsChannelId) return interaction.update(U(box('🚫 A administração ainda não configurou o canal de grupos abertos. Avise a equipe. 🙏')));
  let r;
  try { r = await tstore.startSession(guildId, teamId, interaction.user.id, { mode, joinMethod: jm === 'd' ? 'direct' : 'approval', reserveTtlSec: cfg.settings.teamConfirmTtlSec }); }
  catch (e) { if (known(e)) return interaction.update(U(box(`🚫 ${errMsg(e)}`, [row(btn(`minako-mm:team:v:${teamId}`, 'Voltar', '↩️'))]))); throw e; }
  const group = { ...r.group, guildId, modeLabel: mode.label };
  try { await groupFlow.publishAnnouncement(interaction.client, group); }
  catch (e) { console.error('[matchmaking] anúncio da sessão da equipe:', e.message); await store.logEvent(guildId, 'group.announcement_failed', { groupId: r.groupId }).catch(() => {}); }
  const expiresAt = Date.now() + cfg.settings.teamConfirmTtlSec * 1000;
  let unreachable = 0;
  for (const uid of r.reserveIds) {
    const sent = await notify.send(interaction.client, guildId, uid, 'actions', reservationPayload(r.team, group, interaction.user.id, expiresAt), { track: { kind: 'resv', ref: `${r.groupId}:${uid}` } });
    if (!sent.sent) unreachable++;
  }
  void central.requestRefresh(interaction.client, guildId);
  const open = r.group.free;
  const skipped = r.skippedBusy.length ? `\n⚠️ ${r.skippedBusy.map(i => `<@${i}>`).join(', ')} já está(ão) em outro grupo e não foi(ram) reservado(s).` : '';
  const warn = unreachable ? `\n⚠️ ${unreachable} membro(s) não puderam ser avisados por mensagem privada; peça para entrarem pelo anúncio.` : '';
  return interaction.update(U(box(`✅ Sessão criada: grupo **#${r.groupId}**.\nOs outros membros têm ${Math.round(cfg.settings.teamConfirmTtlSec / 60)} min para confirmar. Vagas abertas ao público agora: **${open}**.${skipped}${warn}`, [])));
}

// Botões "Eu vou / Não posso" (DM ou anúncio): não há guildId na DM.
async function answerSession(interaction, groupId, answer) {
  const guildId = await store.groupGuildId(groupId);
  if (!guildId) return interaction.update(U(box('Esse grupo não existe mais.', [], { eph: false })));
  const cfg = await store.getSettings(guildId);
  const teamBase = { name: 'da equipe' };
  let r;
  try { r = await tstore.answerReservation(guildId, groupId, interaction.user.id, answer); }
  catch (e) { if (known(e)) return interaction.update(U(box(`🚫 ${errMsg(e)}`, [], { eph: false }))); throw e; }
  const g = r.group; const team = { name: g.teamName || teamBase.name };
  const view = (state) => reservationPayload(team, { id: groupId, modeId: g.modeId, modeLabel: cfg.modes.find(m => m.id === g.modeId)?.label }, g.organizerId, g.searchUntil || Date.now(), state);
  if (r.stale) return interaction.update(U(view(r.stale)));
  await interaction.update(U(view(r.status)));
  await notify.closeOps(interaction.client, guildId, 'resv', `${groupId}:${interaction.user.id}`, { exceptMessageId: interaction.message?.id, text: 'Você já respondeu a esta sessão.' });
  const after = await groupFlow.refreshAfterChange(interaction.client, guildId, groupId);
  if (r.status === 'confirmed' && after) await groupFlow.afterJoinNotices(interaction.client, guildId, after, interaction.user.id);
  if (r.status === 'declined') await notify.send(interaction.client, guildId, g.organizerId, 'groups', box(`ℹ️ <@${interaction.user.id}> não poderá jogar esta sessão. A vaga já está aberta ao público.`, [], { eph: false }), { threadId: g.threadId });
  return true;
}

// ---------- Roteador ----------
async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:team')) return false;
  const [, , action, a1, a2, a3] = id.split(':');
  const DM_OK = ['ia', 'id', 'yes', 'no'];
  if (!interaction.guildId && !DM_OK.includes(action)) { await interaction.reply({ content: 'Use isto no servidor.', flags: EPH }); return true; }
  const guildId = interaction.guildId; const userId = interaction.user.id;

  if (!action) { await openMain(interaction); return true; }
  if (action === 'view') { await showDetail(interaction, interaction.values[0]); return true; }
  if (action === 'v') { await showDetail(interaction, a1); return true; }
  if (action === 'new') {
    await interaction.showModal(new ModalBuilder().setCustomId('minako-mm:team:new-modal').setTitle('Criar equipe').addComponents(row(new TextInputBuilder().setCustomId('name').setLabel(`Nome (${teams.LIMITS.nameMin} a ${teams.LIMITS.nameMax} caracteres)`).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex.: Os Lendários'))));
    return true;
  }
  if (action === 'new-modal') {
    try { const t = await tstore.createTeam(guildId, userId, interaction.fields.getTextInputValue('name')); const d = await tstore.getTeamDetail(guildId, t.id); await interaction.update(U(detailPanel(d, userId, {}, `✅ Equipe **${t.name}** criada! Convide quem você quiser jogar com frequência.`))); }
    catch (e) { if (known(e)) await interaction.reply({ content: `🚫 ${errMsg(e)}`, flags: EPH }); else throw e; }
    return true;
  }
  if (action === 'invite') { const target = interaction.values[0]; const text = await sendInvite(interaction.client, guildId, a1, userId, { id: target, bot: Boolean(interaction.users?.get?.(target)?.bot) }); await showDetail(interaction, a1, text); return true; }
  if (action === 'remove') {
    try { const ok = await tstore.removeMember(guildId, a1, userId, interaction.values[0]); await showDetail(interaction, a1, ok ? '✅ Removido da equipe. Sem penalidade.' : 'Essa pessoa já não estava na equipe.'); }
    catch (e) { if (known(e)) await showDetail(interaction, a1, `🚫 ${errMsg(e)}`); else throw e; }
    return true;
  }
  if (action === 'leave') {
    try { const r = await tstore.leaveTeam(guildId, a1, userId); const msg = r.action === 'disband' ? 'Você era o último membro, então a equipe foi dissolvida.' : r.action === 'transfer' ? `Você saiu. A liderança passou para <@${r.newOwnerId}>.` : 'Você saiu da equipe. Sem penalidade.'; await interaction.update(U(mainPanel(await tstore.listMyTeams(guildId, userId), {}, `🚪 ${msg}`))); }
    catch (e) { if (known(e)) await interaction.update(U(mainPanel(await tstore.listMyTeams(guildId, userId), {}, `🚫 ${errMsg(e)}`))); else throw e; }
    return true;
  }
  if (action === 'disband') {
    await interaction.update(U(box('## 🗑️ Dissolver equipe\nIsso encerra a equipe para todos os membros. Sessões em andamento continuam normalmente como grupos.', [row(btn(`minako-mm:team:disband-ok:${a1}`, 'Sim, dissolver', '🗑️', ButtonStyle.Danger), btn(`minako-mm:team:v:${a1}`, 'Cancelar', '↩️'))])));
    return true;
  }
  if (action === 'disband-ok') {
    try { await tstore.disbandTeam(guildId, a1, userId); await notify.closeOps(interaction.client, guildId, 'tinv', `${a1}:`, { prefix: true, text: 'A equipe foi dissolvida.' }); await interaction.update(U(mainPanel(await tstore.listMyTeams(guildId, userId), {}, '🗑️ Equipe dissolvida.'))); }
    catch (e) { if (known(e)) await interaction.update(U(mainPanel(await tstore.listMyTeams(guildId, userId), {}, `🚫 ${errMsg(e)}`))); else throw e; }
    return true;
  }
  if (action === 'ia' || action === 'id') {
    const gid = interaction.guildId || await tstore.teamGuildId(a1);
    const r = await answerInvite(interaction.client, a1, userId, action === 'ia', { exceptMessageId: interaction.message?.id });
    if (interaction.guildId) { await interaction.update(U(mainPanel(await tstore.listMyTeams(gid, userId), {}, r.text))); return true; }
    const inv = r.team ? { id: r.team.id, name: r.team.name } : { id: a1, name: 'equipe' };
    await interaction.update(U(r.ok ? invitePayload(inv, r.team?.ownerId || '', Date.now(), r.state === 'active' ? 'active' : r.state === 'declined' ? 'declined' : r.state || 'expired') : box(r.text)));
    return true;
  }
  if (action === 'play' || action === 'pm' || action === 'pj') {
    const d = await tstore.getTeamDetail(guildId, a1); const cfg = await store.getSettings(guildId);
    if (!d || d.status !== 'active') { await showDetail(interaction, a1); return true; }
    const sel = action === 'play' ? { mode: null, jm: 'a' } : action === 'pm' ? { mode: interaction.values[0], jm: a2 } : { mode: a2, jm: interaction.values[0] };
    await interaction.update(U(sessionPanel(d, cfg, sel))); return true;
  }
  if (action === 'go') { await startSession(interaction, a1, a2, a3); return true; }
  if (action === 'yes' || action === 'no') { await answerSession(interaction, a1, action); return true; }
  return false;
}

// ---------- Agendador ----------
async function sweeps(client) {
  const expired = await tstore.sweepReservations();
  const byGroup = new Map();
  for (const r of expired) { if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, { ...r, users: [] }); byGroup.get(r.groupId).users.push(r.userId); }
  for (const g of byGroup.values()) {
    for (const u of g.users) await notify.closeOps(client, g.guildId, 'resv', `${g.groupId}:${u}`, { text: 'O tempo para confirmar acabou e a vaga foi aberta.' });
    await groupFlow.refreshAnnouncement(client, g.guildId, g.groupId);   // as vagas passam a estar realmente abertas
    await notify.send(client, g.guildId, g.organizerId, 'groups', box(`⌛ ${g.users.map(u => `<@${u}>`).join(', ')} não confirmou(aram) a tempo a sessão **#${g.groupId}**. A(s) vaga(s) agora está(ão) aberta(s) ao público. Sem penalidade.`, [], { eph: false }));
  }
  for (const i of await tstore.sweepTeamInvites()) {
    if (!i.dmMessageId) continue;
    try { const u = await client.users.fetch(i.userId); const dm = await u.createDM(); const m = await dm.messages.fetch(i.dmMessageId); await m.edit(U(invitePayload({ id: i.teamId, name: 'equipe' }, i.invitedBy, Date.now(), 'expired'))); } catch { /* DM indisponível */ }
  }
}

module.exports = { mainPanel, detailPanel, sessionPanel, reservationPayload, invitePayload, handleInteraction, sweeps, sendInvite, answerInvite };
