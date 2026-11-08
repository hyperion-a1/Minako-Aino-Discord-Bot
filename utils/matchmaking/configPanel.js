'use strict';
// Painel do matchmaking dentro do /minako-configurar. Cada ajuste é validado e gravado na hora
// (tabelas próprias minako_mm_*), sem rascunho. Tudo é configurável: canais, papéis, prazos, modos, funções.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, MessageFlags,
} = require('discord.js');
const store = require('./store');
const core = require('./mmCore');
const perms = require('./permissions');
const parse = require('./configParse');
const central = require('./central');

const EPH = MessageFlags.Ephemeral; const V2 = MessageFlags.IsComponentsV2;
const SECTIONS = [['canais', 'Canais', '💬', 'Central, grupos, tópicos e revisão.'], ['papeis', 'Papéis', '🏅', 'Gestão, moderação, revisão e manutenção.'],
  ['prazos', 'Prazos e busca', '⏱️', 'Validades, janelas e relaxamento.'], ['modos', 'Modos e funções', '🎮', 'Modos de jogo e catálogo de funções.'], ['status', 'Diagnóstico', '🩺', 'Conferir o que falta e as permissões.']];
const row = (...c) => new ActionRowBuilder().addComponents(c);
const ch = (id) => (id ? `<#${id}>` : '*não configurado*');
const roles = (ids) => (ids?.length ? ids.map(i => `<@&${i}>`).join(', ') : '*nenhum*');
const mins = (s) => parse.fmt(s);
const U = (p) => ({ components: p.components, allowedMentions: p.allowedMentions });

function sectionRow(uid, current) {
  return row(new StringSelectMenuBuilder().setCustomId(`minako-mm:cfg:sec:${uid}`).setPlaceholder('Trocar de seção')
    .addOptions(SECTIONS.map(([v, label, emoji, description]) => ({ value: v, label, emoji, description, default: v === current }))));
}
const shell = (text, rows) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text)).addSeparatorComponents(new SeparatorBuilder());
  rows.forEach(r => c.addActionRowComponents(r));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
};
const channelSelect = (id, uid, placeholder, types = [ChannelType.GuildText]) => row(new ChannelSelectMenuBuilder().setCustomId(`minako-mm:cfg:${id}:${uid}`).setPlaceholder(placeholder).setChannelTypes(types).setMinValues(0).setMaxValues(1));
const roleSelect = (id, uid, placeholder, max) => row(new RoleSelectMenuBuilder().setCustomId(`minako-mm:cfg:${id}:${uid}`).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max));

