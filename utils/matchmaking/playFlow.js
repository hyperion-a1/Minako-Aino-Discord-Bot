'use strict';
// Fluxo "Quero jogar agora": modo, funções e voz por seleção; disponibilidade com validade;
// controles de renovar/pausar/encerrar; resposta a propostas pela Central (quando a DM está fechada).
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const db = require('../db');
const store = require('./store');
const core = require('./mmCore');
const engine = require('./engine');
const notify = require('./notify');
const central = require('./central');
const groupFlow = require('./groupFlow');
const socialFlow = require('./socialFlow');

const EPH = MessageFlags.Ephemeral;
const V2 = MessageFlags.IsComponentsV2;

// customId: minako-mm:play:<ação>:<modo>:<funções (índices do catálogo, "-" = nenhuma)>:<voz y|n|a>
const VOICE = { y: ['Prefiro voz', 'yes'], n: ['Sem voz', 'no'], a: ['Tanto faz', null] };
const encodeSel = ({ mode, roles, voice }) => `${mode}:${roles.length ? roles.join('.') : '-'}:${voice}`;
function decodeSel(parts) {
  const [mode, roles, voice] = parts;
  return { mode, roles: !roles || roles === '-' ? [] : roles.split('.').map(Number).filter(Number.isInteger), voice: VOICE[voice] ? voice : 'a' };
}
const voiceValue = (v) => VOICE[v]?.[1] ?? null;

const box = (text, rows = []) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (rows.length) { c.addSeparatorComponents(new SeparatorBuilder()); rows.forEach(r => c.addActionRowComponents(r)); }
  return { components: [c], flags: V2 | EPH, allowedMentions: { parse: [] } };
};
const row = (...components) => new ActionRowBuilder().addComponents(components);
const button = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

// Em atualizações de mensagem não reenviamos flags (Ephemeral não se aplica a update).
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });

function configPanel(cfg, sel, elo) {
  const mode = cfg.modes.find(m => m.id === sel.mode) || cfg.modes[0];
  const catalog = cfg.settings.roleCatalog;
  const roleNames = sel.roles.map(i => catalog[i]).filter(Boolean);
  const eloNote = mode.eloRelevant
    ? (elo ? `**Seu elo:** ${core.RANKS.find(r => r[0] === elo)?.[1] || elo}` : '⚠️ Este modo usa elo. Complete seu perfil com `/minako-match` antes de entrar.')
    : '';
  const text = `## 🎮 Quero jogar agora\nEscolha como quer jogar. Você fica disponível por **${Math.round(cfg.settings.availabilityTtlSec / 60)} min** e pode renovar quando quiser.\n\n` +
    `**Modo:** ${mode.label}\n**Funções:** ${roleNames.join(', ') || 'Qualquer uma'}\n**Voz:** ${VOICE[sel.voice][0]}\n${eloNote}\n\n` +
    `-# ${core.stagesText(cfg.settings)}`;
  const s = { mode: mode.id, roles: sel.roles, voice: sel.voice };
  const modeSel = new StringSelectMenuBuilder().setCustomId(`minako-mm:play:m:${encodeSel(s).split(':').slice(1).join(':')}`).setPlaceholder('Modo de jogo')
    .addOptions(cfg.modes.filter(m => m.active).map(m => ({ label: m.label, value: m.id, default: m.id === mode.id })));
  const roleSel = new StringSelectMenuBuilder().setCustomId(`minako-mm:play:r:${mode.id}:${s.voice}`).setPlaceholder('Funções que você joga (opcional)')
    .setMinValues(0).setMaxValues(Math.min(5, catalog.length))
    .addOptions(catalog.map((name, idx) => ({ label: name, value: String(idx), default: sel.roles.includes(idx) })));
  const voiceSel = new StringSelectMenuBuilder().setCustomId(`minako-mm:play:v:${mode.id}:${s.roles.length ? s.roles.join('.') : '-'}`).setPlaceholder('Voz')
    .addOptions(Object.entries(VOICE).map(([k, [label]]) => ({ label, value: k, default: k === sel.voice })));
  const blocked = mode.eloRelevant && !elo;
  const ok = button(`minako-mm:play:ok:${encodeSel(s)}`, 'Ficar disponível', '✅', ButtonStyle.Success); if (blocked) ok.setDisabled(true);
  return box(text, [row(modeSel), row(roleSel), row(voiceSel), row(ok, button('minako-mm:play:x', 'Cancelar', '✖️'))]);
}

