const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('./db');
const { getConfig } = require('./config');
const { weekIdFor, shiftWeekId } = require('./week');
const { captureActivitySnapshot, buildRanking } = require('./ranking');
const { buildPayload, buildReviewEmbed } = require('./editorial');
const { EMOJIS } = require('./minakoEmojis');
const { processNightMode } = require('./nightMode');
const { applySecurityActions } = require('./securityActions');

const TICK_MS = 20 * 1000;
const SNAPSHOT_GRACE_SECONDS = 120;
const PREPARE_AFTER_MINUTE = 15;
const READY_AFTER_MINUTE = 360; // 06:00 local
const MODERATION_HOUR = 7;
const MODERATION_MINUTE = 0;

let timer = null;
let running = false;

function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function minuteOfWeek(p) {
  const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday);
  return weekday * 1440 + Number(p.hour) * 60 + Number(p.minute);
}

function minutesSinceMonday(p) {
  return minuteOfWeek(p);
}

async function markError(guildId, weekId, error) {
  await db.updateWeeklyCycle(guildId, weekId, {
    status: 'FAILED',
    lastError: String(error?.message || error).slice(0, 2000)
  }).catch(() => {});
}

async function captureForGuild(guild, config, weekId, now) {
  const cycle = await db.loadWeeklyCycle(guild.id, weekId);
  if (cycle?.snapshot_at) return cycle;
  try {
    const ranking = await captureActivitySnapshot(guild, weekId, now);
    console.log(`[Minako] Snapshot ${weekId} congelado em ${guild.name}: ${ranking.length} membros.`);
    return db.loadWeeklyCycle(guild.id, weekId);
  } catch (error) {
    await markError(guild.id, weekId, error);
    console.error(`[Minako] Falha ao congelar ${guild.name}/${weekId}:`, error.message);
    return null;
  }
}

async function prepareEditorial(guild, config, weekId) {
  const cycle = await db.loadWeeklyCycle(guild.id, weekId);
  if (!cycle?.snapshot_at) return cycle;
  if (['DRAFT_READY', 'SENT_TO_MODERATION', 'CLOSED'].includes(cycle.status)) return cycle;

  try {
    const existing = await db.loadEditorial(guild.id, weekId);
    let payload = existing?.payload || null;
    if (!payload) {
      const ranking = await buildRanking(guild, weekId);
      if (ranking.length !== 5) throw new Error('O snapshot não contém exatamente cinco membros.');
      payload = buildPayload(guild.id, weekId, config, ranking);
      payload.snapshotAt = cycle.snapshot_at;
      await db.saveEditorial(guild.id, weekId, 'DRAFT', payload, existing?.moderation_message_id || null);
    }
    const updated = await db.updateWeeklyCycle(guild.id, weekId, {
      status: 'PREPARED',
      preparedAt: new Date(),
      lastError: null
    });
    console.log(`[Minako] Editorial ${weekId} preparado para ${guild.name}.`);
    return updated;
  } catch (error) {
    await markError(guild.id, weekId, error);
    console.error(`[Minako] Falha ao preparar ${guild.name}/${weekId}:`, error.message);
    return null;
  }
}

async function finalizeNightWork(guild, config, weekId) {
  const cycle = await db.loadWeeklyCycle(guild.id, weekId);
  if (!cycle?.prepared_at || ['DRAFT_READY', 'SENT_TO_MODERATION', 'CLOSED'].includes(cycle.status)) return cycle;

  try {
    // Ponto de extensão para tarefas pesadas da madrugada (GIF, mídia etc.).
    const editorial = await db.loadEditorial(guild.id, weekId);
    if (!editorial) throw new Error('O rascunho editorial não foi encontrado.');
    const updated = await db.updateWeeklyCycle(guild.id, weekId, {
      status: 'DRAFT_READY',
      readyAt: new Date(),
      lastError: null
    });
    console.log(`[Minako] Rascunho ${weekId} pronto para moderação em ${guild.name}.`);
    return updated;
  } catch (error) {
    await markError(guild.id, weekId, error);
    console.error(`[Minako] Falha ao finalizar preparação ${guild.name}/${weekId}:`, error.message);
    return null;
  }
}

async function resolveModerationChannel(guild, config) {
  if (!config.moderationChannelId) throw new Error('Canal de moderação não configurado.');
  const channel = await guild.channels.fetch(config.moderationChannelId).catch(() => null);
  if (!channel) throw new Error(`Não consegui localizar o canal de moderação ${config.moderationChannelId}.`);
  if (!channel.isTextBased() || channel.isVoiceBased?.() || channel.isThread?.() || channel.type === 15) {
    throw new Error(`O canal de moderação configurado (${config.moderationChannelId}) não é um canal de texto comum utilizável para o rascunho.`);
  }
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const permissions = me ? channel.permissionsFor(me) : null;
  if (permissions && !permissions.has(PermissionFlagsBits.ViewChannel)) throw new Error('A Minako não pode visualizar o canal de moderação configurado.');
  if (permissions && !permissions.has(PermissionFlagsBits.SendMessages)) throw new Error('A Minako não tem permissão para enviar mensagens no canal de moderação configurado.');
  if (permissions && !permissions.has(PermissionFlagsBits.EmbedLinks)) throw new Error('A Minako não tem permissão para incorporar embeds no canal de moderação configurado.');
  return channel;
}

function moderationComponents(weekId) {
  return [{
    type: 1,
    components: [{ type: 2, style: 1, label: 'Conferir Quadro', custom_id: `minako:review:${weekId}`, emoji: { name: '🔎' } }]
  }];
}

