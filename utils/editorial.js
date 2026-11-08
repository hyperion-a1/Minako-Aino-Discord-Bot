const { weekLabel } = require('./week');
const { EMOJIS, ACHIEVEMENT_EMOJIS } = require('./minakoEmojis');

const ACHIEVEMENTS = [
  { key: 'ascensao', title: 'Estrela em Ascensão', emoji: ACHIEVEMENT_EMOJIS.ascensao, description: 'Novo membro que, nos seus primeiros 10 dias na comunidade, conquistou uma posição no ranking de Estrelas da Semana.' },
  { key: 'estreia_dominante', title: 'Estreia Dominante', emoji: ACHIEVEMENT_EMOJIS.estreia_dominante, description: 'Vitória na primeira participação em um evento recorrente.' },
  { key: 'harmonia', title: 'Estrela da Harmonia', emoji: ACHIEVEMENT_EMOJIS.harmonia, description: 'Ajudou a conter conflitos nos chats do servidor.' }
];

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '○';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2).replace('.', ',')}%`;
}
function movement(r) {
  if (r.movement === 'up') return EMOJIS.up;
  if (r.movement === 'down') return EMOJIS.down;
  if (r.movement === 'steady') return '➖';
  if (r.movement === 'return') return EMOJIS.retorno;
  return EMOJIS.estrelinha;
}
function positionEmoji(position) {
  if (position === 1) return EMOJIS.top1;
  if (position === 2) return EMOJIS.top2;
  if (position === 3) return EMOJIS.top3;
  if (position === 4) return EMOJIS.coroa;
  if (position === 5) return EMOJIS.coroa;
  return EMOJIS.estrelinha;
}
function achievementLabel(a) {
  const definition = ACHIEVEMENTS.find(x => x.key === a.key);
  return `${a.emoji || definition?.emoji || EMOJIS.estrelinha} **${a.title || definition?.title || 'Conquista'}:** <@${a.userId}>`;
}
function buildPayload(guildId, weekId, config, ranking) {
  return {
    guildId,
    weekId,
    timezone: config.timezone,
    title: 'Estrelas da Semana',
    opening: 'Wow!! Chegaram as estrelas da semana! **Vamos ver, vamos ver!** ✨',
    top5: ranking.map(r => ({
      userId: r.userId,
      position: r.position,
      messages: r.messages,
      points: r.points,
      movement: r.movement,
      previousPosition: r.previousPosition,
      streak: r.streak,
      totalAppearances: r.totalAppearances,
      maxStreak: r.maxStreak,
      growthPercent: r.growthPercent,
      isReturner: r.isReturner
    })),
    achievements: [],
    corrections: [],
    version: 2
  };
}
function buildReviewEmbed(payload, config) {
  const rows = payload.top5 || [];
  const lines = rows.map(r => `${positionEmoji(r.position)} ${movement(r)} <@${r.userId}>  · ${EMOJIS.fogo} **${r.streak}**  · ${EMOJIS.fogoAzul} **${r.totalAppearances}**  · 📨 **${r.messages}**  · ${EMOJIS.grafico} **${pct(r.growthPercent)}**`).join('\n');
  const achievements = (payload.achievements || []).length
    ? payload.achievements.map(achievementLabel).join('\n')
    : 'Nenhuma adicionada ainda.';
  const snapshotLine = payload.snapshotAt
    ? `\n${EMOJIS.calendario} Snapshot congelado: **${new Intl.DateTimeFormat('pt-BR', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(payload.snapshotAt))}**`
    : '';
  return {
    title: `${EMOJIS.estrelaBrilho} Revisão — Estrelas da Semana`,
    description: `${EMOJIS.calendario} Semana: **${payload.weekId}**\n${EMOJIS.pin} Fuso: **${config.timezone}**${snapshotLine}\n\n${lines || 'Nenhum Top 5 disponível.'}\n\n${EMOJIS.medalha} **Conquistas**\n${achievements}`,
    footer: { text: 'Rascunho privado — nada foi publicado e nenhuma recompensa foi aplicada.' }
  };
}
function buildPublicEmbed(payload, config) {
  const rows = payload.top5 || [];
  const lines = rows.map(r => `${positionEmoji(r.position)} ${movement(r)} <@${r.userId}>\n-# ${EMOJIS.fogo} ${r.streak}  ${EMOJIS.fogoAzul} ${r.totalAppearances}  📨 ${r.messages}${r.growthPercent === null || r.growthPercent === undefined ? '' : `  ${EMOJIS.grafico} ${pct(r.growthPercent)}`}`).join('\n\n');
  const achievements = payload.achievements?.length
    ? `\n\n## ${EMOJIS.medalha} Conquistas desbloqueadas\n${payload.achievements.map(achievementLabel).join('\n')}`
    : '';
  return {
    title: `${EMOJIS.estrelaBrilho} Estrelas da Semana`,
    description: `${payload.opening || ''}\n\n-# ${EMOJIS.calendario} ${payload.weekId} | Fuso ${config.timezone}\n\n${lines}\n\n**Parabéns** ao Top 5 desta semana! ${EMOJIS.shine}${achievements}`,
    footer: { text: 'Hall das Estrelas • O que eu ganho sendo Estrela? • Legenda' }
  };
}
module.exports = { ACHIEVEMENTS, buildPayload, buildReviewEmbed, buildPublicEmbed, pct, movement, positionEmoji };
