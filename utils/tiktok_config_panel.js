'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  ChannelType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags, PermissionFlagsBits
} = require('discord.js');
const store = require('./tiktok_store');

const EPH = MessageFlags.Ephemeral;
const PREFIX = 'minako-tiktok:cfg:';
const isAdmin = i => Boolean(i.memberPermissions?.has(PermissionFlagsBits.Administrator));
const fmt = n => `${Math.floor(Number(n) / 60)} min`;

function render(settings, uid, notice = '') {
  const embed = new EmbedBuilder().setColor(0xFE2C55).setTitle('🎵 Minako · Configurações TikTok')
    .setDescription([
      notice,
      `**Canal de notificações:** ${settings.notificationChannelId ? `<#${settings.notificationChannelId}>` : 'não configurado'}`,
      `**Notificações de vídeos:** ${settings.videoNotificationsEnabled ? 'ativadas' : 'desativadas'}`,
      `**Anúncios manuais de LIVE:** ${settings.liveAnnouncementsEnabled ? 'ativados' : 'desativados'}`,
      `**Menção ao criador:** ${settings.liveMentionCreator ? 'ativada (somente o titular)' : 'desativada'}`,
      `**Cooldown por criador:** ${fmt(settings.liveAnnounceAccountCooldownSeconds)}`,
      `**Cooldown global do servidor:** ${fmt(settings.liveAnnounceGuildCooldownSeconds)}`,
      `**Monitor de vídeos:** a cada ${settings.pollIntervalMinutes} min · **Limite de contas:** ${settings.maxAccounts}`,
      '',
      'Lives nunca são detectadas ou anunciadas automaticamente. O criador usa `/tiktok anunciar-live` quando estiver ao vivo.',
      'Menções em massa (@everyone/@here) não são permitidas.'
    ].filter(Boolean).join('\n'));
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}video:${uid}`).setLabel(`Vídeos: ${settings.videoNotificationsEnabled ? 'ON' : 'OFF'}`).setStyle(settings.videoNotificationsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}live:${uid}`).setLabel(`Anúncio manual: ${settings.liveAnnouncementsEnabled ? 'ON' : 'OFF'}`).setStyle(settings.liveAnnouncementsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}mention:${uid}`).setLabel(`Menção do titular: ${settings.liveMentionCreator ? 'ON' : 'OFF'}`).setStyle(settings.liveMentionCreator ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`${PREFIX}channel:${uid}`).setPlaceholder('Selecionar canal de notificações').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}limits:${uid}`).setLabel('Intervalos e limites').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row1, row2, row3] };
}

async function open(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: '🚫 Você precisa ser administrador para configurar o módulo TikTok.', flags: EPH });
  const settings = await store.getSettings(interaction.guildId);
  return interaction.reply({ ...render(settings, interaction.user.id), flags: EPH });
}

function limitsModal(uid, s) {
  const modal = new ModalBuilder().setCustomId(`${PREFIX}limits-modal:${uid}`).setTitle('Intervalos e limites TikTok');
  const fields = [
    ['poll', 'Monitor de vídeos (5–60 min)', s.pollIntervalMinutes],
    ['accounts', 'Máximo de criadores (1–10)', s.maxAccounts],
    ['accountcd', 'Cooldown por criador (300–3600 s)', s.liveAnnounceAccountCooldownSeconds],
    ['guildcd', 'Cooldown global (60–1800 s)', s.liveAnnounceGuildCooldownSeconds]
  ];
  for (const [id, label, value] of fields) {
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setValue(String(value)).setRequired(true).setMaxLength(5)));
  }
  return modal;
}

async function handleInteraction(i) {
  const id = i.customId || '';
  if (!id.startsWith(PREFIX)) return false;
  const parts = id.slice(PREFIX.length).split(':');
  const action = parts[0];
  const uid = parts[1];
  if (uid !== i.user.id) { await i.reply({ content: 'Este painel pertence a outra pessoa.', flags: EPH }); return true; }
  if (!i.guildId || !isAdmin(i)) { await i.reply({ content: 'Você não tem mais permissão para configurar o TikTok.', flags: EPH }); return true; }
  const refresh = async notice => i.update(render(await store.getSettings(i.guildId), uid, notice));
  try {
    const s = await store.getSettings(i.guildId);
    if (action === 'video') await store.saveSettings(i.guildId, { videoNotificationsEnabled: !s.videoNotificationsEnabled });
    else if (action === 'live') await store.saveSettings(i.guildId, { liveAnnouncementsEnabled: !s.liveAnnouncementsEnabled });
    else if (action === 'mention') {
      if (!s.liveAnnouncementsEnabled) throw new Error('Ative os anúncios manuais de LIVE antes de habilitar a menção.');
      await store.saveSettings(i.guildId, { liveMentionCreator: !s.liveMentionCreator });
    } else if (action === 'channel') {
      const channelId = i.values?.[0];
      const channel = channelId ? await i.guild.channels.fetch(channelId).catch(() => null) : null;
      if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== i.guildId) throw new Error('Selecione um canal de texto válido deste servidor.');
      const me = i.guild.members.me;
      const perms = me && channel.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('Preciso de Ver Canal, Enviar Mensagens e Inserir Links no canal escolhido.');
      await store.saveSettings(i.guildId, { notificationChannelId: channel.id });
    } else if (action === 'limits') {
      await i.showModal(limitsModal(uid, s)); return true;
    } else if (action === 'limits-modal') {
      const read = key => i.fields.getTextInputValue(key).trim();
      const vals = { pollIntervalMinutes: Number(read('poll')), maxAccounts: Number(read('accounts')), liveAnnounceAccountCooldownSeconds: Number(read('accountcd')), liveAnnounceGuildCooldownSeconds: Number(read('guildcd')) };
      if (Object.values(vals).some(v => !Number.isInteger(v))) throw new Error('Todos os campos precisam conter números inteiros.');
      await store.saveSettings(i.guildId, vals);
      await i.reply({ content: '✅ Intervalos e limites salvos.', flags: EPH });
      return true;
    } else { await i.reply({ content: 'Ação de configuração desconhecida.', flags: EPH }); return true; }
    await refresh('✅ Configuração salva.');
  } catch (error) {
    const message = `⚠️ ${String(error.message || error).slice(0, 1000)}`;
    if (i.isModalSubmit()) await i.reply({ content: message, flags: EPH });
    else await i.reply({ content: message, flags: EPH });
  }
  return true;
}

module.exports = { open, render, handleInteraction };
