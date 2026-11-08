'use strict';
// Comandos de manutenção do matchmaking. Cada subcomando valida o nível de permissão no código
// (o Discord não esconde o comando de quem não tem o papel de manutenção).
const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const store = require('../utils/matchmaking/store');
const perms = require('../utils/matchmaking/permissions');
const central = require('../utils/matchmaking/central');
const tstore = require('../utils/matchmaking/teamStore');
const rstore = require('../utils/matchmaking/reliabilityStore');
const rflow = require('../utils/matchmaking/reliabilityFlow');

const EPH = MessageFlags.Ephemeral;
const deny = (i, what) => i.reply({ content: `🚫 Você não tem permissão para ${what}.`, flags: EPH });

module.exports = {
  data: new SlashCommandBuilder().setName('minako-matchmaking').setDescription('Manutenção do matchmaking da Minako.')
    .addSubcommand(s => s.setName('status').setDescription('Mostra o diagnóstico do matchmaking.'))
    .addSubcommand(s => s.setName('central').setDescription('Atualiza (ou recria, se tiver sumido) a mensagem da Central.'))
    .addSubcommand(s => s.setName('backup').setDescription('Exporta os dados do matchmaking deste servidor em um arquivo JSON.'))
    .addSubcommand(s => s.setName('historico').setDescription('Mostra o histórico de confiabilidade de uma pessoa (só administração).').addUserOption(o => o.setName('usuario').setDescription('Pessoa').setRequired(true)))
    .addSubcommand(s => s.setName('registro-remover').setDescription('Remove um registro comprovadamente incorreto do histórico.').addIntegerOption(o => o.setName('id').setDescription('Número do registro').setRequired(true).setMinValue(1)).addStringOption(o => o.setName('motivo').setDescription('Motivo (fica anotado)').setRequired(true).setMaxLength(200)))
    .addSubcommand(s => s.setName('dissolver-equipe').setDescription('Dissolve uma equipe (moderação; sem penalidade).').addIntegerOption(o => o.setName('id').setDescription('Número da equipe').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('encerrar-grupo').setDescription('Encerra um grupo (sem penalidade).').addIntegerOption(o => o.setName('id').setDescription('Número do grupo').setRequired(true).setMinValue(1))),
  async execute(interaction) {
    if (!interaction.guildId) return interaction.reply({ content: 'Use isto no servidor.', flags: EPH });
    const sub = interaction.options.getSubcommand();
    if (sub === 'registro-remover') {
      if (!(await perms.can(interaction, 'match.review'))) return deny(interaction, 'corrigir registros de confiabilidade');
      try {
        const r = await rstore.resolve(interaction.guildId, String(interaction.options.getInteger('id')), interaction.user.id, 'remove', interaction.options.getString('motivo'));
        return interaction.reply({ content: `🧹 Registro **#${r.id}** removido. Nada disso gera punição.`, flags: EPH });
      } catch (e) { if (['NOT_FOUND', 'BAD_STATE'].includes(e.code)) return interaction.reply({ content: `🚫 ${e.message}`, flags: EPH }); throw e; }
    }
    if (sub === 'historico') {
      if (!(await perms.can(interaction, 'maintenance'))) return deny(interaction, 'consultar históricos');
      const target = interaction.options.getUser('usuario');
      const ov = await rstore.overview(interaction.guildId, target.id);
      await store.logEvent(interaction.guildId, 'reliability.admin_viewed', { target: target.id, by: interaction.user.id }).catch(() => {});
      return interaction.reply({ content: rflow.overviewText(ov, { admin: true, userId: target.id }), flags: EPH, allowedMentions: { parse: [] } });
    }
    if (sub === 'dissolver-equipe') {
      if (!(await perms.can(interaction, 'group.manage'))) return deny(interaction, 'dissolver equipes');
      try {
        const r = await tstore.disbandTeam(interaction.guildId, String(interaction.options.getInteger('id')), interaction.user.id, { staff: true });
        await store.logEvent(interaction.guildId, 'team.disbanded_by_staff', { teamId: r.team.id, by: interaction.user.id });
        return interaction.reply({ content: r.already ? 'Essa equipe já estava dissolvida.' : `🗑️ Equipe **${r.team.name}** dissolvida. Ninguém foi penalizado; sessões em andamento seguem como grupos.`, flags: EPH });
      } catch (e) { if (e.code === 'NOT_FOUND') return interaction.reply({ content: 'Essa equipe não existe.', flags: EPH }); throw e; }
    }
    if (sub === 'encerrar-grupo') {
      if (!(await perms.can(interaction, 'group.manage'))) return deny(interaction, 'encerrar grupos');
      const id = String(interaction.options.getInteger('id'));
      const cfg = await store.getSettings(interaction.guildId);
      const g = await store.getGroup(interaction.guildId, id);
      if (!g) return interaction.reply({ content: 'Esse grupo não existe.', flags: EPH });
      await store.closeGroupById(interaction.guildId, id, cfg.settings.archiveAfterSec);
      await store.logEvent(interaction.guildId, 'group.closed_by_staff', { groupId: id, by: interaction.user.id });
      void central.requestRefresh(interaction.client, interaction.guildId, { force: true });
      return interaction.reply({ content: `⏹️ Grupo **#${id}** encerrado. Ninguém foi penalizado. O anúncio será atualizado em instantes.`, flags: EPH });
    }
    if (!(await perms.can(interaction, 'maintenance'))) return deny(interaction, 'usar a manutenção do matchmaking');
    if (sub === 'status') {
      const [d, cfg] = await Promise.all([store.getDiagnostics(interaction.guildId), store.getSettings(interaction.guildId)]);
      return interaction.reply({ flags: EPH, content: `**Matchmaking · status**\nSchema: v${d.schemaVersion}\nDisponíveis: ${d.availableNow} · Grupos abertos: ${d.openGroups} · Confirmados: ${d.confirmedGroups}\nPropostas pendentes: ${d.pendingProposals} · Partidas em revisão: ${d.matchesInReview} · Aguardando janela: ${d.matchesPendingWindow}\nFalhas operacionais (24 h): ${d.failuresLast24h}\nCentral: ${cfg.centralChannelId ? `<#${cfg.centralChannelId}>` : 'não configurada'}` });
    }
    if (sub === 'central') {
      await interaction.deferReply({ flags: EPH });
      await central.requestRefresh(interaction.client, interaction.guildId, { force: true });
      return interaction.editReply({ content: '🔄 Pedi a atualização da Central. Se não aparecer, confira canal e permissões em **/minako-configurar → Matchmaking → Diagnóstico**.' });
    }
    if (sub === 'backup') {
      await interaction.deferReply({ flags: EPH });
      const data = await store.exportAll(interaction.guildId);
      const body = JSON.stringify({ exportedAt: new Date().toISOString(), guildId: interaction.guildId, schema: 'minako-mm-backup-v1', tables: data }, null, 2);
      const file = new AttachmentBuilder(Buffer.from(body, 'utf8'), { name: `minako-matchmaking-backup-${new Date().toISOString().slice(0, 10)}.json` });
      return interaction.editReply({ content: '📦 Backup do matchmaking deste servidor. **Guarde com cuidado: contém IDs de usuários.** Para restaurar, use `scripts/mm-restore.js` (veja a documentação).', files: [file] });
    }
    return interaction.reply({ content: 'Subcomando desconhecido.', flags: EPH });
  },
};