function render(section, cfg, uid, { modeId = null, notice = '' } = {}) {
  const s = cfg.settings; const sec = sectionRow(uid, section); const n = notice ? `\n\n${notice}` : '';
  if (section === 'canais') return shell(`## 💬 Matchmaking · Canais\n**Central:** ${ch(cfg.centralChannelId)}\n**Grupos abertos:** ${ch(cfg.groupsChannelId)}\n**Tópicos privados (canal-pai):** ${ch(cfg.topicsParentId)}\n**Revisão de partidas:** ${ch(s.reviewChannelId)}${n}\n\n-# Trocar a Central cria uma nova mensagem no canal escolhido; apague a antiga manualmente.`, [
    channelSelect('ch-central', uid, 'Canal da Central'), channelSelect('ch-groups', uid, 'Canal de grupos abertos'), channelSelect('ch-topics', uid, 'Canal-pai dos tópicos privados'), channelSelect('ch-review', uid, 'Canal de revisão de partidas'), sec]);
  if (section === 'papeis') return shell(`## 🏅 Matchmaking · Papéis\n**Gestão:** ${roles(cfg.roleIds.management)}\n**Moderação:** ${roles(cfg.roleIds.moderation)}\n**Revisão (revisor):** ${roles(s.reviewRoleId ? [s.reviewRoleId] : [])}\n**Manutenção:** ${roles(cfg.roleIds.maintenance)}${n}\n\n-# Administradores têm acesso a tudo. Configurar o módulo exige "Gerenciar Servidor".`, [
    roleSelect('rl-management', uid, 'Gestão (gerencia e encerra grupos)', 5), roleSelect('rl-moderation', uid, 'Moderação (gerencia e encerra grupos)', 5), roleSelect('rl-reviewer', uid, 'Cargo de revisão (resolve contestações)', 1), roleSelect('rl-maintenance', uid, 'Manutenção (diagnóstico e backup)', 5), sec]);
  if (section === 'prazos') return shell(`## ⏱️ Matchmaking · Prazos e busca\n**Proposta:** ${mins(s.proposalTtlSec)}\n**Disponibilidade:** ${mins(s.availabilityTtlSec)}\n**Busca por substituto:** ${mins(s.replacementTtlSec)}\n**Confirmação da partida:** ${mins(s.confirmationWindowSec)}\n**Arquivamento de tópicos:** ${mins(s.archiveAfterSec)}\n**Relaxar preferências opcionais:** após ${mins(s.relaxAfterSec[0])} e ${mins(s.relaxAfterSec[1])}\n**Atualização mínima da Central:** ${mins(s.centralMinRefreshSec)}\n**Inatividade de grupos abertos:** ${mins(s.groupInactivityTtlSec)} (depois disso o grupo é encerrado, sem penalidade)\n**Confirmação dos membros da equipe:** ${mins(s.teamConfirmTtlSec)} (a vaga fica reservada até confirmarem)\n**Alerta de atividade da comunidade:** ${s.communityAlertMin ? `a partir de ${s.communityAlertMin} disponíveis, no máximo a cada ${mins(s.communityAlertCooldownSec)}` : 'desligado'} (só para quem optou por receber)${n}`, [
    row(new ButtonBuilder().setCustomId(`minako-mm:cfg:prazos:${uid}`).setLabel('Editar prazos').setEmoji('⏱️').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`minako-mm:cfg:busca:${uid}`).setLabel('Editar busca').setEmoji('🔎').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`minako-mm:cfg:avisos:${uid}`).setLabel('Avisos').setEmoji('🔔').setStyle(ButtonStyle.Secondary)), sec]);
  if (section === 'modos') {
    const mode = cfg.modes.find(m => m.id === modeId);
    const list = cfg.modes.map(m => `• **${m.label}** (${m.active ? 'ativo' : 'inativo'}) — ${m.minSize}–${m.idealSize} jogadores${m.eloRelevant ? `, elo ±${m.eloWindow}` : ''}${m.allowIncomplete ? ', permite incompleto' : ''}${parse.slotsSummary(m) ? `, ${parse.slotsSummary(m)}` : ''}`).join('\n');
    const rows = [row(new StringSelectMenuBuilder().setCustomId(`minako-mm:cfg:mode:${uid}`).setPlaceholder('Escolha um modo para editar').addOptions(cfg.modes.map(m => ({ label: m.label, value: m.id, default: m.id === modeId }))))];
    const btns = [new ButtonBuilder().setCustomId(`minako-mm:cfg:mode-new:${uid}`).setLabel('Novo modo').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`minako-mm:cfg:roles-edit:${uid}`).setLabel('Catálogo de funções').setEmoji('🧭').setStyle(ButtonStyle.Secondary)];
    if (mode) btns.unshift(new ButtonBuilder().setCustomId(`minako-mm:cfg:mode-edit:${uid}:${mode.id}`).setLabel('Editar').setEmoji('✏️').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`minako-mm:cfg:mode-slots:${uid}:${mode.id}`).setLabel('Composição').setEmoji('🧩').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`minako-mm:cfg:mode-toggle:${uid}:${mode.id}`).setLabel(mode.active ? 'Desativar' : 'Ativar').setEmoji(mode.active ? '⏸️' : '▶️').setStyle(ButtonStyle.Secondary));
    rows.push(row(...btns), sec);
    return shell(`## 🎮 Matchmaking · Modos e funções\n${list}\n\n**Funções:** ${s.roleCatalog.join(', ')}${n}\n\n-# Modos desativados somem das escolhas, mas o histórico é preservado.`, rows);
  }
  return shell(`## 🩺 Matchmaking · Diagnóstico${n || '\nToque em **Verificar** para conferir configuração e permissões.'}`, [row(new ButtonBuilder().setCustomId(`minako-mm:cfg:check:${uid}`).setLabel('Verificar').setEmoji('🩺').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`minako-mm:cfg:central-now:${uid}`).setLabel('Atualizar a Central agora').setEmoji('🔄').setStyle(ButtonStyle.Secondary)), sec]);
}

