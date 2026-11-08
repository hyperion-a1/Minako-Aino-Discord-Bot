const {
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');
const db = require('./db');
const { getConfig } = require('./config');
const { shiftWeekId } = require('./week');
const { buildHistoryByWeek, historyTopMap } = require('./rankingHistory');
const { ACHIEVEMENTS, buildReviewEmbed, buildPublicEmbed } = require('./editorial');
const { EMOJIS } = require('./minakoEmojis');

const reviewSessions = new Map();
const SESSION_TTL_MS = 14 * 60 * 1000;

function sessionKey(interaction, weekId) {
  return `${interaction.guildId}:${interaction.user.id}:${weekId}`;
}
function rememberReviewSession(interaction, weekId) {
  reviewSessions.set(sessionKey(interaction, weekId), {
    webhook: interaction.webhook,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
}
function getReviewSession(interaction, weekId) {
  const key = sessionKey(interaction, weekId);
  const session = reviewSessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    reviewSessions.delete(key);
    return null;
  }
  return session;
}

function isModerator(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function buttons(weekId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`minako:correct:${weekId}`).setLabel('Corrigir Top 5').setStyle(ButtonStyle.Secondary).setEmoji(EMOJIS.tools),
      new ButtonBuilder().setCustomId(`minako:achievement:${weekId}`).setLabel('Adicionar conquista').setStyle(ButtonStyle.Secondary).setEmoji(EMOJIS.estrelinha),
      new ButtonBuilder().setCustomId(`minako:refresh:${weekId}`).setLabel('Atualizar Quadro').setStyle(ButtonStyle.Primary).setEmoji(EMOJIS.relogio),
      new ButtonBuilder().setCustomId(`minako:final:${weekId}`).setLabel('Ver quadro final').setStyle(ButtonStyle.Success).setEmoji(EMOJIS.lista)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`minako:achievement-remove:${weekId}`).setLabel('Remover conquista').setStyle(ButtonStyle.Danger).setEmoji(EMOJIS.atencao),
      new ButtonBuilder().setCustomId(`minako:publish:${weekId}`).setLabel('Publicar Quadro').setStyle(ButtonStyle.Success).setEmoji(EMOJIS.aprovado)
    )
  ];
}

async function updateReviewMessage(interaction, weekId, payload, config, content = null) {
  const session = getReviewSession(interaction, weekId);
  const options = {
    embeds: [new EmbedBuilder(buildReviewEmbed(payload, config))],
    components: buttons(weekId)
  };
  if (content !== null) options.content = content;

  if (session) {
    try {
      await session.webhook.editMessage('@original', options);
      rememberReviewSession(interaction, weekId);
      return true;
    } catch (error) {
      console.warn('[Minako] Não foi possível atualizar a prévia efêmera:', error.message);
    }
  }

  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    try {
      await interaction.update(options);
      rememberReviewSession(interaction, weekId);
      return true;
    } catch {}
  }
  return false;
}

async function load(guildId, weekId) {
  const row = await db.loadEditorial(guildId, weekId);
  if (!row) throw new Error('Não existe rascunho para esta semana.');
  return row;
}

async function showReview(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const config = await getConfig(interaction.guildId);
  await interaction.reply({ ephemeral: true, content: '💖 **A Minako abriu a salinha de revisão!** Vamos deixar esse quadro brilhando?', embeds: [new EmbedBuilder(buildReviewEmbed(row.payload, config))], components: buttons(weekId) });
  rememberReviewSession(interaction, weekId);
}

function parseUserId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^<@!?(\d{17,20})>$/) || s.match(/^(\d{17,20})$/);
  return m?.[1] || null;
}

