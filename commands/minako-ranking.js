const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require('discord.js');
const { getConfig } = require('../utils/config');
const { weekIdFor, shiftWeekId } = require('../utils/week');
const { buildRanking } = require('../utils/ranking');

const EMOJIS = {
  up: '<:S_upAcima:1485679928472109269>',
  down: '<:S_downAbaixo:1485680042007593122>',
  steady: '<:s_reta_azul:1429952418992488469>',
  first: '<a:sa_estrela_brilho:1438631984237772830>',
  return: '<:s_estrelaRetorno:1518657572859678782>',
  top1: '<a:sa_top1:1470448900832755762>',
  top2: '<a:sa_top2:1470449040700342322>',
  top3: '<a:sa_top3:1470449144333336812>',
  crown: '<a:sa_coroa:1470449333588463859>',
  fire: '<:s_fogo:1485680995721281597>',
  purpleFire: '<:s_fogoAzul:1500901034476835007>',
  chart: '<a:saGrfico:1500912105757479022>',
  sparkle: '<a:sa99_shine:1413414940408152127>',
  previous: '<:s_anterior:1429954718666457089>'
};

function pct(value) {
  if (value === null || value === undefined) return '○';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2).replace('.', ',')}%`;
}

function positionEmoji(position) {
  if (position === 1) return EMOJIS.top1;
  if (position === 2) return EMOJIS.top2;
  if (position === 3) return EMOJIS.top3;
  return EMOJIS.crown;
}

function movementEmoji(movement) {
  return EMOJIS[movement] || EMOJIS.first;
}

function formatWeekDate(weekId, config) {
  // weekId is the calendar date of the configured local week start.
  // Use noon UTC only to obtain the correct calendar weekday without shifting
  // the date to the previous evening in America/Sao_Paulo.
  const date = new Date(`${weekId}T12:00:00Z`);
  const [hour = '00', minute = '00'] = String(config.weekStartTime || '00:00').split(':');
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit'
  });
  const clean = value => value.replace('.', '').replace(',', '');
  return `${clean(formatter.format(date))}, ${hour}:${minute}h`;
}

function periodLabel(weekId, config) {
  const start = formatWeekDate(weekId, config);
  const end = formatWeekDate(shiftWeekId(weekId, 1), config);
  return `${start} — ${end}`;
}

function buildStarLine(r) {
  const movement = movementEmoji(r.movement);
  const position = positionEmoji(r.position);
  const growth = pct(r.growthPercent);

  return `${movement} ${position} ${EMOJIS.fire}**${r.streak}** ${EMOJIS.purpleFire}**${r.totalAppearances}** 📨 **${r.messages}** ${EMOJIS.chart} ${growth}\n╰┈: ̗̀➛ || <@${r.userId}> ||`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('minako-ranking')
    .setDescription('Mostra a prévia visual das Estrelas da Semana.'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true, flags: MessageFlags.IsComponentsV2 });

    const config = await getConfig(interaction.guildId);
    const weekId = weekIdFor(new Date(), config);
    const ranking = await buildRanking(interaction.guild, weekId);

    const period = periodLabel(weekId, config);
    const baseDate = new Date(`${weekId}T12:00:00Z`);
    const month = new Intl.DateTimeFormat('pt-BR', {
      timeZone: config.timezone,
      month: 'short'
    }).format(baseDate).replace('.', '');
    const year = baseDate.getUTCFullYear();

    const intro = new TextDisplayBuilder().setContent(
      `-# *Art by boonny_buu*\n\n` +
      `Wow!! Chegaram as estrelas da semana! **Vamos ver, vamos ver**! ${EMOJIS.sparkle}\n\n` +
      `## [Estrelas da Semana] ##\n` +
      `-# ${period}\n` +
      `-# ${month.charAt(0).toUpperCase() + month.slice(1)} ${year} | Prévia`
    );

    const rankingText = ranking.length
      ? ranking.map(buildStarLine).join('\n')
      : 'Ainda não há Top 5 visível nesta semana.';

    const rankingDisplay = new TextDisplayBuilder().setContent(rankingText);

    const footer = new TextDisplayBuilder().setContent(
      `**Parabéns** ao Top 5 desta semana! ${EMOJIS.sparkle}\n\n` +
      `-# ${EMOJIS.previous} A prévia é somente para revisão; ainda não publica nem concede recompensas.`
    );

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('minako-preview-hall').setLabel('Hall das Estrelas').setEmoji('⭐').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('minako-preview-rewards').setLabel('O que eu ganho sendo Estrela?').setEmoji({ id: '1453504130843938982', name: 'sa_medalha', animated: true }).setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId('minako-preview-legend').setLabel('Legenda').setStyle(ButtonStyle.Secondary).setDisabled(true)
    );

    const container = new ContainerBuilder()
      .setAccentColor(0xffa500)
      .addTextDisplayComponents(intro)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(rankingDisplay)
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(footer)
      .addActionRowComponents(buttons);

    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }
};
