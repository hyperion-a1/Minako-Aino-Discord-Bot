const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../utils/config');
const { weekIdFor } = require('../utils/week');
const { normalizeWeekId, isConfiguredWeekStart, registerManualWeek } = require('../utils/manualHistory');

const command = new SlashCommandBuilder()
  .setName('minako-registrar-semana')
  .setDescription('Registra manualmente o Top 5 de uma semana histórica.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o => o.setName('semana').setDescription('Início da semana em YYYY-MM-DD. Ex.: 2026-09-28.').setRequired(true));

for (let i = 1; i <= 5; i++) {
  command
    .addStringOption(o => o.setName(`membro${i}`).setDescription(`ID ou menção do membro que ficou em ${i}º lugar.`).setRequired(true))
    .addIntegerOption(o => o.setName(`mensagens${i}`).setDescription(`Mensagens válidas do ${i}º colocado.`).setMinValue(0).setRequired(true));
}

module.exports = {
  data: command,

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const config = await getConfig(interaction.guildId);
      const weekId = normalizeWeekId(interaction.options.getString('semana', true));
      if (!isConfiguredWeekStart(weekId, config)) {
        return interaction.editReply(`❌ **${weekId}** não corresponde ao dia de início configurado para a semana. A configuração atual começa no dia **${config.weekStartDay}** (0=domingo, 1=segunda...).`);
      }

      const currentWeek = weekIdFor(new Date(), config);
      if (weekId >= currentWeek) {
        return interaction.editReply('❌ Este comando é destinado ao histórico. Para a semana atual, a Minako continua usando os dados vivos da Ami.');
      }

      const members = [];
      const seen = new Set();
      for (let i = 1; i <= 5; i++) {
        const raw = interaction.options.getString(`membro${i}`, true).trim();
        const match = raw.match(/^<@!?(\d{17,20})>$/) || raw.match(/^(\d{17,20})$/);
        if (!match) return interaction.editReply(`❌ O campo **membro${i}** deve conter uma menção do Discord (ex.: <@123...>) ou o ID numérico do usuário.`);
        const userId = match[1];
        if (seen.has(userId)) return interaction.editReply(`❌ O membro <@${userId}> foi informado mais de uma vez.`);
        seen.add(userId);
        members.push({ userId, position: i, messages: interaction.options.getInteger(`mensagens${i}`, true) });
      }

      const stats = await registerManualWeek(interaction.guildId, weekId, members);
      const lines = [
        '✅ **Semana histórica registrada.**',
        '',
        `• Semana: **${weekId}**`,
        '• Fonte: **registro manual de moderador**',
        '',
        '**Top 5 e histórico calculado**'
      ];

      for (const row of stats) {
        lines.push(`${row.position}. <@${row.userId}> — **${row.messages}** mensagens · 📨 **${row.totalAppearances}** participações · 🔥 **${row.maxStreak}** sequência máxima`);
      }

      lines.push('', 'Se essa semana já existia, os cinco registros anteriores foram substituídos pelos dados informados agora.');
      return interaction.editReply(lines.join('\n'));
    } catch (error) {
      console.error('[Minako] minako-registrar-semana:', error);
      return interaction.editReply(`❌ ${String(error.message || error).slice(0, 1500)}`);
    }
  }
};