function parseCorrectionValue(raw, position) {
  const value = String(raw || '').trim();
  const parts = value.split('|').map(x => x.trim());
  if (parts.length !== 2) throw new Error(`Na ${position}ª posição, use **ID ou menção | mensagens**.`);
  const userId = parseUserId(parts[0]);
  const messages = Number(parts[1]);
  if (!userId) throw new Error(`A ${position}ª posição precisa de um ID ou menção válida.`);
  if (!Number.isInteger(messages) || messages < 0) throw new Error(`A quantidade de mensagens da ${position}ª posição deve ser um inteiro não negativo.`);
  return { userId, messages };
}

async function correctModal(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const modal = new ModalBuilder().setCustomId(`minako:correct-modal:${weekId}`).setTitle('Corrigir o Top 5');
  for (let i = 1; i <= 5; i++) {
    const current = row.payload.top5[i - 1];
    const value = current ? `<@${current.userId}> | ${current.messages}` : '';
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(`top${i}`)
        .setLabel(`${i}º lugar — ID/menção | mensagens`)
        .setStyle(TextInputStyle.Short)
        .setValue(value)
        .setRequired(true)
    ));
  }
  return interaction.showModal(modal);
}

function recalculateCurrentTop(weekId, top5, manualRows, snapshotRows = []) {
  const byWeek = buildHistoryByWeek(manualRows, snapshotRows, weekId);
  const historyTop = historyTopMap(byWeek);
  const historyWeeks = [...byWeek.keys()].sort();
  const previousWeek = shiftWeekId(weekId, -1);
  const previousRows = byWeek.get(previousWeek) || [];
  const previousTop = [...previousRows].sort((a, b) => Number(a.position) - Number(b.position));
  const previousPositions = new Map(previousTop.map(r => [String(r.user_id ?? r.userId), Number(r.position)]));

  historyTop.set(weekId, top5.map(r => String(r.userId)));
  const knownWeeks = [...new Set([...historyWeeks, weekId])].sort();

  const wasTop = (userId, wk) => (historyTop.get(wk) || []).includes(String(userId));
  const countAppearances = userId => knownWeeks.filter(wk => wasTop(userId, wk)).length;
  const currentStreak = userId => {
    let streak = 1;
    for (let n = 1; n < 1000; n++) {
      const wk = shiftWeekId(weekId, -n);
      if (!byWeek.has(wk) || !wasTop(userId, wk)) break;
      streak++;
    }
    return streak;
  };
  const maxStreak = userId => {
    let best = 0;
    let run = 0;
    let previous = null;
    for (const wk of knownWeeks) {
      if (!wasTop(userId, wk)) {
        run = 0;
        previous = wk;
        continue;
      }
      run = previous && shiftWeekId(previous, 1) === wk ? run + 1 : 1;
      best = Math.max(best, run);
      previous = wk;
    }
    return Math.max(1, best);
  };
  const priorAppearance = userId => historyWeeks.some(wk => wk < weekId && wasTop(userId, wk));
  const spentFourFullWeeksOut = userId => {
    for (let n = 1; n <= 4; n++) {
      const wk = shiftWeekId(weekId, -n);
      if (!byWeek.has(wk) || wasTop(userId, wk)) return false;
    }
    return true;
  };

  return top5.map((entry, index) => {
    const position = index + 1;
    const previousPosition = previousPositions.get(String(entry.userId)) || null;
    const previousRow = previousRows.find(r => String(r.user_id ?? r.userId) === String(entry.userId)) || null;
    const priorTop = priorAppearance(entry.userId);
    const isReturner = priorTop && previousPosition === null && spentFourFullWeeksOut(entry.userId);
    const previousMessages = previousRow ? Number(previousRow.messages) : 0;
    const growthPercent = previousPosition !== null && previousRow && previousMessages > 0
      ? Number((((entry.messages - previousMessages) / previousMessages) * 100).toFixed(2))
      : null;

    let movement = 'first';
    if (previousPosition !== null) {
      if (previousPosition > position) movement = 'up';
      else if (previousPosition < position) movement = 'down';
      else movement = 'steady';
    } else if (isReturner) movement = 'return';
    else if (priorTop) movement = 'steady';

    return {
      ...entry,
      position,
      points: entry.messages,
      previousPosition,
      movement,
      streak: currentStreak(entry.userId),
      maxStreak: maxStreak(entry.userId),
      totalAppearances: countAppearances(entry.userId),
      growthPercent,
      isReturner
    };
  });
}

