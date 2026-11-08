'use strict';
// Painel efêmero do /sorteios configurar (Components V2) + preview ao vivo em
// uma segunda mensagem efêmera. O rascunho vive em memória (por usuário) até
// ser criado; só então vai para o PostgreSQL.
const crypto = require('node:crypto');
const {
  ChannelType, MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const store = require('./giveawayStore');
const core = require('./giveawayCore');
const msg = require('./giveawayMessage');
const actions = require('./giveawayActions');
const { line } = require('./giveawayVoice');
const { getConfig } = require('./config');

const { PREFIX } = msg;
const EPHEMERAL = MessageFlags.Ephemeral;
const V2 = msg.V2;
const SESSION_TTL = 60 * 60_000;
const TABS = ['general', 'rules', 'prizes', 'publish', 'message'];
const TAB_LABEL = { general: 'Geral', rules: 'Regras', prizes: 'Prêmios', publish: 'Publicação', message: 'Mensagem' };
const BLOCK_NAME = { text: 'Texto', section: 'Seção', separator: 'Separador', gallery: 'Galeria' };
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.AnnouncementThread];

const sessions = new Map();
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
}, 5 * 60_000);
sweeper.unref?.();

const txt = (c) => new TextDisplayBuilder().setContent(c);
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const cid = (action, draftId, arg) => `${PREFIX}${action}:${draftId}${arg === undefined ? '' : `:${arg}`}`;
const err = (i, content) => i.reply({ content: `❌ ${content}`, flags: EPHEMERAL });
const mentionList = (ids, prefix) => (ids.length ? `${ids.slice(0, 8).map((id) => `<${prefix}${id}>`).join(', ')}${ids.length > 8 ? ` +${ids.length - 8}` : ''}` : '—');
const short = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Quem pode criar sorteios: Administrador ou membros dos cargos definidos em /sorteios cargos
// (cargos próprios do módulo — independentes dos cargos de partidas).
async function canCreate(i) {
  if (actions.isAdmin(i)) return true;
  const ids = await store.getCreatorRoles(i.guildId).catch(() => []);
  if (!ids.length) return false;
  const mine = new Set(actions.memberRoleIds(i.member));
  return ids.some((r) => mine.has(r));
}

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------
function startSession(i, timeZone) {
  const config = core.defaultConfig();
  const ch = i.channel;
  if (ch && CHANNEL_TYPES.includes(ch.type)) config.channelId = ch.id;
  const session = {
    id: crypto.randomBytes(4).toString('hex'), userId: i.user.id, guildId: i.guildId, timeZone, guild: i.guild, isAdmin: actions.isAdmin(i),
    config, tab: 'general', selected: null, note: '', root: i, previewId: null, creating: false,
    expires: Date.now() + SESSION_TTL,
  };
  sessions.set(session.id, session);
  return session;
}

function getSession(id, i) {
  const s = sessions.get(id);
  if (!s || s.expires < Date.now()) { sessions.delete(id); return null; }
  if (s.userId !== i.user.id || s.guildId !== i.guildId) return null;
  s.expires = Date.now() + SESSION_TTL;
  return s;
}

// ---------------------------------------------------------------------------
// Renderização do painel
// ---------------------------------------------------------------------------
function endDescription(cfg, tz) {
  if (cfg.end.mode === 'date' && cfg.end.at) return `em **${core.formatDateTime(cfg.end.at, tz)}**`;
  return `**${core.formatDuration(cfg.end.durationMinutes)}** após o início`;
}
function cooldownDescription(cfg) {
  if (cfg.cooldown.giveaways > 0) return `próximos **${cfg.cooldown.giveaways}** sorteio(s)`;
  if (cfg.cooldown.days > 0) return `próximos **${cfg.cooldown.days}** dia(s)`;
  return 'nenhum';
}
function startDescription(cfg, tz) {
  return cfg.schedule.enabled && cfg.schedule.startsAt ? `agendado para **${core.formatDateTime(cfg.schedule.startsAt, tz)}**` : 'imediato (ao criar)';
}

function btn(id, label, style = ButtonStyle.Secondary, extra = {}) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (extra.emoji) b.setEmoji(extra.emoji);
  if (extra.disabled) b.setDisabled(true);
  return b;
}

