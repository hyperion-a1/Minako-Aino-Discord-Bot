'use strict';
// Montagem das mensagens em Components V2 do módulo de sorteios.
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder,
  MediaGalleryItemBuilder, SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags,
} = require('discord.js');
const core = require('./giveawayCore');
const { line } = require('./giveawayVoice');

const PREFIX = 'minako-giveaway:';
const V2 = MessageFlags.IsComponentsV2;
const TEXT_BUDGET = 3800; // o Discord aceita 4000 caracteres somando todos os textos da mensagem

function text(content) { return new TextDisplayBuilder().setContent(String(content).trim() ? content : '\u200b'); }

// Contexto de placeholders a partir de um sorteio salvo.
function contextFor(g, extra = {}) {
  return {
    hostId: g.hostId, name: g.name, winnerIds: g.winners || [], winnerCount: g.config.winnerCount,
    participants: extra.participants ?? 0, min: g.config.minParticipants, max: g.config.maxParticipants,
    channelId: g.channelId, startsAt: g.startsAt, endsAt: g.endsAt,
    messageUrl: g.messageId ? `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}` : null,
    now: new Date(), preview: false,
  };
}

// Preenche o container com os blocos configurados, já com placeholders resolvidos.
function fillContainer(container, blocks, ctx) {
  let budget = TEXT_BUDGET;
  const take = (raw) => {
    const rendered = core.renderPlaceholders(raw, ctx).slice(0, Math.max(0, budget));
    budget -= rendered.length;
    return rendered;
  };
  for (const b of blocks) {
    if (b.type === 'text') {
      container.addTextDisplayComponents(text(take(b.content)));
    } else if (b.type === 'section') {
      container.addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(text(take(b.content))).setThumbnailAccessory(new ThumbnailBuilder().setURL(b.thumbnail))
      );
    } else if (b.type === 'separator') {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(b.divider !== false).setSpacing(b.spacing === 'large' ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small));
    } else if (b.type === 'gallery') {
      container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(b.urls.map((url) => new MediaGalleryItemBuilder().setURL(url))));
    }
  }
  return container;
}

// Último row da mensagem: 🎉 (N) | Sair | Participantes.
function entryRow(id, count, { joinLeaveDisabled = false, preview = false } = {}) {
  const cid = (a) => (preview ? `${PREFIX}noop:${a}` : `${PREFIX}${a}:${id}`);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('join')).setLabel(`(${count})`).setEmoji('🎉').setStyle(ButtonStyle.Success).setDisabled(preview || joinLeaveDisabled),
    new ButtonBuilder().setCustomId(cid('leave')).setLabel('Sair').setStyle(ButtonStyle.Secondary).setDisabled(preview || joinLeaveDisabled),
    new ButtonBuilder().setCustomId(cid('people')).setLabel('Participantes').setStyle(ButtonStyle.Secondary).setDisabled(preview)
  );
}

// state: 'active' | 'drawn' (botões Participar/Sair expirados) | 'cancelled'
function buildPublicMessage(g, { count, state = 'active' } = {}) {
  const container = new ContainerBuilder();
  if (g.config.message.accentColor !== null) container.setAccentColor(g.config.message.accentColor);
  fillContainer(container, g.config.message.blocks, contextFor(g, { participants: count }));
  if (state === 'drawn') container.addTextDisplayComponents(text('-# 🏆 Inscrições encerradas — veja o anúncio dos ganhadores abaixo.'));
  if (state === 'cancelled') container.addTextDisplayComponents(text('-# 🚫 Este sorteio foi cancelado.'));
  return {
    components: [container, entryRow(g.id, count, { joinLeaveDisabled: state !== 'active' })],
    flags: V2,
    allowedMentions: { parse: [] },   // nunca notifica ninguém por causa do texto do host
  };
}

// Prévia efêmera ao vivo: mesma mensagem, botões inertes e valores de exemplo.
function buildPreviewMessage(cfg, { hostId, timeZone, now = new Date() }) {
  const startsAt = cfg.schedule.enabled && cfg.schedule.startsAt ? new Date(cfg.schedule.startsAt) : now;
  const endsAt = cfg.end.mode === 'date' && cfg.end.at ? new Date(cfg.end.at) : new Date(startsAt.getTime() + cfg.end.durationMinutes * 60_000);
  const g = {
    id: '0', guildId: '0', hostId, name: cfg.name || '(sem nome)', config: cfg, winners: [], channelId: cfg.channelId,
    startsAt, endsAt, messageId: null,
  };
  const ctx = { ...contextFor(g, { participants: 0 }), preview: true };
  const container = new ContainerBuilder();
  if (cfg.message.accentColor !== null) container.setAccentColor(cfg.message.accentColor);
  container.addTextDisplayComponents(text('-# 👁️ Prévia ao vivo — só você vê esta mensagem. Os botões abaixo não funcionam aqui.'));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
  fillContainer(container, cfg.message.blocks, ctx);
  return {
    components: [container, entryRow('0', 0, { preview: true })],
    flags: V2 | MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

// Anúncio dos ganhadores. final=true remove os botões (Concluir expira a mensagem).
function buildWinnersMessage(g, { final = false, note = null } = {}) {
  const winners = g.winners || [];
  const lines = [
    `## 🏆 ${line(winners.length > 1 ? 'winnersTitleMany' : 'winnersTitleOne')} — ${core.breakMentions(g.name)}`,
    winners.map((u) => `<@${u}>`).join(' ') || '—',
    final ? '' : line('winnersIntro'),
    '',
    `Host: <@${g.hostId}>`,
  ];
  const wr = g.config.winnerRoles;
  const dur = (d) => (d > 0 ? ` por ${d} ${d === 1 ? 'dia' : 'dias'}` : '');
  const roleList = (ids) => ids.map((r) => `<@&${r}>`).join(', ');
  if (wr?.grantRoleIds.length) lines.push('', `🎖️ Cargo(s) conferido(s)${dur(wr.grantDays)}: ${roleList(wr.grantRoleIds)}`);
  if (wr?.removeRoleIds.length) lines.push(wr.grantRoleIds.length ? '' : '', `🔻 Cargo(s) removido(s)${dur(wr.removeDays)}: ${roleList(wr.removeRoleIds)}`);
  if (note) lines.push('', note);
  if (!final) lines.push('', '-# Somente o host ou um administrador pode ressortear ou concluir.');
  const container = new ContainerBuilder().addTextDisplayComponents(text(lines.join('\n')));
  if (g.config.message.accentColor !== null) container.setAccentColor(g.config.message.accentColor);
  const components = [container];
  if (!final) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}redraw:${g.id}`).setLabel('Ressortear').setEmoji('🔁').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}conclude:${g.id}`).setLabel('Concluir').setEmoji('✅').setStyle(ButtonStyle.Success)
    ));
  }
  return { components, flags: V2, allowedMentions: { users: winners.slice(0, 100) } };
}

// Mensagem enviada dentro do tópico privado (placeholders completos).
function buildThreadMessage(g) {
  const content = core.renderPlaceholders(g.config.privateThread.message, contextFor(g, { participants: 0 })).slice(0, 2000);
  return { content, allowedMentions: { users: [...new Set([g.hostId, ...(g.winners || [])])].slice(0, 100) } };
}

module.exports = { PREFIX, V2, contextFor, fillContainer, entryRow, buildPublicMessage, buildPreviewMessage, buildWinnersMessage, buildThreadMessage };
