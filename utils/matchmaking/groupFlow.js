'use strict';
// Grupos: descoberta, criação, entrada direta/aprovação, saída, substituição, anúncio público e tópico privado.
// Decisões de vagas ficam em store/mmCore (transações); aqui só há interface, mensagens e efeitos no Discord.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const db = require('../db');
const store = require('./store');
const core = require('./mmCore');
const view = require('./groupView');
const central = require('./central');
const perms = require('./permissions');
const notify = require('./notify');

const EPH = MessageFlags.Ephemeral; const V2 = MessageFlags.IsComponentsV2;
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });
const box = (text, rows = [], { eph = true } = {}) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (rows.length) { c.addSeparatorComponents(new SeparatorBuilder()); rows.forEach(r => c.addActionRowComponents(r)); }
  return { components: [c], flags: V2 | (eph ? EPH : 0), allowedMentions: { parse: [] } };
};
const row = (...c) => new ActionRowBuilder().addComponents(c);
const btn = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
const isUnknown = (e) => [e?.code, e?.rawError?.code].some(c => c === 10008 || c === 10003);

const ERRORS = {
  GROUP_NOT_OPEN: 'Esse grupo não está mais recebendo pessoas.', ALREADY_MEMBER: 'Você já está nesse grupo.',
  INCOMPATIBLE_COMMITMENT: 'Você já está em outro grupo ativo.', ELO_REQUIREMENT: 'Seu elo está fora da faixa desse grupo.',
  ROLE_REQUIRED: 'Esse grupo precisa que você escolha uma função.', ROLE_UNAVAILABLE: 'Essa função já foi preenchida. Escolha outra.',
  NO_SLOT: 'A última vaga acabou de ser ocupada. 😅 Veja outros grupos abertos.', GROUP_NOT_FOUND: 'Esse grupo não existe mais.',
  NOT_ORGANIZER: 'Apenas o organizador pode fazer isso.', REQUEST_NOT_FOUND: 'Esse pedido não está mais pendente.',
  BELOW_MINIMUM: 'O grupo ainda não atingiu o mínimo de jogadores para começar.', INCOMPLETE_NOT_ALLOWED: 'Esse grupo não aceita começar incompleto.',
  BAD_STATE: 'Isso não é possível no estado atual do grupo.', NOT_MEMBER: 'Você não está nesse grupo.',
};
const errText = (e) => ERRORS[e.code] || null;


