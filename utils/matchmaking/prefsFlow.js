'use strict';
// "⚙️ Minhas preferências": só seções implementadas (briefing: não prometer o que não existe).
//  Perfil e privacidade -> painel existente do /minako-match · Preferências de jogo · Disponibilidade · Notificações
// Cada alteração é salva na hora. Mudar notificações NUNCA encerra busca nem disponibilidade.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');
const store = require('./store');
const core = require('./mmCore');
const sstore = require('./socialStore');
const socialFlow = require('./socialFlow');
const social = require('./social');
const rstore = require('./reliabilityStore');
const rflow = require('./reliabilityFlow');
const relCore = require('./reliability');
const policy = require('./notifyPolicy');
const parseCfg = require('./configParse');

const EPH = MessageFlags.Ephemeral; const V2 = MessageFlags.IsComponentsV2;
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });
const row = (...c) => new ActionRowBuilder().addComponents(c);
const SECTIONS = [['play', 'Preferências de jogo', '🎮', 'Modo, funções e voz padrão.'], ['avail', 'Disponibilidade', '🟢', 'Aviso antes de expirar.'], ['notif', 'Notificações', '🔔', 'Onde receber cada tipo de aviso.'], ['engage', 'Avisos de engajamento', '🌙', 'Pausa, horário silencioso e resumos.'], ['fav', 'Favoritos', '⭐', 'Lista privada, só sua.'], ['partners', 'Parceiros', '🤝', 'Parcerias recorrentes (mútuas).'], ['hist', 'Meu histórico', '📋', 'Só você e a administração veem.']];
const VOICE = { y: 'Prefiro voz', n: 'Sem voz', a: 'Tanto faz' };
const DEST = { dm: 'Mensagem privada', thread: 'Tópico do grupo', off: 'Não avisar' };
const DEST2 = { ...DEST, daily: 'Todo dia, às 19h', weekly: 'Toda sexta, às 19h' };
const PAUSES = [['0', 'Retomar / não pausar'], ['1', 'Pausar por 1 hora'], ['8', 'Pausar por 8 horas'], ['24', 'Pausar por 24 horas'], ['168', 'Pausar por 7 dias']];
const QUIETS = [['none', 'Sem horário silencioso'], ['22-8', 'Das 22h às 8h'], ['23-7', 'Das 23h às 7h'], ['0-9', 'Da meia-noite às 9h'], ['custom', 'Personalizar…']];
const VIS = { partners: 'Só meus parceiros', none: 'Ninguém', favorites: 'Parceiros e quem me favoritou (sem revelar quem)' };
const CATEGORY = { actions: ['Propostas e pedidos que precisam da sua resposta', 'Propostas de equipe, pedidos de entrada e decisões de substituição.'], groups: ['Movimentação dos seus grupos', 'Entradas, saídas, equipe completa e encerramentos.'] };

function shell(text, rows) {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text)).addSeparatorComponents(new SeparatorBuilder());
  rows.forEach(r => c.addActionRowComponents(r));
  return { components: [c], flags: V2 | EPH, allowedMentions: { parse: [] } };
}
const secRow = (current) => row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:sec').setPlaceholder('Trocar de seção')
  .addOptions(SECTIONS.map(([value, label, emoji, description]) => ({ value, label, emoji, description, default: value === current }))));
const profileBtn = () => new ButtonBuilder().setCustomId('minako-mm:prefs:profile').setLabel('Perfil e privacidade').setEmoji('👤').setStyle(ButtonStyle.Secondary);
const issueNote = (p) => (p.deliveryIssue ? `\n\n⚠️ Não consegui te avisar por **${p.deliveryIssue.via === 'thread' ? 'tópico' : 'mensagem privada'}** <t:${Math.floor(p.deliveryIssue.at / 1000)}:R>. Confira se suas DMs do servidor estão liberadas ou escolha outro destino. Eu nunca troco de canal sem você autorizar.` : '');