async function renderPanel(session) {
  const cfg = session.config; const d = session.id; const tz = session.timeZone;
  const c = new ContainerBuilder().setAccentColor(0x7289DA);
  c.addTextDisplayComponents(txt('# 🎁 Configurar sorteio\nUse as abas, ajuste o que precisar e acompanhe a **prévia ao vivo** na mensagem abaixo.'));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    ...TABS.map((t) => btn(cid('cfg-tab', d, t), TAB_LABEL[t], session.tab === t ? ButtonStyle.Primary : ButtonStyle.Secondary, { disabled: session.tab === t }))
  ));
  c.addSeparatorComponents(sep());

  if (session.tab === 'general') {
    c.addTextDisplayComponents(txt([
      `**Nome:** ${cfg.name ? core.breakMentions(cfg.name) : '_não definido_'}`,
      `**Participantes:** mínimo **${cfg.minParticipants}** · máximo **${cfg.maxParticipants || '∞'}**`,
      `**Ganhadores:** **${cfg.winnerCount}**`,
      `**Conclusão:** ${endDescription(cfg, tz)}`,
      `**Início:** ${startDescription(cfg, tz)}`,
    ].join('\n')));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      btn(cid('cfg-basic', d), 'Nome e participantes', ButtonStyle.Primary, { emoji: '✏️' }),
      btn(cid('cfg-when', d), 'Duração ou data', ButtonStyle.Primary, { emoji: '⏱️' })
    ));
    const templates = await store.listTemplates(session.guildId).catch(() => []);
    const select = new StringSelectMenuBuilder().setCustomId(cid('cfg-tpl', d)).setPlaceholder(templates.length ? 'Carregar template…' : 'Nenhum template salvo ainda').setMinValues(1).setMaxValues(1);
    if (templates.length) select.addOptions(templates.map((t) => ({ label: t.name.slice(0, 100), value: t.id })));
    else select.addOptions({ label: 'Nenhum template salvo', value: 'none' }).setDisabled(true);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(select));
  }

  if (session.tab === 'rules') {
    c.addTextDisplayComponents(txt([
      `**Cargos permitidos:** ${cfg.allowedRoleIds.length ? mentionList(cfg.allowedRoleIds, '@&') : 'qualquer cargo'}`,
      `**Cargos bloqueados:** ${mentionList(cfg.blockedRoleIds, '@&')}`,
      `**Membros permitidos:** ${cfg.allowedUserIds.length ? mentionList(cfg.allowedUserIds, '@') : 'qualquer membro'}`,
      `**Membros bloqueados:** ${mentionList(cfg.blockedUserIds, '@')}`,
      `**Escopo destas regras:** ${cfg.rulesScope === 'global' ? '🌐 **global** — ao criar, passam a valer para **todos** os sorteios da Minako' : '📄 **só este sorteio** (e os criados a partir do template salvo com ele)'}`,
      `**Afastar o ganhador de:** ${cooldownDescription(cfg)}`,
      '-# Bloqueio sempre vence permissão. Se houver cargos E membros permitidos, vale um OU outro.',
    ].join('\n')));
    const roleMenu = (action, placeholder, ids) => { const m = new RoleSelectMenuBuilder().setCustomId(cid(action, d)).setPlaceholder(placeholder).setMinValues(0).setMaxValues(25); if (ids.length) m.setDefaultRoles(ids); return m; };
    const userMenu = (action, placeholder, ids) => { const m = new UserSelectMenuBuilder().setCustomId(cid(action, d)).setPlaceholder(placeholder).setMinValues(0).setMaxValues(core.LIMITS.maxUsers); if (ids.length) m.setDefaultUsers(ids); return m; };
    c.addActionRowComponents(new ActionRowBuilder().addComponents(roleMenu('cfg-allowed', 'Cargos permitidos (vazio = todos)', cfg.allowedRoleIds)));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(roleMenu('cfg-blocked', 'Cargos bloqueados', cfg.blockedRoleIds)));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(userMenu('cfg-allowedu', 'Membros permitidos (vazio = todos)', cfg.allowedUserIds)));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(userMenu('cfg-blockedu', 'Membros bloqueados', cfg.blockedUserIds)));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      btn(cid('cfg-cooldown', d), 'Afastar ganhador', ButtonStyle.Primary, { emoji: '⏳' }),
      btn(cid('cfg-scope', d), cfg.rulesScope === 'global' ? 'Escopo: Global' : 'Escopo: Só este sorteio', cfg.rulesScope === 'global' ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: '🌐', disabled: !session.isAdmin })
    ));
  }

  if (session.tab === 'prizes') {
    const allowed = await store.getRewardRoles(session.guildId).catch(() => []);
    const wr = cfg.winnerRoles;
    const dur = (n) => (n > 0 ? `por **${n} ${n === 1 ? 'dia' : 'dias'}** (depois o bot desfaz)` : '**permanente**');
    c.addTextDisplayComponents(txt([
      `**Cargos liberados pelos administradores:** ${allowed.length ? mentionList(allowed, '@&') : '_nenhum — peça a um administrador para liberar em `/sorteios cargos`_'}`,
      `**Conferir ao ganhador:** ${wr.grantRoleIds.length ? `${mentionList(wr.grantRoleIds, '@&')} · ${dur(wr.grantDays)}` : '—'}`,
      `**Remover do ganhador:** ${wr.removeRoleIds.length ? `${mentionList(wr.removeRoleIds, '@&')} · ${dur(wr.removeDays)}` : '—'}`,
      '-# Aplicado ao anunciar o resultado e ajustado automaticamente se houver ressorteio. Quem já estiver com o cargo (ou sem ele) não é alterado.',
    ].join('\n')));
    if (allowed.length) {
      const nameOf = (id) => session.guild?.roles?.cache?.get(id)?.name || id;
      const roleSelect = (action, placeholder, selected) => new StringSelectMenuBuilder().setCustomId(cid(action, d)).setPlaceholder(placeholder)
        .setMinValues(0).setMaxValues(Math.min(core.LIMITS.maxRewardRoles, allowed.length))
        .addOptions(allowed.slice(0, 25).map((id) => ({ label: String(nameOf(id)).slice(0, 100), value: id, default: selected.includes(id) })));
      c.addActionRowComponents(new ActionRowBuilder().addComponents(roleSelect('cfg-grant', 'Cargos a CONFERIR ao ganhador', wr.grantRoleIds)));
      c.addActionRowComponents(new ActionRowBuilder().addComponents(roleSelect('cfg-remove', 'Cargos a REMOVER do ganhador', wr.removeRoleIds)));
      c.addActionRowComponents(new ActionRowBuilder().addComponents(btn(cid('cfg-rdays', d), 'Duração (temporário ou permanente)', ButtonStyle.Primary, { emoji: '⏳' })));
    }
  }

  if (session.tab === 'publish') {
    c.addTextDisplayComponents(txt([
      `**Canal/tópico:** ${cfg.channelId ? `<#${cfg.channelId}>` : '_não definido_'}`,
      `**Fixar no canal:** ${cfg.pin ? 'sim' : 'não'}`,
      `**Tópico privado host + ganhadores (criado ao anunciar o resultado):** ${cfg.privateThread.enabled ? 'sim' : 'não'}${cfg.privateThread.enabled ? `\n> ${short(cfg.privateThread.message, 120)}` : ''}`,
      `**Início:** ${startDescription(cfg, tz)}`,
    ].join('\n')));
    const channel = new ChannelSelectMenuBuilder().setCustomId(cid('cfg-channel', d)).setPlaceholder('Canal ou tópico do sorteio').setChannelTypes(...CHANNEL_TYPES).setMinValues(1).setMaxValues(1);
    if (cfg.channelId) channel.setDefaultChannels(cfg.channelId);
    c.addActionRowComponents(new ActionRowBuilder().addComponents(channel));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      btn(cid('cfg-pin', d), `Fixar: ${cfg.pin ? 'Sim' : 'Não'}`, cfg.pin ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: '📌' }),
      btn(cid('cfg-thread', d), `Tópico privado: ${cfg.privateThread.enabled ? 'Sim' : 'Não'}`, cfg.privateThread.enabled ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: '🔐' }),
      btn(cid('cfg-threadmsg', d), 'Mensagem do tópico', ButtonStyle.Secondary, { emoji: '💬' }),
      btn(cid('cfg-schedule', d), `Agendar: ${cfg.schedule.enabled ? 'Sim' : 'Não'}`, cfg.schedule.enabled ? ButtonStyle.Success : ButtonStyle.Secondary, { emoji: '🗓️' })
    ));
  }

  if (session.tab === 'message') {
    const blocks = cfg.message.blocks;
    const list = blocks.map((b, n) => `${session.selected === n ? '▶️' : '▫️'} **${n + 1}.** ${BLOCK_NAME[b.type]}${b.type === 'text' || b.type === 'section' ? ` — ${short(b.content, 60)}` : b.type === 'gallery' ? ` — ${b.urls.length} mídia(s)` : ''}`);
    c.addTextDisplayComponents(txt([
      `**Cor lateral:** ${cfg.message.accentColor === null ? 'nenhuma' : `#${cfg.message.accentColor.toString(16).padStart(6, '0').toUpperCase()}`}`,
      `**Blocos (${blocks.length}/${core.LIMITS.maxBlocks}):**`,
      list.join('\n') || '_nenhum bloco_',
    ].join('\n')));
    if (blocks.length) {
      c.addActionRowComponents(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(cid('cfg-sel', d)).setPlaceholder('Selecionar bloco para editar').addOptions(
          blocks.map((b, n) => {
            const option = { label: `${n + 1}. ${BLOCK_NAME[b.type]}`.slice(0, 100), value: String(n), default: session.selected === n };
            if (b.content) option.description = short(b.content, 90);
            return option;
          })
        )
      ));
    }
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      btn(cid('cfg-add', d, 'text'), '+ Texto'), btn(cid('cfg-add', d, 'section'), '+ Seção'),
      btn(cid('cfg-add', d, 'separator'), '+ Separador'), btn(cid('cfg-add', d, 'gallery'), '+ Galeria'),
      btn(cid('cfg-color', d), 'Cor lateral', ButtonStyle.Primary, { emoji: '🎨' })
    ));
    const has = session.selected !== null && blocks[session.selected];
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      btn(cid('cfg-edit', d), 'Editar', ButtonStyle.Primary, { disabled: !has }),
      btn(cid('cfg-up', d), '↑', ButtonStyle.Secondary, { disabled: !has || session.selected === 0 }),
      btn(cid('cfg-down', d), '↓', ButtonStyle.Secondary, { disabled: !has || session.selected === blocks.length - 1 }),
      btn(cid('cfg-del', d), 'Remover', ButtonStyle.Danger, { disabled: !has }),
      btn(cid('cfg-ph', d), 'Placeholders', ButtonStyle.Secondary, { emoji: '🧩' })
    ));
  }

  c.addSeparatorComponents(sep());
  const errors = core.validateConfig(cfg);
  if (cfg.rulesScope === 'global' && !session.isAdmin) errors.push('Regras **globais** só podem ser criadas por administradores. Volte o escopo para “só este sorteio”.');
  c.addTextDisplayComponents(txt(`${session.note ? `${session.note}\n\n` : ''}${errors.length ? `⚠️ **Pendências:**\n${errors.map((e) => `• ${e}`).join('\n')}` : '✅ Tudo certo para criar.'}`));
  session.note = '';
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    btn(cid('cfg-create', d), session.config.schedule.enabled ? 'Agendar sorteio' : 'Criar sorteio', ButtonStyle.Success, { emoji: '✅', disabled: errors.length > 0 }),
    btn(cid('cfg-savetpl', d), 'Salvar como template', ButtonStyle.Secondary, { emoji: '💾' }),
    btn(cid('cfg-cancel', d), 'Cancelar', ButtonStyle.Danger)
  ));
  return { components: [c], flags: V2 | EPHEMERAL, allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------------------
// Preview ao vivo (segunda mensagem efêmera, editada a cada mudança)
// ---------------------------------------------------------------------------
async function sendPreview(session, i) {
  const payload = msg.buildPreviewMessage(session.config, { hostId: session.userId, timeZone: session.timeZone });
  const m = await i.followUp(payload);
  session.previewId = m.id;
}

async function refreshPreview(session, i) {
  const payload = msg.buildPreviewMessage(session.config, { hostId: session.userId, timeZone: session.timeZone });
  const edit = { components: payload.components, flags: V2, allowedMentions: payload.allowedMentions };
  if (session.previewId) {
    for (const hook of [i.webhook, session.root?.webhook]) {
      if (!hook) continue;
      try { await hook.editMessage(session.previewId, edit); return; } catch { /* tenta o próximo / reenvia */ }
    }
  }
  try { await sendPreview(session, i); } catch (e) { console.warn('[sorteios] Prévia indisponível:', e.message); }
}

// ---------------------------------------------------------------------------
// Modais
// ---------------------------------------------------------------------------
function modal(id, title, fields) {
  const m = new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45));
  for (const f of fields) {
    const input = new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0, 45)).setStyle(f.style || TextInputStyle.Short).setRequired(Boolean(f.required)).setMaxLength(f.max || 100);
    if (f.placeholder) input.setPlaceholder(f.placeholder.slice(0, 100));
    if (f.value !== undefined && f.value !== null && String(f.value) !== '') input.setValue(String(f.value).slice(0, f.max || 100));
    m.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return m;
}