async function correctSubmit(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const parsed = [];
  for (let i = 1; i <= 5; i++) parsed.push(parseCorrectionValue(interaction.fields.getTextInputValue(`top${i}`), i));
  const ids = new Set(parsed.map(x => x.userId));
  if (ids.size !== 5) throw new Error('O Top 5 não pode conter o mesmo membro mais de uma vez.');

  const [manualRows, snapshotRows] = await Promise.all([
    db.loadManualHistoryRankings(interaction.guildId),
    db.listActivitySnapshots(interaction.guildId)
  ]);
  const top5 = recalculateCurrentTop(weekId, parsed, manualRows, snapshotRows);
  const payload = {
    ...row.payload,
    top5,
    corrections: [...(row.payload.corrections || []), { by: interaction.user.id, at: new Date().toISOString() }]
  };
  await db.updateEditorial(interaction.guildId, weekId, { payload, status: 'DRAFT' });

  const config = await getConfig(interaction.guildId);
  await interaction.deferReply({ ephemeral: true });
  const updated = await updateReviewMessage(interaction, weekId, payload, config, '✨ **Prontinho!** A Minako atualizou o Top 5 e recalculou os indicadores.');
  if (updated) return interaction.deleteReply().catch(() => {});
  return interaction.editReply('💫 A prévia expirou. Clique em **Conferir Quadro** novamente e a Minako continua exatamente do rascunho salvo.');
}

async function achievementSelect(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const config = await getConfig(interaction.guildId);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`minako:achievement-select:${weekId}`)
    .setPlaceholder('Escolha a conquista')
    .addOptions(ACHIEVEMENTS.map(a => ({ label: a.title, value: a.key, description: a.description.slice(0, 100) })));
  return interaction.update({ content: '💖 **Vamos escolher uma conquista!** Qual estrela brilhou de um jeitinho especial?', embeds: [new EmbedBuilder(buildReviewEmbed(row.payload, config))], components: [new ActionRowBuilder().addComponents(select)] }).then(() => rememberReviewSession(interaction, weekId));
}

async function achievementChosen(interaction, weekId) {
  const key = interaction.values[0];
  const a = ACHIEVEMENTS.find(x => x.key === key);
  if (!a) throw new Error('Conquista inválida.');
  const modal = new ModalBuilder().setCustomId(`minako:achievement-modal:${weekId}:${key}`).setTitle(a.title);
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('userId').setLabel('ID ou menção do destinatário').setStyle(TextInputStyle.Short).setRequired(true)
  ));
  return interaction.showModal(modal);
}