const input = (id, label, value, { style = TextInputStyle.Short, required = true, placeholder } = {}) => row(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setValue(String(value ?? '')).setPlaceholder(placeholder || ''));
const modal = (id, title, rows) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(rows);

// Checagem de permissões do bot em um canal. needed: nomes de permissão do Discord.
function missingPerms(guild, channelId, needed) {
  const channel = channelId ? guild.channels?.cache?.get(channelId) : null;
  if (!channelId) return null;
  if (!channel) return 'canal não encontrado';
  const me = guild.members?.me; const p = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
  if (!p) return 'não consegui verificar';
  const miss = needed.filter(x => !p.has(x));
  return miss.length ? `falta ${miss.join(', ')}` : null;
}
async function diagnostics(interaction, cfg) {
  const g = interaction.guild; const lines = [];
  const add = (ok, text) => lines.push(`${ok ? '✅' : '⚠️'} ${text}`);
  const chk = (label, id, needed) => { if (!id) return add(false, `${label}: não configurado`); const m = missingPerms(g, id, needed); add(!m, `${label}: ${ch(id)}${m ? ` — ${m}` : ''}`); };
  chk('Central', cfg.centralChannelId, ['ViewChannel', 'SendMessages']); chk('Grupos abertos', cfg.groupsChannelId, ['ViewChannel', 'SendMessages']);
  chk('Tópicos privados', cfg.topicsParentId, ['ViewChannel', 'SendMessages', 'CreatePrivateThreads', 'SendMessagesInThreads', 'ManageThreads']); chk('Revisão', cfg.settings.reviewChannelId, ['ViewChannel', 'SendMessages']);
  add(Boolean(cfg.settings.reviewRoleId), `Cargo de revisão: ${cfg.settings.reviewRoleId ? `<@&${cfg.settings.reviewRoleId}>` : 'não configurado'}`);
  add(cfg.modes.some(m => m.active), `Modos ativos: ${cfg.modes.filter(m => m.active).map(m => m.label).join(', ') || 'nenhum'}`);
  const d = await store.getDiagnostics(interaction.guildId);
  lines.push(`\n**Agora:** ${d.availableNow} disponíveis · ${d.openGroups} grupos abertos · ${d.confirmedGroups} confirmados · ${d.pendingProposals} propostas · ${d.matchesInReview} em revisão\n**Falhas operacionais (24 h):** ${d.failuresLast24h} · **Schema:** v${d.schemaVersion}`);
  return lines.join('\n');
}

async function open(interaction, section = 'canais') {
  if (!(await perms.can(interaction, 'config'))) return interaction.reply({ content: 'Você precisa da permissão "Gerenciar Servidor" para configurar o matchmaking.', flags: EPH });
  const cfg = await store.getSettings(interaction.guildId);
  const payload = render(section, cfg, interaction.user.id);
  return interaction.isMessageComponent?.() ? interaction.update(U(payload)) : interaction.reply({ ...payload, flags: V2 | EPH });
}