function statusPanel(av, cfg, extra = '') {
  const mode = cfg.modes.find(m => m.id === av.modeId);
  const paused = av.status === 'paused';
  const text = `## 🎮 Sua disponibilidade\n${paused ? '⏸️ **Pausada**' : '🟢 **Ativa**'} · ${mode?.label || av.modeId}\n${paused ? '' : `Expira <t:${Math.floor(av.expiresAt / 1000)}:R>\n`}${extra}`;
  return box(text, [row(
    button('minako-mm:av:renew', 'Renovar', '🔄', ButtonStyle.Success),
    paused ? button('minako-mm:av:renew', 'Retomar', '▶️') : button('minako-mm:av:pause', 'Pausar', '⏸️'),
    button('minako-mm:av:end', 'Encerrar', '⏹️', ButtonStyle.Danger),
  )]);
}

async function show(interaction) {
  const guildId = interaction.guildId; const userId = interaction.user.id;
  const pending = await store.pendingProposalForUser(guildId, userId);
  if (pending) {
    const cfg = await store.getSettings(guildId);
    const payload = engine.proposalPayload(pending, cfg.modes.find(m => m.id === pending.modeId), userId);
    return interaction.reply({ ...payload, flags: payload.flags | EPH });
  }
  const cfg = await store.getSettings(guildId);
  const av = await store.getAvailability(guildId, userId);
  if (av) return interaction.reply(statusPanel(av, cfg));
  const profile = await db.loadMatchProfile(guildId, userId).catch(() => null);
  const prefs = await store.getPrefs(guildId, userId).catch(() => null);
  const catalog = cfg.settings.roleCatalog;
  const fromPrefs = prefs?.play;
  const idx = (names) => (names || []).map(r => catalog.indexOf(r)).filter(i => i >= 0).slice(0, 5);
  const roles = fromPrefs?.roles?.length ? idx(fromPrefs.roles) : idx(profile?.routes);
  const first = cfg.modes.find(m => m.id === fromPrefs?.mode && m.active) || cfg.modes.find(m => m.active) || cfg.modes[0];
  return interaction.reply(configPanel(cfg, { mode: first.id, roles, voice: fromPrefs?.voice || 'a' }, profile?.current_rank || null));
}

async function confirm(interaction, sel) {
  const guildId = interaction.guildId; const userId = interaction.user.id;
  const cfg = await store.getSettings(guildId);
  const mode = cfg.modes.find(m => m.id === sel.mode && m.active);
  if (!mode) return interaction.update(U(box('Esse modo não está mais disponível. Abra **Quero jogar agora** de novo.')));
  const profile = await db.loadMatchProfile(guildId, userId).catch(() => null);
  const elo = profile?.current_rank || null;
  if (mode.eloRelevant && !elo) return interaction.update(U(configPanel(cfg, sel, null)));
  try {
    await store.setAvailability(guildId, userId, {
      modeId: mode.id, roles: sel.roles.map(i => cfg.settings.roleCatalog[i]).filter(Boolean), elo, voice: voiceValue(sel.voice),
    }, cfg.settings.availabilityTtlSec);
  } catch (e) {
    if (e.code === 'INCOMPATIBLE_COMMITMENT') return interaction.update(U(box('Você já está em um grupo ativo, então não pode entrar na fila ao mesmo tempo.')));
    throw e;
  }
  const av = await store.getAvailability(guildId, userId);
  await notify.closeOps(interaction.client, guildId, 'expw', userId, { text: 'Você entrou na busca de novo.' });
  void central.requestRefresh(interaction.client, guildId);
  void socialFlow.announceAvailability(interaction.client, guildId, userId, mode.label).catch(() => {});
  void engine.runMatching(interaction.client, guildId).catch(e => console.error('[matchmaking] busca imediata:', e.message));
  return interaction.update(U(statusPanel(av, cfg, '\nEstou procurando uma equipe. Você receberá uma proposta por mensagem privada. Enquanto isso, veja os **Grupos abertos** na Central.')));
}