// ---------- Anúncio público ----------
function announcementPayload(group, modeLabel) {
  const text = view.renderAnnouncement(group, modeLabel);
  const live = ['open', 'searching_replacement'].includes(group.state);
  const join = btn(`minako-mm:g:join:${group.id}`, group.joinMethod === 'approval' ? 'Solicitar vaga' : 'Entrar', '🎮', ButtonStyle.Success);
  if (!view.isJoinable(group) && !(live && group.reserved > 0)) join.setDisabled(true);   // membro da equipe com vaga reservada ainda precisa poder confirmar
  const buttons = [join, btn(`minako-mm:g:leave:${group.id}`, 'Sair', '🚪'), btn(`minako-mm:g:mg:${group.id}`, 'Gerenciar', '⚙️')];
  const c = new ContainerBuilder().setAccentColor(group.state === 'closed' ? 0x777777 : 0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (live || group.state === 'confirmed') c.addActionRowComponents(row(...(live ? buttons : buttons.slice(1))));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
}
async function fetchTextChannel(client, id) {
  try { const ch = await client.channels.fetch(id); return ch?.isTextBased?.() ? ch : null; } catch (e) { if (isUnknown(e)) return null; throw e; }
}
async function publishAnnouncement(client, group) {
  const cfg = await store.getSettings(group.guildId);
  const channel = cfg.groupsChannelId ? await fetchTextChannel(client, cfg.groupsChannelId) : null;
  if (!channel) throw Object.assign(new Error('CHANNEL'), { code: 'NO_GROUPS_CHANNEL' });
  const label = cfg.modes.find(m => m.id === group.modeId)?.label || group.modeId;
  const msg = await channel.send(announcementPayload(group, label));
  await store.setAnnouncement(group.id, channel.id, msg.id);
  return msg;
}
// Reflete o estado real. Se o anúncio sumiu, recria uma vez; se não dá, registra e segue (não trava o módulo).
async function refreshAnnouncement(client, guildId, groupId) {
  const group = await store.getGroup(guildId, groupId); if (!group) return;
  const cfg = await store.getSettings(guildId);
  const label = cfg.modes.find(m => m.id === group.modeId)?.label || group.modeId;
  try {
    const channel = group.announceChannelId ? await fetchTextChannel(client, group.announceChannelId) : null;
    let msg = null;
    if (channel && group.announceMessageId) { try { msg = await channel.messages.fetch({ message: group.announceMessageId, force: true }); } catch (e) { if (!isUnknown(e)) throw e; } }
    if (msg) { try { await msg.edit(announcementPayload(group, label)); } catch (e) { if (!isUnknown(e)) throw e; msg = null; } }
    if (!msg && !['closed', 'completed'].includes(group.state)) await publishAnnouncement(client, { ...group, guildId });
  } catch (e) {
    console.error(`[matchmaking] anúncio do grupo ${groupId}:`, e.message);
    await store.logEvent(guildId, 'group.announcement_failed', { groupId, error: String(e.message).slice(0, 200) }).catch(() => {});
  }
  void central.requestRefresh(client, guildId);
}

// ---------- Tópico privado (um por grupo confirmado; criação idempotente) ----------
async function ensureThread(client, guildId, groupId, { quiet = false } = {}) {
  const group = await store.getGroup(guildId, groupId);
  if (!group || group.state !== 'confirmed' || group.threadId) return group?.threadId || null;
  const cfg = await store.getSettings(guildId);
  const parent = cfg.topicsParentId ? await fetchTextChannel(client, cfg.topicsParentId) : null;
  if (!parent?.threads?.create) { if (!quiet) await store.logEvent(guildId, 'group.thread_unavailable', { groupId, reason: 'NO_PARENT' }); return null; }
  const me = parent.guild?.members?.me; const perms = me && parent.permissionsFor ? parent.permissionsFor(me) : null;
  if (perms && !(perms.has(PermissionFlagsBits.CreatePrivateThreads) && perms.has(PermissionFlagsBits.SendMessagesInThreads))) {
    if (!quiet) await store.logEvent(guildId, 'group.thread_unavailable', { groupId, reason: 'PERMISSIONS' });
    return null;
  }
  const label = cfg.modes.find(m => m.id === group.modeId)?.label || group.modeId;
  const thread = await parent.threads.create({ name: `Grupo #${group.id} · ${label}`.slice(0, 100), type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: 10080 });
  if (!(await store.claimThread(group.id, thread.id))) { await thread.delete().catch(() => {}); return (await store.getGroup(guildId, groupId))?.threadId || null; }
  for (const m of group.members) await thread.members.add(m.userId).catch(() => {});
  await thread.send(box(`## 🎮 Equipe confirmada\n${group.members.map(m => `<@${m.userId}>`).join(' ')}\n\nCombinem aqui o horário e como vão jogar. **Voz é opcional.**\n**Organizador:** <@${group.organizerId}>`, [row(btn(`minako-mm:g:leave:${group.id}`, 'Sair do grupo', '🚪'), btn(`minako-mm:g:mg:${group.id}`, 'Gerenciar', '⚙️')), row(btn(`minako-mm:m:done:${group.id}`, 'Registrar conclusão', '🏁', ButtonStyle.Success), btn(`minako-mm:m:still:${group.id}`, 'Ainda estamos jogando', '🎮'), btn(`minako-mm:m:no:${group.id}`, 'A partida não aconteceu', '🚫'))], { eph: false }));
  return thread.id;
}
async function threadNotice(client, group, text) {
  if (!group.threadId) return;
  try { const th = await client.channels.fetch(group.threadId); await th.send({ content: text, allowedMentions: { parse: [] } }); } catch { /* tópico indisponível: não trava */ }
}
async function addToThread(client, group, userId) {
  if (!group.threadId) return;
  try { const th = await client.channels.fetch(group.threadId); await th.members.add(userId); } catch { /* idem */ }
}

// Avisos operacionais respeitam o destino escolhido por cada pessoa (nunca trocam de canal sem consentimento).
const members = (g) => (g.members || []).map(m => m.userId);
async function notifyGroup(client, guildId, group, userIds, text) {
  for (const uid of [...new Set(userIds)]) await notify.send(client, guildId, uid, 'groups', box(text, [], { eph: false }), { threadId: group.threadId });
}
async function afterJoinNotices(client, guildId, group, joinerId, actorId = null) {
  if (group.state === 'confirmed' && group.free === 0) {
    const where = group.threadId ? `\nEspaço privado: <#${group.threadId}>` : '';
    return notifyGroup(client, guildId, group, members(group).filter(id => id !== joinerId && id !== actorId), `## 🎉 Equipe completa!\nO grupo **#${group.id}** está confirmado.${where}`);
  }
  if (group.organizerId !== joinerId && group.organizerId !== actorId) {
    return notifyGroup(client, guildId, group, [group.organizerId], `👋 <@${joinerId}> entrou no seu grupo **#${group.id}** (${group.confirmed}/${group.capacity}).`);
  }
}

// ---------- Descoberta ----------
async function showGroups(interaction) {
  const cfg = await store.getSettings(interaction.guildId);
  const groups = (await store.listOpenGroups(interaction.guildId)).filter(g => g.free > 0).slice(0, 5);
  if (!groups.length) return interaction.reply(box('## 🔎 Grupos abertos\nNão há grupos com vaga agora. Que tal **Criar grupo** ou **Quero jogar agora**?'));
  const lines = groups.map((g, i) => `**${i + 1}.** ${cfg.modes.find(m => m.id === g.modeId)?.label || g.modeId} — ${g.confirmed}/${g.capacity} · ${g.free} vaga${g.free === 1 ? '' : 's'} · ${g.joinMethod === 'approval' ? 'com aprovação' : 'entrada direta'}`);
  return interaction.reply(box(`## 🔎 Grupos abertos\n${lines.join('\n')}`, [row(...groups.map((g, i) => btn(`minako-mm:g:join:${g.id}`, `${i + 1}`, g.joinMethod === 'approval' ? '📨' : '🎮')))]));
}

// ---------- Entrar / solicitar ----------
function openRoles(group) { const taken = new Set(group.members.map(m => m.role).filter(Boolean)); return (group.requiredRoles || []).filter(r => !taken.has(r)); }
async function startJoin(interaction, groupId) {
  const group = await store.getGroup(interaction.guildId, groupId);
  if (!group) return interaction.reply(box(ERRORS.GROUP_NOT_FOUND));
  const open = openRoles(group);
  if (open.length && open.length >= Math.max(1, group.free)) {
    const sel = new StringSelectMenuBuilder().setCustomId(`minako-mm:g:jr:${groupId}`).setPlaceholder('Escolha a função').addOptions(open.map(r => ({ label: r, value: r })));
    return interaction.reply(box('Esse grupo reserva as vagas restantes para funções específicas. Qual você vai jogar?', [row(sel)]));
  }
  return doJoin(interaction, groupId, null);
}
async function doJoin(interaction, groupId, role) {
  const guildId = interaction.guildId; const userId = interaction.user.id;
  const cfg = await store.getSettings(guildId);
  const group = await store.getGroup(guildId, groupId);
  if (!group) return reply(interaction, box(ERRORS.GROUP_NOT_FOUND));
  const mode = cfg.modes.find(m => m.id === group.modeId) || { eloRelevant: false };
  const profile = await db.loadMatchProfile(guildId, userId).catch(() => null);
  if (mode.eloRelevant && !profile?.current_rank) return reply(interaction, box('Esse grupo usa elo. Complete seu perfil em **Meu perfil** na Central e tente de novo.'));
  let r;
  try { r = await store.requestJoin(guildId, groupId, { userId, elo: profile?.current_rank || null, role }, mode); }
  catch (e) {
    if (e.code === 'NO_SLOT' && group.reserved > 0) return reply(interaction, box('🚫 As vagas restantes estão reservadas para membros da equipe que ainda estão confirmando. Se alguma ficar livre, o anúncio é atualizado. Tente de novo em instantes.'));
    const m = errText(e); if (m) return reply(interaction, box(`🚫 ${m}`)); throw e;
  }
  const after = await refreshAfterChange(interaction.client, guildId, groupId);
  if (r.action === 'pending') {
    const sent = (await notify.send(interaction.client, guildId, r.group.organizerId, 'actions', box(`## 📨 Pedido de entrada\n<@${userId}> quer entrar no seu grupo **#${groupId}**${role ? ` como **${role}**` : ''}.\nO pedido não ocupa vaga até você aprovar.`, [row(
      btn(`minako-mm:g:ap:${groupId}:${userId}`, 'Aprovar', '✅', ButtonStyle.Success), btn(`minako-mm:g:rj:${groupId}:${userId}`, 'Recusar', '✖️'))], { eph: false }), { track: { kind: 'join_req', ref: `${groupId}:${userId}` } })).sent;
    if (!sent) await store.logEvent(guildId, 'group.organizer_dm_failed', { groupId });
    return reply(interaction, box(sent ? '📨 Pedido enviado! O organizador vai decidir. Você será avisado.' : '📨 Pedido registrado, mas não consegui avisar o organizador por mensagem privada. Ele pode aprovar em **Gerenciar** no anúncio.'));
  }
  if (after) await afterJoinNotices(interaction.client, guildId, after, userId);
  await notify.closeOps(interaction.client, guildId, 'resv', `${groupId}:${userId}`, { text: 'Você confirmou pelo anúncio do grupo.' });
  return reply(interaction, box(`✅ Você entrou no grupo **#${groupId}**!${r.group.state === 'confirmed' ? ' Equipe completa — vou criar o espaço privado.' : ''}`));
}
const reply = (i, payload) => (i.isMessageComponent?.() && i.message?.flags?.has?.(EPH) ? i.update(U(payload)) : i.reply(payload));

async function refreshAfterChange(client, guildId, groupId) {
  let group = await store.getGroup(guildId, groupId);
  if (group?.state === 'confirmed' && !group.threadId) {
    try { await ensureThread(client, guildId, groupId); } catch (e) { console.error('[matchmaking] tópico:', e.message); await store.logEvent(guildId, 'group.thread_failed', { groupId, error: String(e.message).slice(0, 200) }).catch(() => {}); }
    group = await store.getGroup(guildId, groupId);
  }
  await refreshAnnouncement(client, guildId, groupId);
  return group;
}

// ---------- Decisão do organizador sobre pedidos ----------
async function decide(interaction, groupId, userId, approve) {
  const guildId = await store.groupGuildId(groupId);
  if (!guildId) return interaction.update(U(box('Esse grupo não existe mais.', [], { eph: false })));
  let r;
  try { r = await store.decideRequest(guildId, groupId, interaction.user.id, userId, approve); }
  catch (e) { const m = errText(e); if (m) return interaction.update(U(box(`🚫 ${m}`, [], { eph: false }))); throw e; }
  await interaction.update(U(box(approve ? `✅ Você aprovou <@${userId}> no grupo **#${groupId}**.` : `Você recusou o pedido de <@${userId}>.`, [], { eph: false })));
  await notify.send(interaction.client, guildId, userId, 'groups', box(approve ? `✅ Seu pedido para o grupo **#${groupId}** foi aprovado!` : `Seu pedido para o grupo **#${groupId}** não foi aceito desta vez. Há outros grupos abertos na Central. ✨`, [], { eph: false }));
  await notify.closeOps(interaction.client, guildId, 'join_req', `${groupId}:${userId}`, { exceptMessageId: interaction.message?.id, text: approve ? 'Pedido aprovado.' : 'Pedido recusado.' });
  const group = await refreshAfterChange(interaction.client, guildId, groupId);
  if (approve && group) { await addToThread(interaction.client, group, userId); await afterJoinNotices(interaction.client, guildId, group, userId, interaction.user.id); }
}

// ---------- Sair ----------
async function leave(interaction, groupId) {
  const guildId = interaction.guildId || await store.groupGuildId(groupId);
  const cfg = await store.getSettings(guildId);
  const before = await store.getGroup(guildId, groupId);
  let r;
  try { r = await store.leaveGroup(guildId, groupId, interaction.user.id, cfg.settings.replacementTtlSec); }
  catch (e) { const m = errText(e); if (m) return reply(interaction, box(`🚫 ${m}`)); throw e; }
  await threadNotice(interaction.client, r.group, `<@${interaction.user.id}> saiu do grupo.${r.searchReplacement ? ' Estou procurando um substituto — a decisão final é do organizador.' : ''}`);
  await notify.closeOps(interaction.client, guildId, 'join_req', `${groupId}:${interaction.user.id}`, { text: 'O pedido foi cancelado pela própria pessoa.' });
  const heir = before?.organizerId === interaction.user.id && r.group.organizerId !== interaction.user.id ? ' Você agora é o organizador.' : '';
  if (r.group.organizerId !== interaction.user.id) await notifyGroup(interaction.client, guildId, r.group, [r.group.organizerId], `🚪 <@${interaction.user.id}> saiu do grupo **#${groupId}** (${r.group.confirmed}/${r.group.capacity}).${r.searchReplacement ? ' Estou procurando um substituto; se ninguém aparecer, a decisão é sua.' : ''}${heir}`);
  await refreshAnnouncement(interaction.client, guildId, groupId);
  return reply(interaction, box('🚪 Você saiu do grupo. Sem penalidade; qualquer hora você volta. ✨'));
}

// ---------- Gerenciar (organizador/administração) ----------
async function manage(interaction, groupId) {
  const guildId = interaction.guildId; const group = await store.getGroup(guildId, groupId);
  if (!group) return interaction.reply(box(ERRORS.GROUP_NOT_FOUND));
  if (group.organizerId !== interaction.user.id && !(await perms.can(interaction, 'group.manage'))) return interaction.reply(box('🚫 Apenas o organizador (ou a equipe de moderação) pode gerenciar este grupo.'));
  const cfg = await store.getSettings(guildId); const mode = cfg.modes.find(m => m.id === group.modeId);
  const rows = [];
  const b = [];
  if (group.state === 'open' && group.allowIncomplete && group.confirmed >= (mode?.minSize || 2)) b.push(btn(`minako-mm:g:start:${groupId}`, 'Começar assim', '▶️', ButtonStyle.Success));
  if (group.state === 'searching_replacement') {
    if (group.allowIncomplete) b.push(btn(`minako-mm:g:rd:${groupId}:c`, 'Continuar com menos', '▶️'));
    b.push(btn(`minako-mm:g:rd:${groupId}:e`, 'Procurar mais', '🔄'));
  }
  if (group.state === 'confirmed') b.push(btn(`minako-mm:m:done:${groupId}`, 'Registrar conclusão', '🏁', ButtonStyle.Success), btn(`minako-mm:m:still:${groupId}`, 'Ainda estamos jogando', '🎮'), btn(`minako-mm:m:no:${groupId}`, 'A partida não aconteceu', '🚫'));
  if (!['closed', 'completed'].includes(group.state)) b.push(btn(`minako-mm:g:close:${groupId}`, 'Encerrar grupo', '⏹️', ButtonStyle.Danger));
  for (let i = 0; i < b.length; i += 5) rows.push(row(...b.slice(i, i + 5)));
  const pend = group.pending?.length ? `\n\n**Pedidos pendentes:** ${group.pending.map(id => `<@${id}>`).join(', ')}` : '';
  const pendRows = (group.pending || []).slice(0, 3).map(id => row(btn(`minako-mm:g:ap:${groupId}:${id}`, 'Aprovar', '✅', ButtonStyle.Success), btn(`minako-mm:g:rj:${groupId}:${id}`, 'Recusar', '✖️')));
  return interaction.reply(box(`## ⚙️ Gerenciar grupo #${groupId}\nEstado: **${group.state}** · ${group.confirmed}/${group.capacity}${pend}`, [...rows, ...pendRows].slice(0, 4)));
}
async function startNow(interaction, groupId) {
  const guildId = interaction.guildId; const cfg = await store.getSettings(guildId);
  const g0 = await store.getGroup(guildId, groupId); const mode = cfg.modes.find(m => m.id === g0?.modeId);
  try { await store.startIncomplete(guildId, groupId, interaction.user.id, mode?.minSize || 2); }
  catch (e) { const m = errText(e); if (m) return interaction.update(U(box(`🚫 ${m}`))); throw e; }
  await refreshAfterChange(interaction.client, guildId, groupId);
  return interaction.update(U(box('▶️ Grupo iniciado com quem está confirmado. Criei o espaço privado para vocês.')));
}
async function replacementDecision(interaction, groupId, d) {
  const guildId = interaction.guildId || await store.groupGuildId(groupId); const cfg = await store.getSettings(guildId);
  const kind = { c: 'continue', e: 'extend', x: 'close' }[d];
  try { await store.replacementDecision(guildId, groupId, interaction.user.id, kind, cfg.settings.replacementTtlSec); }
  catch (e) { const m = errText(e); if (m) return interaction.update(U(box(`🚫 ${m}`, [], { eph: false }))); throw e; }
  const group = await refreshAfterChange(interaction.client, guildId, groupId);
  if (group) await threadNotice(interaction.client, group, { c: 'O organizador decidiu continuar com menos jogadores.', e: 'O organizador decidiu procurar mais um pouco.', x: 'O organizador encerrou o grupo.' }[d]);
  await notify.closeOps(interaction.client, guildId, 'repl', groupId, { exceptMessageId: interaction.message?.id, text: 'A decisão já foi tomada.' });
  return interaction.update(U(box({ c: '▶️ Seguindo com menos jogadores.', e: '🔄 Vou procurar mais um pouco.', x: '⏹️ Grupo encerrado.' }[d], [], { eph: false })));
}
async function closeNow(interaction, groupId) {
  const guildId = interaction.guildId; const g = await store.getGroup(guildId, groupId);
  if (!g) return interaction.update(U(box(ERRORS.GROUP_NOT_FOUND)));
  if (g.organizerId !== interaction.user.id && !(await perms.can(interaction, 'group.manage'))) return interaction.update(U(box('🚫 Apenas o organizador (ou a equipe de moderação) pode encerrar.')));
  const cfg = await store.getSettings(guildId);
  await store.closeGroupById(guildId, groupId, cfg.settings.archiveAfterSec);
  const group = await store.getGroup(guildId, groupId);
  await threadNotice(interaction.client, group, '⏹️ Este grupo foi encerrado. O tópico será arquivado em breve.');
  await notifyGroup(interaction.client, guildId, group, members(group).filter(id => id !== interaction.user.id), `⏹️ O grupo **#${groupId}** foi encerrado. Ninguém foi penalizado.`);
  await notify.closeOps(interaction.client, guildId, 'join_req', `${groupId}:`, { prefix: true, text: 'O grupo foi encerrado.' });
  await notify.closeOps(interaction.client, guildId, 'repl', groupId, { text: 'O grupo foi encerrado.' });
  await refreshAnnouncement(interaction.client, guildId, groupId);
  return interaction.update(U(box('⏹️ Grupo encerrado. Sem penalidade para ninguém.')));
}

// ---------- Criar grupo ----------
const encCreate = (s) => `${s.mode}:${s.size}:${s.jm}:${s.inc}:${s.roles.length ? s.roles.join('.') : '-'}`;
function decCreate(parts) {
  const [mode, size, jm, inc, roles] = parts;
  return { mode, size: Number(size) || 5, jm: jm === 'a' ? 'a' : 'd', inc: inc === '1' ? '1' : '0', roles: !roles || roles === '-' ? [] : roles.split('.').map(Number).filter(Number.isInteger) };
}
function createPanel(cfg, s, elo) {
  const mode = cfg.modes.find(m => m.id === s.mode && m.active) || cfg.modes.find(m => m.active) || cfg.modes[0];
  const size = Math.min(mode.idealSize, Math.max(2, s.size)); const st = { ...s, mode: mode.id, size, inc: mode.allowIncomplete ? s.inc : '0', roles: s.roles.filter(i => cfg.settings.roleCatalog[i]).slice(0, Math.max(0, size - 1)) };
  const catalog = cfg.settings.roleCatalog; const key = encCreate(st);
  const idx = core.rankIndex(elo);
  const range = mode.eloRelevant && idx >= 0 ? `${view.rankName(Math.max(0, idx - mode.eloWindow))} a ${view.rankName(Math.min(core.RANKS.length - 1, idx + mode.eloWindow))}` : null;
  const needsElo = mode.eloRelevant && idx < 0;
  const text = `## ➕ Criar grupo\n**Modo:** ${mode.label}\n**Tamanho:** ${size} jogadores\n**Entrada:** ${st.jm === 'a' ? 'mediante aprovação' : 'direta'}\n**Começar incompleto:** ${st.inc === '1' ? 'permitido' : 'não'}\n**Funções necessárias:** ${st.roles.map(i => catalog[i]).join(', ') || 'nenhuma (vagas flexíveis)'}${range ? `\n**Faixa de elo:** ${range}` : ''}${needsElo ? '\n⚠️ Este modo usa elo. Complete seu perfil em **Meu perfil** antes de criar.' : ''}`;
  const modeSel = new StringSelectMenuBuilder().setCustomId(`minako-mm:create:m:${key}`).setPlaceholder('Modo').addOptions(cfg.modes.filter(m => m.active).map(m => ({ label: m.label, value: m.id, default: m.id === mode.id })));
  const sizes = []; for (let n = 2; n <= mode.idealSize; n++) sizes.push({ label: `${n} jogadores`, value: String(n), default: n === size });
  const sizeSel = new StringSelectMenuBuilder().setCustomId(`minako-mm:create:s:${key}`).setPlaceholder('Tamanho').addOptions(sizes);
  const joinSel = new StringSelectMenuBuilder().setCustomId(`minako-mm:create:j:${key}`).setPlaceholder('Método de entrada').addOptions([{ label: 'Entrada direta', value: 'd', default: st.jm === 'd' }, { label: 'Mediante aprovação', value: 'a', default: st.jm === 'a' }]);
  const roleSel = new StringSelectMenuBuilder().setCustomId(`minako-mm:create:r:${key}`).setPlaceholder('Funções necessárias (opcional)').setMinValues(0).setMaxValues(Math.max(1, Math.min(5, catalog.length, size - 1)))
    .addOptions(catalog.map((n, i) => ({ label: n, value: String(i), default: st.roles.includes(i) })));
  const ok = btn(`minako-mm:create:ok:${key}`, 'Criar e publicar', '✅', ButtonStyle.Success); if (needsElo) ok.setDisabled(true);
  const actions = [ok]; if (mode.allowIncomplete) actions.push(btn(`minako-mm:create:i:${key}`, st.inc === '1' ? 'Exigir grupo completo' : 'Permitir incompleto', '↔️'));
  actions.push(btn('minako-mm:create:x', 'Cancelar', '✖️'));
  return box(text, [row(modeSel), row(sizeSel), row(joinSel), row(roleSel), row(...actions)].slice(0, 5));
}
async function showCreate(interaction) {
  const cfg = await store.getSettings(interaction.guildId);
  if (!cfg.groupsChannelId) return interaction.reply(box('🚫 A administração ainda não configurou o canal de grupos abertos. Avise a equipe. 🙏'));
  const profile = await db.loadMatchProfile(interaction.guildId, interaction.user.id).catch(() => null);
  const first = cfg.modes.find(m => m.active) || cfg.modes[0];
  return interaction.reply(createPanel(cfg, { mode: first.id, size: first.idealSize, jm: 'd', inc: '0', roles: [] }, profile?.current_rank || null));
}
async function handleCreate(interaction, action, rest) {
  const cfg = await store.getSettings(interaction.guildId);
  const profile = await db.loadMatchProfile(interaction.guildId, interaction.user.id).catch(() => null); const elo = profile?.current_rank || null;
  if (action === 'x') return interaction.update(U(box('Cancelado. ✨')));
  let s = decCreate(rest);
  if (action === 'm') s = { ...s, mode: interaction.values[0], size: (cfg.modes.find(m => m.id === interaction.values[0])?.idealSize) || s.size };
  if (action === 's') s.size = Number(interaction.values[0]);
  if (action === 'j') s.jm = interaction.values[0];
  if (action === 'r') s.roles = interaction.values.map(Number);
  if (action === 'i') s.inc = s.inc === '1' ? '0' : '1';
  if (action !== 'ok') return interaction.update(U(createPanel(cfg, s, elo)));
  const mode = cfg.modes.find(m => m.id === s.mode && m.active);
  if (!mode) return interaction.update(U(box('Esse modo não está mais disponível.')));
  const channel = cfg.groupsChannelId ? await fetchTextChannel(interaction.client, cfg.groupsChannelId) : null;
  const me = channel?.guild?.members?.me; const perms = me && channel?.permissionsFor ? channel.permissionsFor(me) : null;
  if (!channel || (perms && !(perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages)))) return interaction.update(U(box('🚫 Não consigo publicar no canal de grupos abertos. Avise a administração para conferir minhas permissões.')));
  const idx = core.rankIndex(elo);
  const eloRange = mode.eloRelevant && idx >= 0 ? [Math.max(0, idx - mode.eloWindow), Math.min(core.RANKS.length - 1, idx + mode.eloWindow)] : null;
  let groupId;
  try {
    groupId = await store.createGroup(interaction.guildId, { modeId: mode.id, organizerId: interaction.user.id, capacity: Math.min(mode.idealSize, Math.max(2, s.size)), joinMethod: s.jm === 'a' ? 'approval' : 'direct',
      allowIncomplete: mode.allowIncomplete && s.inc === '1', eloRange, requiredRoles: s.roles.map(i => cfg.settings.roleCatalog[i]).filter(Boolean) });
  } catch (e) { const m = errText(e); if (m) return interaction.update(U(box(`🚫 ${m}`))); throw e; }
  try { await publishAnnouncement(interaction.client, { ...(await store.getGroup(interaction.guildId, groupId)), guildId: interaction.guildId }); }
  catch (e) { console.error('[matchmaking] publicar anúncio:', e.message); await store.logEvent(interaction.guildId, 'group.announcement_failed', { groupId, error: String(e.message).slice(0, 200) }).catch(() => {}); }
  void central.requestRefresh(interaction.client, interaction.guildId);
  return interaction.update(U(box(`✅ Grupo **#${groupId}** criado e publicado em <#${cfg.groupsChannelId}>.`)));
}