const one = (i) => i.values?.[0] ?? null;
async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-mm:cfg:')) return false;
  const [, , action, uid, extra] = id.split(':');
  if (uid !== interaction.user.id) { await interaction.reply({ content: 'Este painel pertence a outra pessoa.', flags: EPH }); return true; }
  if (!(await perms.can(interaction, 'config'))) { await interaction.reply({ content: 'Você não tem mais permissão para configurar o matchmaking.', flags: EPH }); return true; }
  const guildId = interaction.guildId;
  const refresh = async (section, opts) => interaction.update(U(render(section, await store.getSettings(guildId), uid, opts)));
  const fail = (e) => interaction.reply({ content: `⚠️ ${e.message}`, flags: EPH });
  const cur = await store.getSettings(guildId);
  try {
    if (action === 'sec') { await refresh(one(interaction)); return true; }
    if (action === 'ch-central' || action === 'ch-groups' || action === 'ch-topics') {
      const key = { 'ch-central': 'centralChannelId', 'ch-groups': 'groupsChannelId', 'ch-topics': 'topicsParentId' }[action];
      await store.saveSettingsPatch(guildId, { [key]: one(interaction) });
      if (action === 'ch-central' && one(interaction)) void central.requestRefresh(interaction.client, guildId, { force: true });
      await refresh('canais', { notice: '✅ Salvo.' }); return true;
    }
    if (action === 'ch-review') { await store.saveSettingsPatch(guildId, { settings: { reviewChannelId: one(interaction) ?? '' } }); await refresh('canais', { notice: '✅ Salvo.' }); return true; }
    if (action.startsWith('rl-')) {
      if (action === 'rl-reviewer') await store.saveSettingsPatch(guildId, { settings: { reviewRoleId: one(interaction) ?? '' } });
      else await store.saveSettingsPatch(guildId, { roleIds: { [action.slice(3)]: [...new Set(interaction.values || [])] } });
      await refresh('papeis', { notice: '✅ Salvo.' }); return true;
    }
    if (action === 'prazos') {
      const s = cur.settings;
      await interaction.showModal(modal(`minako-mm:cfg:prazos-modal:${uid}`, 'Prazos do matchmaking', [
        input('proposta', 'Proposta (minutos)', s.proposalTtlSec / 60), input('disponibilidade', 'Disponibilidade (minutos)', s.availabilityTtlSec / 60),
        input('substituto', 'Busca por substituto (minutos)', s.replacementTtlSec / 60), input('janela', 'Confirmação da partida (horas)', s.confirmationWindowSec / 3600), input('arquivo', 'Arquivamento de tópicos (dias)', s.archiveAfterSec / 86400)]));
      return true;
    }
    if (action === 'prazos-modal') {
      const f = Object.fromEntries(['proposta', 'disponibilidade', 'substituto', 'janela', 'arquivo'].map(k => [k, interaction.fields.getTextInputValue(k)]));
      await store.saveSettingsPatch(guildId, { settings: parse.parseDeadlines(f) }); await refresh('prazos', { notice: '✅ Salvo.' }); return true;
    }
    if (action === 'busca') {
      const s = cur.settings;
      await interaction.showModal(modal(`minako-mm:cfg:busca-modal:${uid}`, 'Busca e relaxamento', [
        input('relax1', '1ª etapa de relaxamento (minutos)', s.relaxAfterSec[0] / 60), input('relax2', '2ª etapa de relaxamento (minutos)', s.relaxAfterSec[1] / 60), input('refresh', 'Atualização mínima da Central (segundos)', s.centralMinRefreshSec), input('inatividade', 'Inatividade de grupos abertos (minutos)', s.groupInactivityTtlSec / 60), input('equipe', 'Confirmação dos membros da equipe (minutos)', s.teamConfirmTtlSec / 60)]));
      return true;
    }
    if (action === 'busca-modal') {
      const f = Object.fromEntries(['relax1', 'relax2', 'refresh', 'inatividade', 'equipe'].map(k => [k, interaction.fields.getTextInputValue(k)]));
      await store.saveSettingsPatch(guildId, { settings: parse.parseSearch(f) }); await refresh('prazos', { notice: '✅ Salvo.' }); return true;
    }
    if (action === 'avisos') {
      const s = cur.settings;
      await interaction.showModal(modal(`minako-mm:cfg:avisos-modal:${uid}`, 'Alerta de atividade', [
        input('min', 'Mínimo de pessoas disponíveis (0 desliga)', s.communityAlertMin), input('cooldown', 'Intervalo mínimo entre alertas (minutos)', s.communityAlertCooldownSec / 60)]));
      return true;
    }
    if (action === 'avisos-modal') {
      const f = Object.fromEntries(['min', 'cooldown'].map(k => [k, interaction.fields.getTextInputValue(k)]));
      await store.saveSettingsPatch(guildId, { settings: parse.parseCommunity(f) }); await refresh('prazos', { notice: '✅ Salvo.' }); return true;
    }
    if (action === 'mode') { await refresh('modos', { modeId: one(interaction) }); return true; }
    if (action === 'mode-toggle') {
      const modes = cur.modes.map(m => (m.id === extra ? { ...m, active: !m.active } : m));
      if (!modes.some(m => m.active)) return fail(new Error('Pelo menos um modo precisa ficar ativo.'));
      await store.saveSettingsPatch(guildId, { modes }); await refresh('modos', { modeId: extra, notice: '✅ Salvo.' }); return true;
    }
    if (action === 'mode-edit' || action === 'mode-new') {
      const m = action === 'mode-edit' ? cur.modes.find(x => x.id === extra) : null;
      await interaction.showModal(modal(`minako-mm:cfg:mode-modal:${uid}:${m?.id || 'new'}`, m ? `Editar: ${m.label}`.slice(0, 45) : 'Novo modo', [
        input('label', 'Nome do modo', m?.label || ''), input('ideal', 'Jogadores (ideal, 2 a 10)', m?.idealSize ?? 5), input('min', 'Jogadores (mínimo)', m?.minSize ?? 2),
        input('incomplete', 'Permite grupo incompleto? (sim/não)', m?.allowIncomplete ? 'sim' : 'não'), input('elo', 'Faixas de elo permitidas (vazio = sem elo)', m?.eloRelevant ? m.eloWindow : '', { required: false })]));
      return true;
    }
    if (action === 'mode-modal') {
      const f = Object.fromEntries(['label', 'ideal', 'min', 'incomplete', 'elo'].map(k => [k, interaction.fields.getTextInputValue(k)]));
      const existing = extra === 'new' ? null : cur.modes.find(x => x.id === extra);
      const mode = parse.parseMode(f, existing, cur.modes);
      const modes = existing ? cur.modes.map(m => (m.id === existing.id ? mode : m)) : [...cur.modes, mode];
      await store.saveSettingsPatch(guildId, { modes }); await refresh('modos', { modeId: mode.id, notice: '✅ Salvo.' }); return true;
    }
    if (action === 'mode-slots') {
      const m = cur.modes.find(x => x.id === extra); if (!m) return fail(new Error('Esse modo não existe mais.'));
      await interaction.showModal(modal(`minako-mm:cfg:slots-modal:${uid}:${m.id}`, `Composição: ${m.label}`.slice(0, 45), [
        input('slots', `Uma linha por vaga (${m.idealSize}): função ou "livre"`, parse.slotsText(m), { style: TextInputStyle.Paragraph, placeholder: 'Selva\nApoio\nlivre' })]));
      return true;
    }
    if (action === 'slots-modal') {
      const m = cur.modes.find(x => x.id === extra); if (!m) return fail(new Error('Esse modo não existe mais.'));
      const slots = parse.parseSlots(interaction.fields.getTextInputValue('slots'), m, cur.settings.roleCatalog);
      await store.saveSettingsPatch(guildId, { modes: cur.modes.map(x => (x.id === m.id ? { ...m, slots } : x)) });
      await refresh('modos', { modeId: m.id, notice: '✅ Salvo. Vagas com função fixa só aceitam, na fila, quem declarou essa função em **Quero jogar agora**.' }); return true;
    }
    if (action === 'roles-edit') {
      await interaction.showModal(modal(`minako-mm:cfg:roles-modal:${uid}`, 'Catálogo de funções', [input('lista', 'Uma função por linha (máx. 10)', cur.settings.roleCatalog.join('\n'), { style: TextInputStyle.Paragraph })]));
      return true;
    }
    if (action === 'roles-modal') {
      await store.saveSettingsPatch(guildId, { settings: { roleCatalog: parse.parseRoleCatalog(interaction.fields.getTextInputValue('lista')) } }); await refresh('modos', { notice: '✅ Salvo.' }); return true;
    }
    if (action === 'check') { await refresh('status', { notice: `\n${await diagnostics(interaction, cur)}` }); return true; }
    if (action === 'central-now') {
      await central.requestRefresh(interaction.client, guildId, { force: true });
      await refresh('status', { notice: '\n🔄 Pedi a atualização da Central. Se algo falhar, use **Verificar** para ver o motivo.' }); return true;
    }
  } catch (e) {
    if (e instanceof parse.ConfigError) { await fail(e); return true; }
    throw e;
  }
  return false;
}

module.exports = { open, render, handleInteraction, SECTIONS, missingPerms };
