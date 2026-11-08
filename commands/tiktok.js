'use strict';

const crypto = require('node:crypto');
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, EmbedBuilder
} = require('discord.js');
const store = require('../utils/tiktok_store');
const oauth = require('../utils/tiktok_oauth');
const configPanel = require('../utils/tiktok_config_panel');

const EPH = MessageFlags.Ephemeral;
const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
const deny = (interaction) => interaction.reply({ content: '🚫 Esta ação é exclusiva da administração do servidor.', flags: EPH });

function validateLiveUrl(raw, username) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || !['www.tiktok.com', 'tiktok.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/@([a-z0-9._]{2,24})\/live\/?$/i);
    if (!match || match[1].toLowerCase() !== String(username).toLowerCase()) return null;
    return `https://www.tiktok.com/@${match[1]}/live`;
  } catch { return null; }
}

module.exports = {
  validateLiveUrl,
  data: new SlashCommandBuilder()
    .setName('tiktok')
    .setDescription('Gerencie os criadores monitorados pela Minako no TikTok.')
    .addSubcommand(s => s.setName('solicitar').setDescription('Solicita o monitoramento da sua conta TikTok.')
      .addStringOption(o => o.setName('perfil').setDescription('Nome de usuário TikTok, com ou sem @.').setRequired(true).setMaxLength(24)))
    .addSubcommand(s => s.setName('adicionar').setDescription('Cadastra diretamente um criador (administração).')
      .addUserOption(o => o.setName('membro').setDescription('Pessoa responsável por conectar a conta.').setRequired(true))
      .addStringOption(o => o.setName('perfil').setDescription('Nome de usuário TikTok, com ou sem @.').setRequired(true).setMaxLength(24)))
    .addSubcommand(s => s.setName('aprovar').setDescription('Aprova uma solicitação de monitoramento.')
      .addIntegerOption(o => o.setName('id').setDescription('ID da solicitação.').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('rejeitar').setDescription('Rejeita uma solicitação de monitoramento.')
      .addIntegerOption(o => o.setName('id').setDescription('ID da solicitação.').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('conectar').setDescription('Conecta sua conta TikTok por autorização oficial.')
      .addIntegerOption(o => o.setName('id').setDescription('ID da conta aprovada.').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('desconectar').setDescription('Desconecta sua conta TikTok da Minako.')
      .addIntegerOption(o => o.setName('id').setDescription('ID da conta.').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('listar').setDescription('Lista contas e solicitações (administração).'))
    .addSubcommand(s => s.setName('canal').setDescription('Define o canal de notificações (administração).')
      .addChannelOption(o => o.setName('canal').setDescription('Canal de texto para os alertas.').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('painel').setDescription('Abre o painel de configurações TikTok (administração).'))
    .addSubcommand(s => s.setName('anunciar-live').setDescription('Anuncia manualmente sua LIVE TikTok no servidor.')
      .addIntegerOption(o => o.setName('id').setDescription('ID da sua conta TikTok vinculada.').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('link').setDescription('Link da sua LIVE: https://www.tiktok.com/@usuario/live').setRequired(true).setMaxLength(200))),

  async execute(interaction) {
    if (!interaction.guildId) return interaction.reply({ content: 'Use este comando dentro de um servidor.', flags: EPH });
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === 'painel') return configPanel.open(interaction);

    if (sub === 'anunciar-live') {
      await interaction.deferReply({ flags: EPH });
      const accountId = interaction.options.getInteger('id', true);
      const rawUrl = interaction.options.getString('link', true).trim();
      const account = await store.getAccountById(guildId, accountId);
      if (!account || account.owner_discord_id !== interaction.user.id) return interaction.editReply({ content: '🚫 Esse ID não corresponde a uma conta TikTok vinculada a você.' });
      if (account.approval_status !== 'approved' || account.connection_status !== 'connected') return interaction.editReply({ content: 'Sua conta precisa estar aprovada e conectada por OAuth antes de anunciar uma LIVE.' });
      const liveUrl = validateLiveUrl(rawUrl, account.username);
      if (!liveUrl) return interaction.editReply({ content: `🔗 Link inválido. Use exclusivamente https://www.tiktok.com/@${account.username}/live (sem parâmetros ou redirecionamentos).` });
      const settings = await store.getSettings(guildId);
      if (!settings.liveAnnouncementsEnabled) return interaction.editReply({ content: '⏸️ Os anúncios manuais de LIVE estão desativados neste servidor. Peça à administração para ativá-los em /tiktok painel.' });
      if (!settings.notificationChannelId) return interaction.editReply({ content: '⚠️ A administração ainda não configurou o canal de notificações em /tiktok painel.' });
      const channel = await interaction.guild.channels.fetch(settings.notificationChannelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guildId) return interaction.editReply({ content: '⚠️ O canal de notificações não existe mais ou não é um canal de texto deste servidor.' });
      const me = interaction.guild.members.me;
      const perms = me && channel.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return interaction.editReply({ content: '⚠️ Não tenho as permissões Ver Canal, Enviar Mensagens e Inserir Links no canal configurado.' });
      const reservation = await store.reserveLiveAnnouncement({ guildId, accountId, accountCooldownSeconds: settings.liveAnnounceAccountCooldownSeconds, guildCooldownSeconds: settings.liveAnnounceGuildCooldownSeconds });
      if (!reservation.ok) {
        const mins = Math.ceil(reservation.retryAfterSeconds / 60);
        return interaction.editReply({ content: `🛑 Anúncio bloqueado para evitar spam. Tente novamente em aproximadamente ${mins} minuto(s). ${reservation.scope === 'guild' ? 'O servidor está no intervalo global de segurança.' : 'Esta conta já anunciou recentemente.'}` });
      }
      const displayName = String(account.display_name || account.username).slice(0, 100);
      const embed = new EmbedBuilder().setColor(0xFE2C55).setAuthor({ name: `${displayName} está ao vivo no TikTok` })
        .setTitle('🔴 LIVE iniciada pelo criador').setURL(liveUrl)
        .setDescription(`[Assistir à transmissão de @${account.username}](${liveUrl})`)
        .addFields({ name: 'Perfil', value: `[@${account.username}](https://www.tiktok.com/@${encodeURIComponent(account.username)})`, inline: true })
        .setFooter({ text: 'Anúncio manual solicitado pelo titular da conta' }).setTimestamp(new Date());
      const content = settings.liveMentionCreator ? `<@${account.owner_discord_id}>` : undefined;
      try {
        const sent = await channel.send({ content, embeds: [embed], allowedMentions: { users: settings.liveMentionCreator ? [account.owner_discord_id] : [], parse: [] } });
        return interaction.editReply({ content: `✅ Sua LIVE foi anunciada em ${channel}. O próximo anúncio desta conta ficará disponível após o cooldown de ${Math.ceil(settings.liveAnnounceAccountCooldownSeconds / 60)} minuto(s).` });
      } catch (error) {
        console.error('[TikTok] Falha ao enviar anúncio manual de LIVE:', error.message);
        return interaction.editReply({ content: '⚠️ Não consegui publicar o anúncio. Por segurança, o cooldown foi mantido para impedir tentativas repetidas que possam gerar spam. Confira as permissões do canal e tente novamente após o intervalo.' });
      }
    }

    if (sub === 'solicitar') {
      const username = interaction.options.getString('perfil', true);
      const account = await store.requestAccount({ guildId, username, ownerDiscordId: interaction.user.id, requestedByDiscordId: interaction.user.id });
      return interaction.reply({ content: `📨 Solicitação **#${account.id}** criada para **@${account.username}**. A administração precisa aprová-la antes da conexão OAuth.`, flags: EPH });
    }

    if (sub === 'adicionar') {
      if (!isAdmin(interaction)) return deny(interaction);
      const member = interaction.options.getUser('membro', true);
      const username = interaction.options.getString('perfil', true);
      const account = await store.requestAccount({ guildId, username, ownerDiscordId: member.id, requestedByDiscordId: interaction.user.id });
      await store.approveAccount({ guildId, accountId: account.id, moderatorDiscordId: interaction.user.id });
      return interaction.reply({ content: `✅ **@${account.username}** foi cadastrado e aprovado para <@${member.id}>. A pessoa deverá executar /tiktok conectar com o ID ${account.id} para autorizar a própria conta.`, flags: EPH, allowedMentions: { users: [] } });
    }

    if (sub === 'aprovar' || sub === 'rejeitar') {
      if (!isAdmin(interaction)) return deny(interaction);
      const accountId = interaction.options.getInteger('id', true);
      const result = sub === 'aprovar'
        ? await store.approveAccount({ guildId, accountId, moderatorDiscordId: interaction.user.id })
        : await store.rejectAccount({ guildId, accountId, moderatorDiscordId: interaction.user.id });
      if (!result) return interaction.reply({ content: 'Solicitação não encontrada ou já processada.', flags: EPH });
      return interaction.reply({ content: sub === 'aprovar'
        ? `✅ Solicitação **#${result.id} (@${result.username})** aprovada. O titular já pode conectar a conta.`
        : `❌ Solicitação **#${result.id} (@${result.username})** rejeitada.`, flags: EPH });
    }

    if (sub === 'conectar') {
      const accountId = interaction.options.getInteger('id', true);
      const account = await store.getAccountById(guildId, accountId);
      if (!account || account.owner_discord_id !== interaction.user.id) return interaction.reply({ content: 'Não encontrei uma conta vinculada a você com esse ID.', flags: EPH });
      if (account.approval_status !== 'approved') return interaction.reply({ content: 'Essa conta ainda não foi aprovada pela administração.', flags: EPH });
      const state = crypto.randomBytes(32).toString('hex');
      const stateHash = crypto.createHash('sha256').update(state).digest('hex');
      await store.createOAuthState({ stateHash, guildId, discordUserId: interaction.user.id, accountId, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
      const url = oauth.createAuthorizationUrl(state);
      return interaction.reply({ content: `🔐 **Autorize sua conta TikTok**\n\n[Continuar para o TikTok](${url})\n\nO link expira em 10 minutos. Confira se o endereço pertence ao TikTok antes de autorizar. A Minako solicitará apenas as permissões de perfil básico e lista de vídeos.`, flags: EPH });
    }

    if (sub === 'desconectar') {
      const accountId = interaction.options.getInteger('id', true);
      const credentials = await store.getAccountTokenCiphertext({ guildId, accountId, discordUserId: interaction.user.id });
      if (!credentials) return interaction.reply({ content: 'Não encontrei uma conta vinculada a você com esse ID.', flags: EPH });
      let remoteRevoked = false;
      if (credentials.access_token_ciphertext) {
        try { remoteRevoked = await oauth.revokeToken(oauth.decryptToken(credentials.access_token_ciphertext)); }
        catch (error) { console.warn('[TikTok] Falha ao revogar autorização remota:', error.message); }
      }
      const result = await store.disconnectAccount({ guildId, accountId, discordUserId: interaction.user.id });
      if (!result) return interaction.reply({ content: 'Não foi possível concluir a desconexão local.', flags: EPH });
      return interaction.reply({ content: `🔌 A conta **@${result.username}** foi desconectada e os tokens locais foram removidos.${remoteRevoked ? ' A autorização também foi revogada no TikTok.' : ' Não consegui confirmar a revogação no TikTok; se necessário, remova a autorização nas configurações de aplicativos do TikTok.'}`, flags: EPH });
    }

    if (sub === 'listar') {
      if (!isAdmin(interaction)) return deny(interaction);
      const accounts = await store.listAccounts(guildId);
      const settings = await store.getSettings(guildId);
      const activeCount = accounts.filter(a => a.approval_status !== 'rejected').length;
      const lines = accounts.slice(0, 20).map(a => {
        const errorSuffix = a.last_error ? ` — ⚠️ ${String(a.last_error).slice(0, 80)}` : '';
        return `**#${a.id}** @${a.username} — ${a.approval_status} / ${a.connection_status} — titular <@${a.owner_discord_id}>${errorSuffix}`;
      });
      return interaction.reply({ content: `**TikTok Watcher · Contas (${activeCount}/${settings.maxAccounts})**\n${lines.length ? lines.join('\n') : 'Nenhuma conta cadastrada.'}${accounts.length > 20 ? '\n…' : ''}`, flags: EPH, allowedMentions: { users: [] } });
    }

    if (sub === 'canal') {
      if (!isAdmin(interaction)) return deny(interaction);
      const channel = interaction.options.getChannel('canal', true);
      if (channel.guildId !== guildId || channel.type !== ChannelType.GuildText) return interaction.reply({ content: 'Selecione um canal de texto deste servidor.', flags: EPH });
      const me = interaction.guild.members.me;
      const perms = me && channel.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return interaction.reply({ content: 'Não tenho as permissões Ver Canal, Enviar Mensagens e Inserir Links nesse canal.', flags: EPH });
      await store.saveSettings(guildId, { notificationChannelId: channel.id });
      return interaction.reply({ content: `📣 Canal de notificações TikTok definido: ${channel}.`, flags: EPH });
    }
  }
};