function blockModal(session, mode) {
  const d = session.id;
  const P = TextInputStyle.Paragraph;
  const editing = mode === 'edit' ? session.config.message.blocks[session.selected] : null;
  const type = editing ? editing.type : mode.replace('new-', '');
  const title = `${editing ? 'Editar' : 'Novo'} bloco: ${BLOCK_NAME[type]}`;
  const id = cid('cfg-m-block', d, mode);
  if (type === 'text') return modal(id, title, [{ id: 'content', label: 'Texto (aceita Markdown e placeholders)', style: P, required: true, max: core.LIMITS.textBlock, value: editing?.content }]);
  if (type === 'section') return modal(id, title, [
    { id: 'content', label: 'Texto da seção', style: P, required: true, max: core.LIMITS.textBlock, value: editing?.content },
    { id: 'thumbnail', label: 'URL da thumbnail (https)', required: true, max: core.LIMITS.urlLength, value: editing?.thumbnail },
  ]);
  if (type === 'gallery') return modal(id, title, [{ id: 'urls', label: 'URLs https (uma por linha, até 10)', style: P, required: true, max: 2000, value: editing?.urls.join('\n') }]);
  return modal(id, title, [
    { id: 'divider', label: 'Linha divisória? (sim/não)', required: true, max: 3, value: editing ? (editing.divider ? 'sim' : 'não') : 'sim' },
    { id: 'spacing', label: 'Espaçamento (pequeno/grande)', required: true, max: 8, value: editing?.spacing === 'large' ? 'grande' : 'pequeno' },
  ]);
}