async function achievementSubmit(interaction, weekId, key) {
  const a = ACHIEVEMENTS.find(x => x.key === key);
  if (!a) throw new Error('Conquista inválida.');
  const userId = parseUserId(interaction.fields.getTextInputValue('userId'));
  if (!userId) throw new Error('Informe um ID ou menção válida.');

  const row = await load(interaction.guildId, weekId);
  const achievements = [...(row.payload.achievements || [])];
  if (achievements.some(x => x.key === key && x.userId === userId)) {
    await interaction.deferReply({ ephemeral: true });
    const config = await getConfig(interaction.guildId);
    const updated = await updateReviewMessage(interaction, weekId, row.payload, config, `💫 **Opa!** <@${userId}> já está com **${a.title}** neste rascunho. A Minako não vai colocar a mesma estrelinha duas vezes! 💕`);
    if (updated) return interaction.deleteReply().catch(() => {});
    return interaction.editReply('💫 A prévia expirou. Clique em **Conferir Quadro** novamente para continuar a revisão.');
  }
  if (await db.hasAchievementGrant(interaction.guildId, userId, key)) {
    await interaction.deferReply({ ephemeral: true });
    const config = await getConfig(interaction.guildId);
    const updated = await updateReviewMessage(interaction, weekId, row.payload, config, `🌟 **Ops!** <@${userId}> já recebeu **${a.title}** anteriormente. Essa conquista é única para cada membro, combinado? 💕`);
    if (updated) return interaction.deleteReply().catch(() => {});
    return interaction.editReply('💫 A prévia expirou. Clique em **Conferir Quadro** novamente e tente adicionar a conquista outra vez.');
  }

  achievements.push({ key, title: a.title, emoji: a.emoji, description: a.description, userId, addedBy: interaction.user.id });
  const payload = { ...row.payload, achievements };
  await db.updateEditorial(interaction.guildId, weekId, { payload, status: 'DRAFT' });
  await interaction.deferReply({ ephemeral: true });
  const config = await getConfig(interaction.guildId);
  const updated = await updateReviewMessage(interaction, weekId, payload, config, `✨ **Conquista adicionada!** <@${userId}> ganhou **${a.title}** no rascunho. Que momento lindo! 💖`);
  if (updated) return interaction.deleteReply().catch(() => {});
  return interaction.editReply('💫 A prévia expirou. Clique em **Conferir Quadro** novamente para continuar a revisão.');
}

async function achievementRemoveSelect(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const achievements = row.payload.achievements || [];
  const config = await getConfig(interaction.guildId);
  if (!achievements.length) {
    return interaction.update({ content: '💫 Ainda não há conquistas no rascunho para remover. A Minako guardou o botão aqui só por garantia! ✨', embeds: [new EmbedBuilder(buildReviewEmbed(row.payload, config))], components: buttons(weekId) }).then(() => rememberReviewSession(interaction, weekId));
  }
  const options = achievements.map((a, index) => ({
    label: `${a.title} — ${a.userId}`.slice(0, 100),
    value: String(index),
    description: 'Remover esta conquista do rascunho.'
  }));
  const select = new StringSelectMenuBuilder().setCustomId(`minako:achievement-remove-select:${weekId}`).setPlaceholder('Escolha a conquista a remover').addOptions(options);
  return interaction.update({ content: '🧹 **Ops, uma estrelinha entrou por engano?** Escolha qual conquista sai do rascunho.', embeds: [new EmbedBuilder(buildReviewEmbed(row.payload, config))], components: [new ActionRowBuilder().addComponents(select)] }).then(() => rememberReviewSession(interaction, weekId));
}

async function achievementRemoveChosen(interaction, weekId) {
  const index = Number(interaction.values[0]);
  const row = await load(interaction.guildId, weekId);
  const achievements = [...(row.payload.achievements || [])];
  if (!Number.isInteger(index) || !achievements[index]) throw new Error('Conquista não encontrada no rascunho.');
  const removed = achievements.splice(index, 1)[0];
  const payload = { ...row.payload, achievements };
  await db.updateEditorial(interaction.guildId, weekId, { payload, status: 'DRAFT' });
  const config = await getConfig(interaction.guildId);
  return interaction.update({ content: `🧹 **Prontinho!** A conquista **${removed.title}** de <@${removed.userId}> saiu do rascunho.`, embeds: [new EmbedBuilder(buildReviewEmbed(payload, config))], components: buttons(weekId) }).then(() => rememberReviewSession(interaction, weekId));
}

async function refresh(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const config = await getConfig(interaction.guildId);
  if (row.moderation_message_id) {
    try {
      const channel = await interaction.guild.channels.fetch(config.moderationChannelId);
      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(row.moderation_message_id);
        await message.edit({ embeds: [new EmbedBuilder(buildReviewEmbed(row.payload, config))], components: buttons(weekId) });
      }
    } catch (error) {
      console.warn('[Minako] Não foi possível atualizar o rascunho no canal de moderação:', error.message);
    }
  }
  const result = await interaction.update({ content: '💫 **Quadro atualizado!** O rascunho do canal de moderação e esta prévia estão sincronizados. ✨', embeds: [new EmbedBuilder(buildReviewEmbed(row.payload, config))], components: buttons(weekId) });
  rememberReviewSession(interaction, weekId);
  return result;
}