async function availabilityAction(interaction, action, fallbackGuildId = null) {
  const guildId = interaction.guildId || fallbackGuildId; const userId = interaction.user.id;
  if (!guildId) return interaction.update(U(box('Não consegui identificar o servidor. Use **Quero jogar agora** na Central.')));
  const cfg = await store.getSettings(guildId);
  const ok = await store.changeAvailability(guildId, userId, action, cfg.settings.availabilityTtlSec);
  await notify.closeOps(interaction.client, guildId, 'expw', userId, { exceptMessageId: interaction.message?.id, text: action === 'end' ? 'Disponibilidade encerrada.' : 'Disponibilidade renovada.' });
  void central.requestRefresh(interaction.client, guildId);
  if (!ok || action === 'end') return interaction.update(U(box(ok ? '⏹️ Disponibilidade encerrada. Quando quiser, volte em **Quero jogar agora**.' : 'Você não tem uma disponibilidade ativa.')));
  const av = await store.getAvailability(guildId, userId);
  if (!interaction.guildId) return interaction.update(U(box(av ? `🔄 Disponibilidade renovada! Ela expira <t:${Math.floor(av.expiresAt / 1000)}:R>.` : 'Sua disponibilidade expirou. Use **Quero jogar agora** na Central.')));
  return interaction.update(U(av ? statusPanel(av, cfg) : box('Sua disponibilidade expirou. Use **Quero jogar agora** de novo.')));
}

async function proposalAnswer(interaction, answer, proposalId) {
  const guildId = await store.proposalGuildId(proposalId);
  if (!guildId) return interaction.update(U(engine.box('Essa proposta não existe mais.')));
  const cfg = await store.getSettings(guildId);
  let result;
  try { result = await store.respondProposal(guildId, proposalId, interaction.user.id, answer); }
  catch (e) { if (e.code === 'NOT_PARTICIPANT') return interaction.reply({ content: 'Essa proposta não é sua.', flags: EPH }); throw e; }
  const proposal = await store.getProposal(proposalId);
  const mode = cfg.modes.find(m => m.id === proposal?.modeId);
  if (result.stale) return interaction.update(U(engine.proposalPayload(proposal, mode, interaction.user.id, { state: result.outcome === 'confirmed' ? 'confirmed' : 'expired' })));
  if (!result.final) return interaction.update(U(engine.proposalPayload(proposal, mode, interaction.user.id, { state: 'waiting' })));
  const mine = result.outcome === 'confirmed' ? 'confirmed' : (result.declined?.includes(interaction.user.id) ? 'declined' : 'cancelled');
  await interaction.update(U(engine.proposalPayload(proposal, mode, interaction.user.id, { state: mine })));
  await engine.notifyOutcome(interaction.client, result, mode); // atualiza as DMs dos demais
  if (result.outcome === 'confirmed' && result.groupId) {
    // Equipe formada pela fila: cria o tópico privado (idempotente). Falha aqui não desfaz a equipe.
    try { await groupFlow.ensureThread(interaction.client, guildId, result.groupId); }
    catch (e) { console.error('[matchmaking] tópico da equipe:', e.message); await store.logEvent(guildId, 'group.thread_failed', { groupId: result.groupId }).catch(() => {}); }
  }
  void central.requestRefresh(interaction.client, guildId, { force: true });
}

// Roteador do módulo. Devolve false se o customId não for do matchmaking.
async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:')) return false;
  const [, kind, action, ...rest] = id.split(':');
  if (!interaction.guildId && kind !== 'prop' && !(kind === 'av' && rest[0])) { await interaction.reply({ content: 'Use isto no servidor.', flags: EPH }); return true; }
  if (kind === 'play' && !action) { await show(interaction); return true; }
  if (kind === 'play') {
    const cfg = await store.getSettings(interaction.guildId);
    if (action === 'x') { await interaction.update(U(box('Cancelado. Quando quiser, é só voltar. ✨'))); return true; }
    if (action === 'm') { const s = decodeSel([interaction.values[0], ...rest]); const p = await db.loadMatchProfile(interaction.guildId, interaction.user.id).catch(() => null); await interaction.update(U(configPanel(cfg, s, p?.current_rank || null))); return true; }
    if (action === 'r') { const [mode, voice] = rest; const s = { mode, roles: interaction.values.map(Number), voice }; const p = await db.loadMatchProfile(interaction.guildId, interaction.user.id).catch(() => null); await interaction.update(U(configPanel(cfg, s, p?.current_rank || null))); return true; }
    if (action === 'v') { const [mode, roles] = rest; const s = decodeSel([mode, roles, interaction.values[0]]); const p = await db.loadMatchProfile(interaction.guildId, interaction.user.id).catch(() => null); await interaction.update(U(configPanel(cfg, s, p?.current_rank || null))); return true; }
    if (action === 'ok') { await confirm(interaction, decodeSel(rest)); return true; }
  }
  if (kind === 'av') { await availabilityAction(interaction, action, rest[0] || null); return true; }
  if (kind === 'prop') { await proposalAnswer(interaction, action === 'a' ? 'accepted' : 'declined', rest[0]); return true; }
  return false;
}

module.exports = { encodeSel, decodeSel, voiceValue, configPanel, statusPanel, handleInteraction };