// ---------- Agendador: substituição vencida e arquivamento ----------
async function sweeps(client) {
  for (const g of await store.sweepInactiveGroups()) {
    await refreshAnnouncement(client, g.guildId, g.groupId);
    const closed = await store.getGroup(g.guildId, g.groupId);
    const text = `## ⏹️ Grupo encerrado por inatividade\nO grupo **#${g.groupId}** ficou sem movimento e foi encerrado. Ninguém foi penalizado. Quando quiser, é só criar outro em **Criar grupo**.`;
    const sent = (await notify.send(client, g.guildId, g.organizerId, 'groups', box(text, [], { eph: false }), { threadId: closed?.threadId })).sent;
    if (closed) await notifyGroup(client, g.guildId, closed, members(closed).filter(id => id !== g.organizerId), `⏹️ O grupo **#${g.groupId}** foi encerrado por inatividade. Ninguém foi penalizado.`);
    await notify.closeOps(client, g.guildId, 'join_req', `${g.groupId}:`, { prefix: true, text: 'O grupo foi encerrado por inatividade.' });
    if (!sent) await store.logEvent(g.guildId, 'group.organizer_dm_failed', { groupId: g.groupId });
  }
  for (const g of await store.listReplacementDue()) {
    if (!(await store.markReplacementNotified(g.groupId))) continue; // só uma instância/ciclo avisa
    const group = await store.getGroup(g.guildId, g.groupId); if (!group || group.state !== 'searching_replacement') continue;
    const cfg = await store.getSettings(g.guildId); const mode = cfg.modes.find(m => m.id === group.modeId);
    const b = []; if (group.allowIncomplete && group.confirmed >= (mode?.minSize || 2)) b.push(btn(`minako-mm:g:rd:${g.groupId}:c`, 'Continuar com menos', '▶️'));
    b.push(btn(`minako-mm:g:rd:${g.groupId}:e`, 'Procurar mais', '🔄'), btn(`minako-mm:g:rd:${g.groupId}:x`, 'Encerrar grupo', '⏹️', ButtonStyle.Danger));
    const payload = box(`## 🔄 Ninguém entrou a tempo\nO prazo de busca por substituto do grupo **#${g.groupId}** acabou. O que você prefere?`, [row(...b)], { eph: false });
    const sent = (await notify.send(client, g.guildId, group.organizerId, 'actions', payload, { threadId: group.threadId, track: { kind: 'repl', ref: g.groupId } })).sent;
    if (!sent && group.threadId) await threadNotice(client, group, `<@${group.organizerId}> o prazo de substituto acabou — abra **Gerenciar** no anúncio para decidir.`);
    if (!sent) await store.logEvent(g.guildId, 'group.organizer_dm_failed', { groupId: g.groupId });
  }
  for (const g of await store.listArchiveDue()) {
    try { if (g.threadId) { const th = await client.channels.fetch(g.threadId); await th.setArchived(true); } await store.markArchived(g.groupId); }
    catch (e) { if (isUnknown(e)) await store.markArchived(g.groupId); else console.error('[matchmaking] arquivar tópico:', e.message); }
  }
}