function render(section, cfg, prefs, notice = '', ctx = {}) {
  const n = notice ? `\n\n${notice}` : '';
  if (section === 'play') {
    const play = prefs.play || { mode: null, roles: [], voice: 'a' };
    const mode = cfg.modes.find(m => m.id === play.mode && m.active) || null;
    const catalog = cfg.settings.roleCatalog;
    const modeSel = new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:play-mode').setPlaceholder('Modo padrão').addOptions(cfg.modes.filter(m => m.active).map(m => ({ label: m.label, value: m.id, default: m.id === mode?.id })));
    const roleSel = new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:play-roles').setPlaceholder('Funções que você joga').setMinValues(0).setMaxValues(Math.min(5, catalog.length))
      .addOptions(catalog.map(name => ({ label: name, value: name, default: play.roles.includes(name) })));
    const voiceSel = new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:play-voice').setPlaceholder('Voz').addOptions(Object.entries(VOICE).map(([value, label]) => ({ label, value, default: value === play.voice })));
    return shell(`## ⚙️ Minhas preferências · Jogo\nEsses padrões já vêm preenchidos em **Quero jogar agora**.\n**Modo:** ${mode?.label || 'sem padrão'}\n**Funções:** ${play.roles.join(', ') || 'qualquer uma'}\n**Voz:** ${VOICE[play.voice]}${n}`, [row(modeSel), row(roleSel), row(voiceSel), row(profileBtn()), secRow('play')]);
  }
  if (section === 'fav') {
    const favs = ctx.favorites || [];
    const rows = [row(new UserSelectMenuBuilder().setCustomId('minako-mm:prefs:fav-add').setPlaceholder('Adicionar um favorito').setMinValues(1).setMaxValues(1))];
    if (favs.length) rows.push(row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:fav-del').setPlaceholder('Remover um favorito').addOptions(favs.slice(0, 25).map(id => ({ label: (ctx.labels?.[id] || `Usuário …${String(id).slice(-4)}`).slice(0, 100), value: id })))));
    rows.push(row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:notif:favorites').setPlaceholder('Avisar quando um favorito ficar disponível').addOptions(core.NOTIF_OPTIONS.favorites.map(v => ({ label: DEST[v], value: v, default: prefs.notif.favorites === v })))));
    rows.push(row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:vis').setPlaceholder('Quem pode ser avisado quando EU ficar disponível').addOptions(core.VISIBILITY_OPTIONS.map(v => ({ label: VIS[v], value: v, default: prefs.visibility === v })))));
    rows.push(secRow('fav'));
    return shell(`## ⚙️ Minhas preferências · Favoritos\nSua lista é **privada**: ninguém é avisado de que você favoritou e eu nunca revelo quem favoritou quem.\n**Seus favoritos (${favs.length}/${social.LIMITS.maxFavorites}):** ${favs.length ? favs.map(id => `<@${id}>`).join(', ') : 'nenhum ainda'}\n**Avisos de favoritos disponíveis:** ${DEST[prefs.notif.favorites]}\n**Quem pode ser avisado quando eu ficar disponível:** ${VIS[prefs.visibility]}${n}`, rows);
  }
  if (section === 'partners') {
    const partners = ctx.partners || []; const incoming = ctx.incoming || []; const avail = ctx.available || new Set();
    const rows = [row(new UserSelectMenuBuilder().setCustomId('minako-mm:prefs:par-invite').setPlaceholder('Convidar alguém para ser parceiro').setMinValues(1).setMaxValues(1))];
    if (incoming.length) rows.push(row(...incoming.slice(0, 2).flatMap(i => [
      new ButtonBuilder().setCustomId(`minako-mm:prefs:par-yes:${i.id}`).setLabel(`Aceitar ${(ctx.labels?.[i.from] || 'convite').slice(0, 18)}`).setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`minako-mm:prefs:par-no:${i.id}`).setLabel('Recusar').setEmoji('✖️').setStyle(ButtonStyle.Secondary)])));
    if (partners.length) rows.push(row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:par-end').setPlaceholder('Encerrar uma parceria').addOptions(partners.slice(0, 25).map(p => ({ label: (ctx.labels?.[p.partnerId] || `Usuário …${String(p.partnerId).slice(-4)}`).slice(0, 100), value: p.partnerId })))));
    rows.push(row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:notif:partners').setPlaceholder('Avisar quando um parceiro ficar disponível').addOptions(core.NOTIF_OPTIONS.partners.map(v => ({ label: DEST[v], value: v, default: prefs.notif.partners === v })))));
    rows.push(secRow('partners'));
    const list = partners.length ? partners.map(p => `<@${p.partnerId}>${avail.has(p.partnerId) ? ' 🟢' : ''}`).join(', ') : 'nenhum ainda';
    const inc = incoming.length ? `\n**Convites recebidos:** ${incoming.map(i => `<@${i.from}>`).join(', ')}` : '';
    return shell(`## ⚙️ Minhas preferências · Parceiros\nParceria só existe quando **os dois** querem. Qualquer um encerra quando quiser, sem penalidade.\n**Parceiros (${partners.length}/${social.LIMITS.maxPartners}):** ${list}${inc}\n**Convites enviados aguardando:** ${(ctx.outgoing || []).length}\n**Avisos de parceiros disponíveis:** ${DEST[prefs.notif.partners]}\n-# 🟢 = disponível agora (só aparece se a pessoa permite).${n}`, rows);
  }
  if (section === 'hist') {
    const ov = ctx.overview || { summary: relCore.summarize([], Date.now()), recent: [] };
    const reviewable = ov.recent.filter(r => r.status === 'active' && !r.disputedAt).slice(0, 10);
    const rows = [];
    if (reviewable.length) rows.push(row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:hist-dispute').setPlaceholder('Pedir revisão de um registro').addOptions(reviewable.map(r => ({ label: `#${r.id} · ${relCore.LABEL[r.kind]}`.slice(0, 100), value: r.id, description: r.groupId ? `grupo #${r.groupId}` : undefined })))));
    rows.push(secRow('hist'));
    return shell(`## ⚙️ Minhas preferências · Meu histórico\n${rflow.overviewText(ov)}${n}`, rows);
  }
  if (section === 'engage') {
    const paused = policy.isPaused(prefs, Date.now());
    const quietKey = prefs.quiet ? `${prefs.quiet.from}-${prefs.quiet.to}` : 'none';
    const quietText = prefs.quiet ? `das ${prefs.quiet.from}h às ${prefs.quiet.to}h` : 'sem horário silencioso';
    const rows = [
      row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:pause').setPlaceholder('Pausa geral dos avisos de engajamento').addOptions(PAUSES.map(([value, label]) => ({ label, value, default: value === '0' && !paused })))),
      row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:quiet').setPlaceholder('Horário silencioso').addOptions(QUIETS.map(([value, label]) => ({ label, value, default: value === quietKey || (value === 'custom' && prefs.quiet && !QUIETS.some(q => q[0] === quietKey)) })))),
      row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:notif:community').setPlaceholder('Alertas de atividade da comunidade').addOptions(core.NOTIF_OPTIONS.community.map(v => ({ label: v === 'dm' ? 'Avisar por mensagem privada' : 'Não avisar', value: v, default: prefs.notif.community === v })))),
      row(new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:notif:digest').setPlaceholder('Resumo de oportunidades').addOptions(core.NOTIF_OPTIONS.digest.map(v => ({ label: { off: 'Não receber resumo', daily: DEST2.daily, weekly: DEST2.weekly }[v], value: v, default: prefs.notif.digest === v })))),
      secRow('engage')];
    return shell(`## ⚙️ Minhas preferências · Avisos de engajamento\n**Pausa geral:** ${paused ? `até <t:${Math.floor(prefs.pausedUntil / 1000)}:f>` : 'desligada'}\n**Horário silencioso:** ${quietText} (fuso de Brasília)\n**Alertas de atividade:** ${prefs.notif.community === 'dm' ? 'por mensagem privada' : 'desligados'}\n**Resumo de oportunidades:** ${{ off: 'desligado', daily: DEST2.daily, weekly: DEST2.weekly }[prefs.notif.digest]} (só é enviado se houver algo útil)\n\nAvisos de **parceiros e favoritos** têm as próprias opções nas seções Parceiros e Favoritos, e também respeitam pausa e horário silencioso.\n-# Propostas, pedidos e decisões que precisam da sua resposta **não são afetados** por pausa nem horário silencioso. Mudar isto nunca encerra sua busca nem sua disponibilidade.${n}`, rows);
  }
  if (section === 'avail') {
    const sel = new StringSelectMenuBuilder().setCustomId('minako-mm:prefs:expiry').setPlaceholder('Aviso de expiração').addOptions([
      { label: 'Não avisar', value: 'off', default: prefs.notif.expiry === 'off' }, { label: `Avisar ${core.EXPIRY_WARNING_SEC / 60} min antes (mensagem privada)`, value: 'dm', default: prefs.notif.expiry === 'dm' }]);
    return shell(`## ⚙️ Minhas preferências · Disponibilidade\nSua disponibilidade expira sozinha depois de um tempo. Você escolhe se quer um aviso antes de ela acabar, com botão para renovar.\n**Aviso de expiração:** ${prefs.notif.expiry === 'dm' ? `${core.EXPIRY_WARNING_SEC / 60} min antes, por mensagem privada` : 'desligado'}${issueNote(prefs)}${n}`, [row(sel), secRow('avail')]);
  }
  const rows = Object.keys(CATEGORY).map(cat => row(new StringSelectMenuBuilder().setCustomId(`minako-mm:prefs:notif:${cat}`).setPlaceholder(CATEGORY[cat][0])
    .addOptions(core.NOTIF_OPTIONS[cat].map(v => ({ label: DEST[v], value: v, default: prefs.notif[cat] === v, description: v === 'thread' ? 'Só quando o grupo já tem tópico.' : undefined })))));
  const lines = Object.keys(CATEGORY).map(cat => `**${CATEGORY[cat][0]}:** ${DEST[prefs.notif[cat]]}\n-# ${CATEGORY[cat][1]}`).join('\n');
  const clear = prefs.deliveryIssue ? [row(new ButtonBuilder().setCustomId('minako-mm:prefs:clear-issue').setLabel('Já resolvi, limpar aviso').setEmoji('✅').setStyle(ButtonStyle.Secondary))] : [];
  return shell(`## ⚙️ Minhas preferências · Notificações\n${lines}${issueNote(prefs)}\n\n-# Mudar isso não encerra sua busca nem sua disponibilidade. Se o destino escolhido não funcionar, eu aviso aqui e não uso outro canal sem sua autorização.${n}`, [...rows, ...clear, secRow('notif')].slice(0, 5));
}

async function open(interaction, section = 'play') {
  const [cfg, prefs] = await Promise.all([store.getSettings(interaction.guildId), store.getPrefs(interaction.guildId, interaction.user.id)]);
  return interaction.reply(render(section, cfg, prefs));
}

async function handleInteraction(interaction, { openProfile } = {}) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:prefs')) return false;
  const [, , action, extra] = id.split(':');
  const guildId = interaction.guildId; const userId = interaction.user.id;
  if (!guildId) { await interaction.reply({ content: 'Use isto no servidor.', flags: EPH }); return true; }
  if (!action) { await open(interaction); return true; }
  if (action === 'profile') { if (openProfile) await openProfile(interaction); return true; }
  const labelOf = async (id) => { try { const m = await interaction.guild?.members?.fetch?.(id); return m?.displayName || null; } catch { return null; } };
  const loadCtx = async (section) => {
    if (section === 'fav') { const favorites = await sstore.listFavorites(guildId, userId); const labels = Object.fromEntries(await Promise.all(favorites.slice(0, 25).map(async id => [id, await labelOf(id)]))); return { favorites, labels }; }
    if (section === 'partners') {
      const l = await sstore.listPartnerships(guildId, userId); const available = await sstore.partnersAvailableNow(guildId, userId);
      const ids = [...new Set([...l.partners.map(p => p.partnerId), ...l.incoming.map(i => i.from)])].slice(0, 25);
      return { ...l, available, labels: Object.fromEntries(await Promise.all(ids.map(async id => [id, await labelOf(id)]))) };
    }
    if (section === 'hist') return { overview: await rstore.overview(guildId, userId) };
    return {};
  };
  const show = async (section, notice) => {
    const [cfg, prefs, ctx] = await Promise.all([store.getSettings(guildId), store.getPrefs(guildId, userId), loadCtx(section)]);
    return interaction.update(U(render(section, cfg, prefs, notice, ctx)));
  };
  const cur = await store.getPrefs(guildId, userId);
  const play = () => ({ ...(cur.play || { mode: null, roles: [], voice: 'a' }) });
  if (action === 'sec') { await show(interaction.values[0]); return true; }
  if (action === 'play-mode') { await store.savePrefs(guildId, userId, { play: { ...play(), mode: interaction.values[0] } }); await show('play', '✅ Salvo.'); return true; }
  if (action === 'play-roles') { await store.savePrefs(guildId, userId, { play: { ...play(), roles: interaction.values } }); await show('play', '✅ Salvo.'); return true; }
  if (action === 'play-voice') { await store.savePrefs(guildId, userId, { play: { ...play(), voice: interaction.values[0] } }); await show('play', '✅ Salvo.'); return true; }
  if (action === 'expiry') { await store.savePrefs(guildId, userId, { notif: { expiry: interaction.values[0] } }); await show('avail', '✅ Salvo.'); return true; }
  if (action === 'notif' && core.NOTIF_OPTIONS[extra]) { await store.savePrefs(guildId, userId, { notif: { [extra]: interaction.values[0] } }); await show(extra === 'favorites' ? 'fav' : extra === 'partners' ? 'partners' : ['community', 'digest'].includes(extra) ? 'engage' : 'notif', '✅ Salvo.'); return true; }
  if (action === 'fav-add') {
    const target = interaction.values[0];
    try { await sstore.addFavorite(guildId, userId, target, { isBot: Boolean(interaction.users?.get?.(target)?.bot) }); await show('fav', '✅ Adicionado. Só você vê esta lista; a pessoa não é avisada.'); }
    catch (e) { if (social.FAVORITE_ERRORS[e.code]) { await show('fav', `🚫 ${e.message}`); } else throw e; }
    return true;
  }
  if (action === 'fav-del') { await sstore.removeFavorite(guildId, userId, interaction.values[0]); await show('fav', '✅ Removido.'); return true; }
  if (action === 'vis') { await store.savePrefs(guildId, userId, { visibility: interaction.values[0] }); await show('fav', '✅ Salvo.'); return true; }
  if (action === 'par-invite') {
    const target = interaction.values[0]; const r = await socialFlow.invite(interaction.client, guildId, userId, { id: target, bot: Boolean(interaction.users?.get?.(target)?.bot) });
    await show('partners', r.text); return true;
  }
  if (action === 'par-yes' || action === 'par-no') { const r = await socialFlow.respond(interaction.client, userId, extra, action === 'par-yes'); await show('partners', r.text); return true; }
  if (action === 'par-end') { const ok = await sstore.endPartnership(guildId, userId, interaction.values[0]); await show('partners', ok ? '✅ Parceria encerrada. Sem penalidade para ninguém.' : 'Essa parceria já tinha sido encerrada.'); return true; }
  if (action === 'hist-dispute') { const r = await rflow.requestReview(interaction.client, guildId, userId, interaction.values[0]); await show('hist', r.text); return true; }
  if (action === 'pause') { const h = Number(interaction.values[0]); await store.savePrefs(guildId, userId, { pausedUntil: h > 0 ? Date.now() + h * 3600_000 : null }); await show('engage', h > 0 ? '⏸️ Avisos de engajamento pausados.' : '▶️ Avisos retomados.'); return true; }
  if (action === 'quiet') {
    const v = interaction.values[0];
    if (v === 'custom') {
      await interaction.showModal(new ModalBuilder().setCustomId('minako-mm:prefs:quiet-modal').setTitle('Horário silencioso').addComponents(
        row(new TextInputBuilder().setCustomId('from').setLabel('Início (hora de 0 a 23)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cur.quiet?.from ?? 22))),
        row(new TextInputBuilder().setCustomId('to').setLabel('Fim (hora de 0 a 23)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cur.quiet?.to ?? 8)))));
      return true;
    }
    const q = v === 'none' ? null : (([from, to]) => ({ from: Number(from), to: Number(to) }))(v.split('-'));
    await store.savePrefs(guildId, userId, { quiet: q }); await show('engage', '✅ Salvo.'); return true;
  }
  if (action === 'quiet-modal') {
    try { const q = parseCfg.parseQuiet(interaction.fields.getTextInputValue('from'), interaction.fields.getTextInputValue('to')); await store.savePrefs(guildId, userId, { quiet: q }); await show('engage', '✅ Salvo.'); }
    catch (e) { if (e instanceof parseCfg.ConfigError) await interaction.reply({ content: `⚠️ ${e.message}`, flags: EPH }); else throw e; }
    return true;
  }
  if (action === 'clear-issue') { await store.clearDeliveryIssue(guildId, userId); await show('notif', '✅ Aviso limpo.'); return true; }
  return false;
}

module.exports = { render, open, handleInteraction, SECTIONS };