function parseBlockSubmit(type, f) {
  const get = (k) => f.getTextInputValue(k);
  if (type === 'text') return { type, content: get('content') };
  if (type === 'section') return { type, content: get('content'), thumbnail: get('thumbnail') };
  if (type === 'gallery') return { type, urls: get('urls').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
  const yes = /^(s|sim|y|yes|1|true)$/i.test(get('divider').trim());
  return { type: 'separator', divider: yes, spacing: /^g/i.test(get('spacing').trim()) ? 'large' : 'small' };
}

const BLOCK_COST = { text: 1, section: 3, separator: 1, gallery: 1 };

// ---------------------------------------------------------------------------
// Fluxo de criação
// ---------------------------------------------------------------------------
function templateConfig(cfg) {
  const t = core.normalizeConfig(JSON.parse(JSON.stringify(cfg)));
  t.name = '';
  t.schedule = { enabled: false, startsAt: null };
  if (t.end.mode === 'date') t.end = { mode: 'duration', durationMinutes: 1440, at: null };
  return t;
}

async function createGiveaway(i, session) {
  const result = await createGiveawayCore(i, session);
  if (result.ok && core.normalizeConfig(session.config).rulesScope === 'global') {
    try {
      const m = await store.mergeGlobalRules(i.guildId, core.normalizeConfig(session.config));
      result.globalMerged = true; result.globalTruncated = m.truncated;
    } catch (e) { console.error('[sorteios] Regras globais:', e); result.globalFailed = true; }
  }
  return result;
}

async function createGiveawayCore(i, session) {
  const cfg = core.normalizeConfig(session.config);
  const errors = core.validateConfig(cfg);
  if (errors.length) { session.note = '⚠️ Corrija as pendências antes de criar.'; return { ok: false }; }
  if (cfg.rulesScope === 'global' && !actions.isAdmin(i)) { session.note = '❌ Regras globais só podem ser criadas por administradores.'; return { ok: false }; }
  const rewardProblems = await actions.checkRewardRoles(i.guild, cfg.winnerRoles);
  if (rewardProblems.length) { session.note = `❌ Cargos dos ganhadores: ${rewardProblems.join('; ')}.`; return { ok: false }; }

  const channel = await i.guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) { session.note = '❌ O canal escolhido não está disponível.'; return { ok: false }; }
  const { errors: permErrors, warnings } = actions.preflight(i.guild, channel, cfg);
  if (permErrors.length) { session.note = `❌ ${permErrors.join(' ')}`; return { ok: false }; }

  const scheduled = cfg.schedule.enabled;
  try {
    const row = await store.insertGiveaway({
      guildId: i.guildId, hostId: i.user.id, config: cfg,
      status: scheduled ? 'scheduled' : 'starting',
      startsAt: scheduled ? new Date(cfg.schedule.startsAt) : null,
      endsAt: scheduled && cfg.end.mode === 'date' ? new Date(cfg.end.at) : null,
    });
    if (scheduled) return { ok: true, scheduled: true, giveaway: row, warnings };
    try {
      const { message, giveaway } = await actions.publishGiveaway(i.client, row);
      return { ok: true, giveaway, message, warnings };
    } catch (publishError) {
      await store.deleteStarting(row.id).catch(() => {});
      console.error('[sorteios] Falha ao publicar:', publishError);
      session.note = `❌ Não consegui publicar o sorteio: ${publishError.message}`;
      return { ok: false };
    }
  } catch (error) {
    if (error.code === 'NAME_TAKEN') { session.note = '❌ Já existe um sorteio ativo com esse nome. Escolha outro nome.'; return { ok: false }; }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Entrada do comando
// ---------------------------------------------------------------------------
async function open(i) {
  const settings = await getConfig(i.guildId).catch(() => null);
  const session = startSession(i, settings?.timezone || 'America/Sao_Paulo');
  await i.reply(await renderPanel(session));
  await sendPreview(session, i);
}

// ---------------------------------------------------------------------------
// Roteador das interações do painel
// ---------------------------------------------------------------------------
async function show(i, session, { preview = true } = {}) {
  const payload = await renderPanel(session);
  if (i.isModalSubmit() && !i.isFromMessage()) await i.reply({ content: 'Atualizado.', flags: EPHEMERAL });
  else await i.update(payload);
  if (preview) await refreshPreview(session, i);
}

async function handle(i) {
  const [, action, draftId, arg] = i.customId.split(':');
  if (!/^[0-9a-f]{8}$/.test(draftId || '')) return err(i, 'Componente inválido.');
  const session = getSession(draftId, i);
  if (!session) {
    const gone = { components: [new ContainerBuilder().addTextDisplayComponents(txt(`⌛ ${line('sessionExpired')}`))], flags: V2 | EPHEMERAL };
    const canUpdate = i.isMessageComponent?.() || (i.isModalSubmit?.() && i.isFromMessage?.());
    return canUpdate ? i.update(gone) : i.reply({ content: `⌛ ${line('sessionExpired')}`, flags: EPHEMERAL });
  }
  if (!(await canCreate(i))) return err(i, line('lostCreate'));
  const cfg = session.config;

  // ----- abas -----
  if (action === 'cfg-tab') {
    if (!TABS.includes(arg)) return err(i, 'Aba inválida.');
    session.tab = arg;
    return show(i, session, { preview: false });
  }

  // ----- modais: abrir -----
  if (action === 'cfg-basic') {
    return i.showModal(modal(cid('cfg-m-basic', session.id), 'Nome e participantes', [
      { id: 'name', label: 'Nome do sorteio (exclusivo)', required: true, max: core.LIMITS.name, value: cfg.name },
      { id: 'min', label: 'Mínimo de participantes', required: true, max: 6, value: cfg.minParticipants },
      { id: 'max', label: 'Máximo de participantes (0 = sem limite)', required: true, max: 6, value: cfg.maxParticipants },
      { id: 'winners', label: 'Quantidade de ganhadores', required: true, max: 2, value: cfg.winnerCount },
    ]));
  }
  if (action === 'cfg-when') {
    return i.showModal(modal(cid('cfg-m-when', session.id), 'Duração ou data de conclusão', [
      { id: 'duration', label: 'Duração (ex.: 2h, 1d 12h, 90min)', placeholder: 'Preencha este OU a data abaixo', max: 20, value: cfg.end.mode === 'duration' ? core.formatDuration(cfg.end.durationMinutes) : '' },
      { id: 'date', label: 'Data de conclusão (dd/mm/aaaa hh:mm)', placeholder: `Fuso: ${session.timeZone}`, max: 16, value: cfg.end.mode === 'date' && cfg.end.at ? core.formatDateTime(cfg.end.at, session.timeZone) : '' },
    ]));
  }
  if (action === 'cfg-cooldown') {
    return i.showModal(modal(cid('cfg-m-cooldown', session.id), 'Afastar ganhador', [
      { id: 'giveaways', label: 'Impedir nos próximos X sorteios (0 = não)', required: true, max: 4, value: cfg.cooldown.giveaways },
      { id: 'days', label: 'Impedir nos próximos X dias (0 = não)', required: true, max: 4, value: cfg.cooldown.days },
    ]));
  }
  if (action === 'cfg-threadmsg') {
    return i.showModal(modal(cid('cfg-m-threadmsg', session.id), 'Mensagem do tópico privado', [
      { id: 'message', label: 'Mensagem (aceita placeholders)', style: TextInputStyle.Paragraph, required: true, max: core.LIMITS.threadMessage, value: cfg.privateThread.message },
    ]));
  }
  if (action === 'cfg-schedule') {
    return i.showModal(modal(cid('cfg-m-schedule', session.id), 'Agendar início do sorteio', [
      { id: 'start', label: 'Início (dd/mm/aaaa hh:mm) — vazio = agora', placeholder: `Fuso: ${session.timeZone}`, max: 16, value: cfg.schedule.enabled && cfg.schedule.startsAt ? core.formatDateTime(cfg.schedule.startsAt, session.timeZone) : '' },
    ]));
  }
  if (action === 'cfg-savetpl') {
    return i.showModal(modal(cid('cfg-m-savetpl', session.id), 'Salvar como template', [
      { id: 'name', label: 'Nome do template (exclusivo)', required: true, max: core.LIMITS.name, value: cfg.name },
    ]));
  }
  if (action === 'cfg-color') {
    return i.showModal(modal(cid('cfg-m-color', session.id), 'Cor lateral da mensagem', [
      { id: 'color', label: 'Cor em hex (#RRGGBB) ou vazio = sem cor', max: 8, value: cfg.message.accentColor === null ? '' : `#${cfg.message.accentColor.toString(16).padStart(6, '0')}` },
    ]));
  }
  if (action === 'cfg-add') {
    if (!BLOCK_COST[arg]) return err(i, 'Tipo de bloco inválido.');
    if (cfg.message.blocks.length >= core.LIMITS.maxBlocks) return err(i, `O limite é de ${core.LIMITS.maxBlocks} blocos.`);
    if (core.countComponents(cfg.message.blocks) + BLOCK_COST[arg] > core.LIMITS.maxComponents) return err(i, 'A mensagem já tem componentes demais para o Discord.');
    return i.showModal(blockModal(session, `new-${arg}`));
  }
  if (action === 'cfg-edit') {
    if (!cfg.message.blocks[session.selected]) return err(i, 'Selecione um bloco primeiro.');
    return i.showModal(blockModal(session, 'edit'));
  }
  if (action === 'cfg-ph') {
    return i.reply({ content: `**Placeholders disponíveis** (valores preenchidos automaticamente)\n${core.PLACEHOLDER_DOCS.map(([k, v]) => `• \`${k}\` — ${v}`).join('\n')}`, flags: EPHEMERAL });
  }

  // ----- toggles e seleções -----
  if (action === 'cfg-pin') { cfg.pin = !cfg.pin; return show(i, session, { preview: false }); }
  if (action === 'cfg-thread') { cfg.privateThread.enabled = !cfg.privateThread.enabled; return show(i, session, { preview: false }); }
  if (action === 'cfg-channel') {
    const id = i.values?.[0];
    const known = core.isSnowflake(id) && (i.guild.channels.cache.has(id) || Boolean(await i.guild.channels.fetch(id).catch(() => null)));
    if (!known) return err(i, 'Canal inválido.');
    cfg.channelId = id;
    return show(i, session);
  }
  if (action === 'cfg-allowed' || action === 'cfg-blocked') {
    const ids = (i.values || []).filter(core.isSnowflake).slice(0, core.LIMITS.maxRoles);
    if (action === 'cfg-allowed') cfg.allowedRoleIds = ids; else cfg.blockedRoleIds = ids;
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-allowedu' || action === 'cfg-blockedu') {
    const ids = (i.values || []).filter(core.isSnowflake).slice(0, core.LIMITS.maxUsers);
    if (action === 'cfg-allowedu') cfg.allowedUserIds = ids; else cfg.blockedUserIds = ids;
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-scope') {
    if (!actions.isAdmin(i)) return err(i, 'Só administradores podem criar regras globais.');
    cfg.rulesScope = cfg.rulesScope === 'global' ? 'local' : 'global';
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-grant' || action === 'cfg-remove') {
    const allowed = await store.getRewardRoles(session.guildId);        // só cargos liberados pelos administradores
    const ids = (i.values || []).filter((r) => allowed.includes(r)).slice(0, core.LIMITS.maxRewardRoles);
    if (action === 'cfg-grant') cfg.winnerRoles.grantRoleIds = ids; else cfg.winnerRoles.removeRoleIds = ids;
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-rdays') {
    return i.showModal(modal(cid('cfg-m-rdays', session.id), 'Duração dos cargos', [
      { id: 'grant', label: 'Dias com o cargo conferido (0 = permanente)', required: true, max: 4, value: cfg.winnerRoles.grantDays },
      { id: 'remove', label: 'Dias sem o cargo removido (0 = permanente)', required: true, max: 4, value: cfg.winnerRoles.removeDays },
    ]));
  }
  if (action === 'cfg-sel') {
    const n = Number(i.values?.[0]);
    session.selected = Number.isInteger(n) && cfg.message.blocks[n] ? n : null;
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-up' || action === 'cfg-down') {
    const from = session.selected; const to = action === 'cfg-up' ? from - 1 : from + 1;
    const blocks = cfg.message.blocks;
    if (from === null || !blocks[from] || !blocks[to]) return show(i, session, { preview: false });
    [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
    session.selected = to;
    return show(i, session);
  }
  if (action === 'cfg-del') {
    if (cfg.message.blocks[session.selected]) cfg.message.blocks.splice(session.selected, 1);
    session.selected = null;
    return show(i, session);
  }
  if (action === 'cfg-tpl') {
    const tpl = await store.getTemplate(session.guildId, i.values?.[0]);
    if (!tpl) { session.note = '❌ Template não encontrado (talvez tenha sido excluído).'; return show(i, session, { preview: false }); }
    const keep = { name: cfg.name, channelId: cfg.channelId };
    const loaded = core.normalizeConfig({ ...tpl.config, name: keep.name, schedule: { enabled: false, startsAt: null } });
    const tplChannelOk = loaded.channelId && (i.guild.channels.cache.has(loaded.channelId));
    loaded.channelId = tplChannelOk ? loaded.channelId : keep.channelId;
    let scopeNote = '';
    if (loaded.rulesScope === 'global' && !session.isAdmin) { loaded.rulesScope = 'local'; scopeNote = ' O escopo global é só para administradores, então deixei como “só este sorteio”.'; }
    session.config = loaded; session.selected = null;
    session.note = `📥 Template **${core.breakMentions(tpl.name)}** carregado. Defina o nome do novo sorteio e revise as datas.${scopeNote}`;
    return show(i, session);
  }
  if (action === 'cfg-cancel') {
    sessions.delete(session.id);
    return i.update({ components: [new ContainerBuilder().addTextDisplayComponents(txt('Configuração cancelada.'))], flags: V2 | EPHEMERAL });
  }
  if (action === 'cfg-create') {
    if (session.creating) return i.deferUpdate();                // duplo clique
    session.creating = true;
    await i.deferUpdate();
    try {
      const result = await createGiveaway(i, session);
      if (!result.ok) { session.creating = false; await i.editReply(await renderPanel(session)); return undefined; }
      sessions.delete(session.id);
      const g = result.giveaway;
      const lines = result.scheduled
        ? ['## 🗓️ Sorteio agendado', `**${core.breakMentions(g.name)}** · <#${g.channelId}>`, line('scheduled', { when: `<t:${Math.floor(g.startsAt.getTime() / 1000)}:F>` })]
        : ['## ✅ Sorteio publicado', `**${core.breakMentions(g.name)}** · <#${g.channelId}>`, line('published', { link: result.message.url })];
      if (result.globalMerged) lines.push('', `🌐 As regras de cargo/membro deste sorteio agora valem para **todos** os sorteios (edite em \`/sorteios regras-globais\`).${result.globalTruncated ? ' ⚠️ A lista global ficou cheia e alguns itens não couberam.' : ''}`);
      if (result.globalFailed) lines.push('', '⚠️ O sorteio foi criado, mas não consegui salvar as regras globais. Use `/sorteios regras-globais`.');
      if (result.warnings?.length) lines.push('', ...result.warnings.map((w) => `⚠️ ${w}`));
      await i.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(txt(lines.join('\n')))], flags: V2 | EPHEMERAL, allowedMentions: { parse: [] } });
      if (session.previewId) await i.webhook.editMessage(session.previewId, { components: [new ContainerBuilder().addTextDisplayComponents(txt('-# Prévia encerrada — o sorteio foi criado.'))], flags: V2 }).catch(() => {});
    } catch (error) {
      session.creating = false;
      console.error('[sorteios] Erro ao criar sorteio:', error);
      session.note = '❌ Erro inesperado ao criar. Nada foi publicado — tente de novo.';
      await i.editReply(await renderPanel(session)).catch(() => {});
    }
    return undefined;
  }

  // ----- envio de modais -----
  if (action === 'cfg-m-basic') {
    const name = i.fields.getTextInputValue('name').replace(/\s+/g, ' ').trim();
    const min = Number(i.fields.getTextInputValue('min')); const max = Number(i.fields.getTextInputValue('max')); const winners = Number(i.fields.getTextInputValue('winners'));
    if (!name || name.length > core.LIMITS.name) return err(i, 'Informe um nome de até 80 caracteres.');
    if (!Number.isInteger(min) || min < 1 || min > core.LIMITS.maxParticipants) return err(i, 'O mínimo deve ser um número inteiro maior que 0.');
    if (!Number.isInteger(max) || max < 0 || max > core.LIMITS.maxParticipants) return err(i, 'O máximo deve ser 0 (sem limite) ou um inteiro positivo.');
    if (max > 0 && max < min) return err(i, 'O máximo não pode ser menor que o mínimo.');
    if (!Number.isInteger(winners) || winners < 1 || winners > core.LIMITS.maxWinners) return err(i, `Ganhadores: informe de 1 a ${core.LIMITS.maxWinners}.`);
    if (max > 0 && max < winners) return err(i, 'O máximo não pode ser menor que a quantidade de ganhadores.');
    const taken = await store.findLiveByName(i.guildId, name);
    if (taken) return err(i, `Já existe um sorteio ativo chamado **${core.breakMentions(taken.name)}**. O nome precisa ser exclusivo.`);
    Object.assign(cfg, { name, minParticipants: min, maxParticipants: max, winnerCount: winners });
    return show(i, session);
  }
  if (action === 'cfg-m-when') {
    const durationText = i.fields.getTextInputValue('duration').trim(); const dateText = i.fields.getTextInputValue('date').trim();
    if (durationText && dateText) return err(i, 'Preencha só **um** dos campos: duração **ou** data.');
    if (!durationText && !dateText) return err(i, 'Preencha a duração ou a data de conclusão.');
    if (durationText) {
      const minutes = core.parseDuration(durationText);
      if (!minutes) return err(i, 'Duração inválida. Exemplos: `90min`, `2h`, `1d 12h` (de 1 minuto até 90 dias).');
      cfg.end = { mode: 'duration', durationMinutes: minutes, at: null };
    } else {
      const at = core.parseDateTime(dateText, session.timeZone);
      if (!at) return err(i, 'Data inválida. Use `dd/mm/aaaa hh:mm`, por exemplo `25/12/2026 20:00`.');
      if (at.getTime() < Date.now() + 60_000) return err(i, 'A data de conclusão precisa estar no futuro.');
      cfg.end = { mode: 'date', durationMinutes: cfg.end.durationMinutes, at: at.toISOString() };
    }
    return show(i, session);
  }
  if (action === 'cfg-m-cooldown') {
    const g = Number(i.fields.getTextInputValue('giveaways')); const dd = Number(i.fields.getTextInputValue('days'));
    if (!Number.isInteger(g) || !Number.isInteger(dd) || g < 0 || dd < 0 || g > 1000 || dd > 3650) return err(i, 'Use números inteiros (sorteios até 1000, dias até 3650).');
    if (g > 0 && dd > 0) return err(i, 'Escolha **sorteios ou dias**, não os dois.');
    cfg.cooldown = { giveaways: g, days: dd };
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-m-rdays') {
    const gd = Number(i.fields.getTextInputValue('grant')); const rd = Number(i.fields.getTextInputValue('remove'));
    if (![gd, rd].every((n) => Number.isInteger(n) && n >= 0 && n <= core.LIMITS.maxRoleDays)) return err(i, `Use números inteiros de 0 a ${core.LIMITS.maxRoleDays}.`);
    cfg.winnerRoles.grantDays = gd; cfg.winnerRoles.removeDays = rd;
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-m-threadmsg') {
    const m = i.fields.getTextInputValue('message').trim();
    if (!m) return err(i, 'A mensagem não pode ficar vazia.');
    cfg.privateThread.message = m.slice(0, core.LIMITS.threadMessage);
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-m-schedule') {
    const t = i.fields.getTextInputValue('start').trim();
    if (!t) { cfg.schedule = { enabled: false, startsAt: null }; return show(i, session); }
    const at = core.parseDateTime(t, session.timeZone);
    if (!at) return err(i, 'Data inválida. Use `dd/mm/aaaa hh:mm`, por exemplo `25/12/2026 20:00`.');
    if (at.getTime() < Date.now() + 60_000) return err(i, 'A data de início precisa estar no futuro.');
    cfg.schedule = { enabled: true, startsAt: at.toISOString() };
    return show(i, session);
  }
  if (action === 'cfg-m-color') {
    const c = core.parseColor(i.fields.getTextInputValue('color'));
    if (!c.ok) return err(i, 'Cor inválida. Use hex como `#F5A9B8`, ou deixe vazio para ficar sem cor.');
    cfg.message.accentColor = c.value;
    return show(i, session);
  }
  if (action === 'cfg-m-savetpl') {
    const name = i.fields.getTextInputValue('name').replace(/\s+/g, ' ').trim();
    if (!name || name.length > core.LIMITS.name) return err(i, 'Informe um nome de até 80 caracteres.');
    if (cfg.rulesScope === 'global' && !session.isAdmin) return err(i, 'Regras globais só podem ser salvas por administradores.');
    try {
      await store.saveTemplate(session.guildId, name, templateConfig(cfg), i.user.id);
    } catch (error) {
      if (error.code === 'TEMPLATE_TAKEN') return err(i, `Já existe um template chamado **${core.breakMentions(name)}**.`);
      throw error;
    }
    session.note = `💾 Template **${core.breakMentions(name)}** salvo. Para usá-lo, abra a aba Geral e escolha “Carregar template”.`;
    return show(i, session, { preview: false });
  }
  if (action === 'cfg-m-block') {
    const editing = arg === 'edit';
    const type = editing ? cfg.message.blocks[session.selected]?.type : String(arg).replace('new-', '');
    if (!BLOCK_COST[type]) return err(i, 'Bloco inválido.');
    const block = core.normalizeBlock(parseBlockSubmit(type, i.fields));
    if (!block) return err(i, type === 'separator' ? 'Bloco inválido.' : 'Bloco inválido: confira se o texto não está vazio e se as URLs começam com `https://`.');
    const next = cfg.message.blocks.slice();
    if (editing) next[session.selected] = block; else next.push(block);
    if (next.length > core.LIMITS.maxBlocks || core.countComponents(next) > core.LIMITS.maxComponents) return err(i, 'Isso passaria do limite de componentes do Discord.');
    if (core.totalText(next) > core.LIMITS.totalText) return err(i, `O texto total da mensagem passaria de ${core.LIMITS.totalText} caracteres.`);
    cfg.message.blocks = next;
    if (!editing) session.selected = next.length - 1;
    return show(i, session);
  }
  return err(i, 'Ação desconhecida.');
}

module.exports = { open, handle, sessions, canCreate, templateConfig, renderPanel, startSession, TABS };