// Reconciliação periódica: grupos vivos conferidos a cada ~5 min (lote reivindicado no banco, seguro com 2 instâncias).
// Conserta o que um evento perdido, uma queda ou uma permissão temporária deixou pela metade.
async function reconcile(client) {
  for (const g of await store.claimReconcileBatch()) {
    try {
      if (g.state === 'confirmed' && !g.threadId) await ensureThread(client, g.guildId, g.groupId, { quiet: true });
      if (g.announceMessageId) await refreshAnnouncement(client, g.guildId, g.groupId);
    } catch (e) { console.error(`[matchmaking] reconciliação do grupo ${g.groupId}:`, e.message); }
  }
}

async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:')) return false;
  const [, kind, action, ...rest] = id.split(':');
  if (kind === 'groups') { await showGroups(interaction); return true; }
  if (kind === 'create') { if (!action) await showCreate(interaction); else await handleCreate(interaction, action, rest); return true; }
  if (kind !== 'g') return false;
  const gid = rest[0];
  if (action === 'join') { await startJoin(interaction, gid); return true; }
  if (action === 'jr') { await doJoin(interaction, gid, interaction.values[0]); return true; }
  if (action === 'leave') { await leave(interaction, gid); return true; }
  if (action === 'mg') { await manage(interaction, gid); return true; }
  if (action === 'start') { await startNow(interaction, gid); return true; }
  if (action === 'close') { await closeNow(interaction, gid); return true; }
  if (action === 'rd') { await replacementDecision(interaction, gid, rest[1]); return true; }
  if (action === 'ap' || action === 'rj') { await decide(interaction, gid, rest[1], action === 'ap'); return true; }
  return false;
}

module.exports = { refreshAfterChange, afterJoinNotices, announcementPayload, publishAnnouncement, refreshAnnouncement, ensureThread, sweeps, reconcile, handleInteraction, createPanel, encCreate, decCreate };
