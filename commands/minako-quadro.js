const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../utils/config');
const { prepareAndSendNow } = require('../utils/nightlyScheduler');

const data = new SlashCommandBuilder()
  .setName('minako-quadro')
  .setDescription('Prepara ou atualiza o rascunho das Estrelas da Semana.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

module.exports = {
  data,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const config = await getConfig(interaction.guildId);
      if (!config.moderationChannelId) {
        return interaction.editReply('🌙 **Ops, estrelinha!** Primeiro me diga onde fica o cantinho da moderação com `/minako-configurar`. ✨');
      }
      if (!config.publicationChannelId) {
        return interaction.editReply('🌙 **Quase lá!** Também preciso do canal de publicação configurado em `/minako-configurar` antes de preparar o quadro. ✨');
      }

      const result = await prepareAndSendNow(interaction.guild);
      const channelMention = `<#${result.moderationChannelId}>`;
      return interaction.editReply(
        `✨ **Prontinho!** A Minako congelou o resultado da semana encerrada, preparou o rascunho e confirmou que a mensagem chegou ao canal de moderação ${channelMention}.\n\n🔎 [Abrir o rascunho no Discord](${result.moderationMessageUrl})`
      );
    } catch (error) {
      console.error(`[Minako] /minako-quadro:`, error);
      return interaction.editReply(
        `💫 **Ai, ai... encontrei uma estrelinha fora do lugar!**\n\n${String(error?.message || error).slice(0, 1800)}\n\nA Minako **não marcou o quadro como enviado** enquanto não conseguiu confirmar a mensagem no Discord.`
      );
    }
  }
};