async function sendModerationDraft(guild, config, weekId) {
  const cycle = await db.loadWeeklyCycle(guild.id, weekId);
  if (!cycle?.ready_at || ['SENT_TO_MODERATION', 'CLOSED'].includes(cycle.status)) return cycle;
  const editorial = await db.loadEditorial(guild.id, weekId);
  if (!editorial) throw new Error('O rascunho editorial não foi encontrado no PostgreSQL.');

  const channel = await resolveModerationChannel(guild, config);
  const content = `${EMOJIS.estrelaBrilho} **Bom dia, estrelas!** A Minako passou a madrugada preparando o quadro e deixou o rascunho prontinho para a auditoria. ✨\n\n-# Snapshot congelado na virada da semana. Os dados do Top 5 não serão recalculados durante a revisão.`;
  const payload = {
    content,
    embeds: [new EmbedBuilder(buildReviewEmbed(editorial.payload, config))],
    components: moderationComponents(weekId)
  };

  let message = null;
  if (editorial.moderation_message_id) {
    message = await channel.messages.fetch(editorial.moderation_message_id).catch(() => null);
  }

  if (message) {
    await message.edit(payload);
    console.log(`[Minako] Rascunho ${weekId} atualizado no canal de moderação ${channel.id} (mensagem ${message.id}).`);
  } else {
    message = await channel.send(payload);
    console.log(`[Minako] Rascunho ${weekId} enviado ao canal ${channel.id} (mensagem ${message.id}).`);
  }

  // Confirma que o Discord realmente aceitou a mensagem antes de marcar como enviado.
  const verified = await channel.messages.fetch(message.id).catch(() => null);
  if (!verified) throw new Error(`O Discord aceitou a operação, mas a mensagem ${message.id} não pôde ser confirmada no canal ${channel.id}.`);

  await db.updateEditorial(guild.id, weekId, { moderationMessageId: message.id, status: 'DRAFT' });
  const updated = await db.updateWeeklyCycle(guild.id, weekId, {
    status: 'SENT_TO_MODERATION',
    moderationSentAt: new Date(),
    lastError: null
  });
  return { ...updated, moderationMessageId: message.id, moderationChannelId: channel.id, moderationMessageUrl: `https://discord.com/channels/${guild.id}/${channel.id}/${message.id}` };
}

async function prepareAndSendNow(guild) {
  const config = await getConfig(guild.id);
  const currentWeekId = weekIdFor(new Date());
  const targetWeekId = shiftWeekId(currentWeekId, -1);
  if (!config.moderationChannelId) throw new Error('Configure primeiro o canal de moderação com `/minako-configurar`.');
  const cycle = await db.loadWeeklyCycle(guild.id, targetWeekId);
  if (!cycle?.snapshot_at) {
    await captureForGuild(guild, config, targetWeekId, new Date(`${currentWeekId}T00:00:00-03:00`));
  }
  const prepared = await prepareEditorial(guild, config, targetWeekId);
  if (!prepared?.prepared_at) throw new Error('O snapshot foi criado, mas o rascunho editorial não pôde ser preparado.');
  let ready = await db.loadWeeklyCycle(guild.id, targetWeekId);
  if (!ready?.ready_at) ready = await finalizeNightWork(guild, config, targetWeekId);
  if (!ready?.ready_at) throw new Error('O rascunho foi preparado, mas ainda não pôde ser finalizado.');
  const sent = await sendModerationDraft(guild, config, targetWeekId);
  return sent;
}

async function processGuild(guild) {
  const config = await getConfig(guild.id);
  try { await processNightMode(guild, config); } catch (error) { console.error(`[Minako] Falha no Modo Noturno em ${guild.name}:`, error.message); }
  try { await applySecurityActions(guild); } catch (error) { console.error(`[Minako] Falha nas Ações de Segurança em ${guild.name}:`, error.message); }
  const now = new Date();
  const p = zoneParts(now, 'America/Sao_Paulo');
  const currentWeekId = weekIdFor(now);
  const targetWeekId = shiftWeekId(currentWeekId, -1);
  const minute = minutesSinceMonday(p);

  const targetCycle = await db.loadWeeklyCycle(guild.id, targetWeekId);
  if (!targetCycle?.snapshot_at) {
    try { await captureForGuild(guild, config, targetWeekId, new Date(`${currentWeekId}T00:00:00-03:00`)); }
    catch (error) { console.error(`[Minako] Falha na recuperação do snapshot ${guild.name}/${targetWeekId}:`, error.message); }
  }

  const cycle = await db.loadWeeklyCycle(guild.id, targetWeekId);
  if (!cycle?.snapshot_at) return;

  if (minute >= PREPARE_AFTER_MINUTE && minute < MODERATION_HOUR * 60) await prepareEditorial(guild, config, targetWeekId);
  const prepared = await db.loadWeeklyCycle(guild.id, targetWeekId);
  if (prepared?.prepared_at && minute >= READY_AFTER_MINUTE) await finalizeNightWork(guild, config, targetWeekId);
  const ready = await db.loadWeeklyCycle(guild.id, targetWeekId);
  if (ready?.ready_at && minute >= MODERATION_HOUR * 60) {
    try { await sendModerationDraft(guild, config, targetWeekId); }
    catch (error) { await markError(guild.id, targetWeekId, error); console.error(`[Minako] Falha ao enviar ${guild.name}/${targetWeekId} para moderação:`, error.message); }
  }
}

async function tick(client) {
  if (running) return;
  running = true;
  try { for (const guild of client.guilds.cache.values()) await processGuild(guild); }
  catch (error) { console.error('[Minako] Erro no scheduler semanal:', error); }
  finally { running = false; }
}

function start(client) {
  if (timer) return;
  timer = setInterval(() => tick(client), TICK_MS);
  tick(client).catch(() => {});
  console.log('[Minako] Scheduler semanal ativo.');
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, prepareAndSendNow };