async function finalView(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const config = await getConfig(interaction.guildId);
  const result = await interaction.update({ content: '👀 **Espiadinha no quadro final!** Ainda não foi publicado — a Minako só está deixando você conferir tudo com calma. ✨', embeds: [new EmbedBuilder(buildPublicEmbed(row.payload, config))], components: buttons(weekId) });
  rememberReviewSession(interaction, weekId);
  return result;
}

async function findExistingPublicationMessage(channel, clientUserId, weekId) {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find(message =>
      message.author?.id === clientUserId &&
      message.embeds?.some(embed =>
        String(embed.title || '').includes('Estrelas da Semana') &&
        String(embed.description || '').includes(weekId)
      )
    ) || null;
  } catch (error) {
    console.warn('[Minako] Não foi possível procurar uma publicação existente:', error.message);
    return null;
  }
}

async function applyRewards(guild, config, row, weekId) {
  const results = { starRole: false, achievementRoles: 0, achievementGrants: 0, failures: [] };
  const starRole = config.starRoleId ? await guild.roles.fetch(config.starRoleId).catch(() => null) : null;
  if (!starRole) results.failures.push('O cargo Estrela da Semana não pôde ser encontrado.');

  for (const entry of row.payload.top5 || []) {
    const member = await guild.members.fetch(entry.userId).catch(() => null);
    if (!member) {
      results.failures.push(`Não encontrei o membro ${entry.userId} para aplicar o cargo Estrela da Semana.`);
      continue;
    }
    if (starRole) {
      try { await member.roles.add(starRole, 'Estrela da Semana — publicação Minako'); }
      catch (error) { results.failures.push(`Não consegui aplicar Estrela da Semana a ${entry.userId}: ${error.message}`); }
    }
  }
  results.starRole = Boolean(starRole);

  const achievementKeys = [...new Set((row.payload.achievements || []).map(a => a.key))];
  if (achievementKeys.length) {
    const definitions = await db.loadAchievementDefinitions(achievementKeys);
    const definitionMap = new Map(definitions.map(d => [d.id, d]));
    for (const achievement of row.payload.achievements || []) {
      const grant = await db.createAchievementGrant(
        guild.id,
        achievement.userId,
        achievement.key,
        achievement.addedBy || 'system',
        weekId,
        achievement.title || null,
        { source: 'minako_publication' }
      );
      if (grant) results.achievementGrants++;
      const definition = definitionMap.get(achievement.key);
      if (!definition?.role_id) continue;
      const member = await guild.members.fetch(achievement.userId).catch(() => null);
      const role = await guild.roles.fetch(definition.role_id).catch(() => null);
      if (!member || !role) {
        results.failures.push(`Não consegui aplicar o cargo da conquista ${achievement.title || achievement.key} a ${achievement.userId}.`);
        continue;
      }
      try { await member.roles.add(role, `Conquista ${achievement.title || achievement.key} — publicação Minako`); results.achievementRoles++; }
      catch (error) { results.failures.push(`Não consegui aplicar o cargo da conquista ${achievement.title || achievement.key}: ${error.message}`); }
    }
  }
  return results;
}

