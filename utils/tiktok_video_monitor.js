'use strict';

const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const store = require('./tiktok_store');
const tokenManager = require('./tiktok_token_manager');

const API_URL = 'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url';
const LOOP_INTERVAL_MS = 60 * 1000;
const OVERLAP_MS = 2 * 60 * 1000;
const MAX_VIDEOS = 20;
let timer = null;
let running = false;
let clientRef = null;

async function fetchVideos(accessToken) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_count: MAX_VIDEOS }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  const apiError = payload?.error;
  if (!response.ok || (apiError?.code && apiError.code !== 'ok')) {
    const code = String(apiError?.code || `HTTP_${response.status}`).slice(0, 80);
    const detail = String(apiError?.message || '').slice(0, 180);
    const error = new Error(`TikTok video.list falhou (${code})${detail ? `: ${detail}` : ''}.`);
    error.code = 'TIKTOK_VIDEO_LIST_FAILED';
    throw error;
  }
  return Array.isArray(payload?.data?.videos) ? payload.data.videos : [];
}

function normalizeVideo(video) {
  const id = String(video?.id || '').trim();
  if (!id) return null;
  const url = typeof video.share_url === 'string' && /^https:\/\//i.test(video.share_url)
    ? video.share_url : `https://www.tiktok.com/video/${encodeURIComponent(id)}`;
  const created = Number(video.create_time);
  return {
    id,
    title: String(video.title || '').trim().slice(0, 256),
    description: String(video.video_description || '').trim().slice(0, 4000),
    url,
    coverUrl: typeof video.cover_image_url === 'string' && /^https:\/\//i.test(video.cover_image_url) ? video.cover_image_url : null,
    occurredAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000) : null,
    createTime: Number.isFinite(created) && created > 0 ? created * 1000 : 0
  };
}

async function sendVideoNotification(client, target, video) {
  const channelId = target.notification_channel_id;
  if (!channelId) throw new Error('Canal de notificações TikTok ainda não configurado.');
  const channel = await client.channels.fetch(String(channelId));
  if (!channel || !channel.isTextBased?.() || !channel.send) throw new Error('O canal de notificações não existe ou não aceita mensagens.');
  if (channel.guildId && channel.guildId !== String(target.guild_id)) throw new Error('O canal configurado não pertence ao servidor da conta.');

  const displayName = String(target.display_name || target.username || 'Criador TikTok').slice(0, 100);
  const embed = new EmbedBuilder()
    .setColor(0xFE2C55)
    .setAuthor({ name: `${displayName} publicou um novo vídeo` })
    .setTitle(video.title || 'Novo vídeo no TikTok')
    .setURL(video.url)
    .setDescription(video.description || 'Um novo vídeo foi publicado. Assista no TikTok.')
    .addFields({ name: 'Perfil', value: `[@${target.username}](https://www.tiktok.com/@${encodeURIComponent(target.username)})`, inline: true })
    .setTimestamp(video.occurredAt || new Date());
  if (video.coverUrl) embed.setImage(video.coverUrl);
  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return { channelId: channel.id, messageId: sent.id };
}

async function deliverEvent(client, target, video) {
  const event = await store.reserveVideoEvent({
    guildId: target.guild_id,
    accountId: target.id,
    externalEventId: video.id,
    payload: video
  });
  if (!event || event.delivery_status === 'sent') return false;
  try {
    const sent = await sendVideoNotification(client, target, video);
    await store.markVideoEventSent({ eventId: event.id, channelId: sent.channelId, messageId: sent.messageId });
    return true;
  } catch (error) {
    await store.markVideoEventFailed({ eventId: event.id, message: error.message }).catch(() => {});
    throw error;
  }
}

async function pollAccount(client, target) {
  const token = await tokenManager.getValidAccessToken({
    guildId: target.guild_id,
    accountId: target.id,
    ownerDiscordId: target.owner_discord_id
  });
  const videos = (await fetchVideos(token)).map(normalizeVideo).filter(Boolean);
  const previousCheck = target.last_video_check_at ? new Date(target.last_video_check_at).getTime() : 0;
  const firstCheck = !previousCheck;
  const cutoff = firstCheck ? 0 : previousCheck - OVERLAP_MS;
  let announced = 0;

  // A primeira consulta é uma linha de base: registra o conteúdo existente sem
  // disparar alertas retroativos. As consultas seguintes anunciam somente novidades.
  for (const video of videos) {
    if (firstCheck || !video.createTime || video.createTime <= cutoff) {
      if (firstCheck) {
        await store.recordEvent({ guildId: target.guild_id, accountId: target.id, eventType: 'video', externalEventId: video.id, payload: video });
      }
      continue;
    }
    if (target.video_notifications_enabled) {
      if (await deliverEvent(client, target, video)) announced += 1;
    } else {
      await store.recordEvent({ guildId: target.guild_id, accountId: target.id, eventType: 'video', externalEventId: video.id, payload: video });
    }
  }
  await store.markVideoCheck({ guildId: target.guild_id, accountId: target.id });
  await store.clearAccountError({ guildId: target.guild_id, accountId: target.id });
  return { username: target.username, count: videos.length, announced, firstCheck };
}

async function runOnce(client = clientRef) {
  if (!client || running) return;
  running = true;
  try {
    const targets = await store.listMonitorTargets();
    const now = Date.now();
    for (const target of targets) {
      const interval = Math.max(5, Math.min(60, Number(target.poll_interval_minutes) || 5)) * 60 * 1000;
      const lastCheck = target.last_video_check_at ? new Date(target.last_video_check_at).getTime() : 0;
      if (lastCheck && now - lastCheck < interval) continue;
      try {
        const result = await pollAccount(client, target);
        console.log(`[TikTok] @${result.username}: ${result.count} vídeo(s) consultado(s), ${result.announced} notificação(ões)${result.firstCheck ? ' (linha de base)' : ''}.`);
      } catch (error) {
        await store.markAccountError({ guildId: target.guild_id, accountId: target.id, message: error.message }).catch(() => {});
        console.warn(`[TikTok] Monitoramento de @${target.username} falhou:`, error.message);
      }
    }
  } catch (error) {
    console.error('[TikTok] Falha ao executar o monitor de vídeos:', error.message);
  } finally {
    running = false;
  }
}

function start(client) {
  if (timer) return;
  clientRef = client;
  // Executa uma primeira leitura ao iniciar e depois verifica a cada minuto;
  // cada conta respeita seu próprio intervalo configurado (mínimo de 5 min).
  runOnce(client).catch(error => console.error('[TikTok] Erro na inicialização do monitor:', error.message));
  timer = setInterval(() => runOnce(client).catch(error => console.error('[TikTok] Erro no ciclo do monitor:', error.message)), LOOP_INTERVAL_MS);
  timer.unref?.();
  console.log('[Minako] TikTok Video Monitor iniciado (intervalo configurável por servidor).');
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  clientRef = null;
}

module.exports = { API_URL, fetchVideos, normalizeVideo, pollAccount, runOnce, start, stop };