async function publish(interaction, weekId) {
  const row = await load(interaction.guildId, weekId);
  const config = await getConfig(interaction.guildId);
  if (!config.publicationChannelId) throw new Error('A Minako precisa do canal de publicação configurado antes de abrir as cortinas. ✨');
  if (!config.starRoleId) throw new Error('A Minako precisa do cargo **Estrela da Semana** configurado antes da publicação. 🌟');
  if (row.status === 'CLOSED') {
    return interaction.reply({ ephemeral: true, content: '🌟 **Esse quadro já foi encerrado!** A Minako não vai publicar a mesma semana duas vezes. 💕' });
  }
  if (row.status === 'PUBLISHED') {
    return interaction.reply({ ephemeral: true, content: '✨ **Esse quadro já foi publicado!** A Minako encontrou o registro e deixou tudo certinho, sem duplicar a publicação. 💖' });
  }
  const top5 = row.payload.top5 || [];
  if (top5.length !== 5 || new Set(top5.map(x => x.userId)).size !== 5) {
    throw new Error('O quadro precisa ter exatamente cinco membros diferentes antes de ser publicado. 🌟');
  }

  await db.updateEditorial(interaction.guildId, weekId, { status: 'CLOSING' });
  const channel = await interaction.guild.channels.fetch(config.publicationChannelId);
  if (!channel?.isTextBased()) throw new Error('O canal de publicação configurado não é um canal de texto utilizável.');

  let publicationMessage = null;
  if (row.publication_message_id) {
    publicationMessage = await channel.messages.fetch(row.publication_message_id).catch(() => null);
  }
  if (!publicationMessage) {
    publicationMessage = await findExistingPublicationMessage(channel, interaction.client.user.id, weekId);
  }
  if (!publicationMessage) {
    publicationMessage = await channel.send({ embeds: [new EmbedBuilder(buildPublicEmbed(row.payload, config))] });
  }
  await db.updateEditorial(interaction.guildId, weekId, { status: 'CLOSING', publicationMessageId: publicationMessage.id });

  const rewards = await applyRewards(interaction.guild, config, row, weekId);
  if (rewards.failures.length) {
    throw new Error(`A publicação foi criada, mas a Minako encontrou alguns detalhes nas recompensas:\n${rewards.failures.map(x => `• ${x}`).join('\n')}\n\nO quadro continua salvo como **CLOSING** para podermos retomar com segurança. 💫`);
  }

  const published = await db.updateEditorial(interaction.guildId, weekId, { status: 'CLOSED', publicationMessageId: publicationMessage.id });
  if (row.moderation_message_id) {
    const moderationChannel = await interaction.guild.channels.fetch(config.moderationChannelId).catch(() => null);
    if (moderationChannel?.isTextBased()) {
      const moderationMessage = await moderationChannel.messages.fetch(row.moderation_message_id).catch(() => null);
      if (moderationMessage) {
        await moderationMessage.edit({
          content: '🌟 **Quadro publicado!** A Minako abriu as cortinas — esta é a versão oficial da semana. 💖',
          embeds: [new EmbedBuilder(buildPublicEmbed(published.payload, config))],
          components: []
        }).catch(() => {});
      }
    }
  }

  return interaction.reply({ ephemeral: true, content: `🎉 **Publicação concluída!** A Minako anunciou as Estrelas da Semana em ${channel}. Os registros e recompensas também ficaram guardadinhos. ✨` });
}

async function handle(interaction) {
  if (!isModerator(interaction)) return interaction.reply({ content: '💫 Opa! Só quem tem **Gerenciar Servidor** pode revisar o quadro, combinado? ✨', ephemeral: true });
  const id = interaction.customId;
  const parts = id.split(':');
  const action = parts[1];
  const weekId = parts[2];
  if (action === 'review') return showReview(interaction, weekId);
  if (action === 'correct') return correctModal(interaction, weekId);
  if (action === 'achievement') return achievementSelect(interaction, weekId);
  if (action === 'achievement-select') return achievementChosen(interaction, weekId);
  if (action === 'achievement-modal') return achievementSubmit(interaction, weekId, parts[3]);
  if (action === 'achievement-remove') return achievementRemoveSelect(interaction, weekId);
  if (action === 'achievement-remove-select') return achievementRemoveChosen(interaction, weekId);
  if (action === 'refresh') return refresh(interaction, weekId);
  if (action === 'final') return finalView(interaction, weekId);
  if (action === 'publish') return publish(interaction, weekId);
  if (action === 'correct-modal') return correctSubmit(interaction, weekId);
}

module.exports = { handle };
