'use strict';

const db = require('./db');
const schema = require('./tiktok_schema');

const DEFAULT_SETTINGS = Object.freeze({
  notificationChannelId: null,
  videoNotificationsEnabled: true,
  liveNotificationsEnabled: false,
  liveAnnouncementsEnabled: false,
  liveMentionCreator: false,
  liveAnnounceAccountCooldownSeconds: 900,
  liveAnnounceGuildCooldownSeconds: 180,
  pollIntervalMinutes: 5,
  maxAccounts: 10,
  approvalMode: 'hybrid'
});

async function ensureSchema() {
  await schema.ensureSchema();
}

async function getSettings(guildId) {
  if (!guildId) throw new TypeError('guildId é obrigatório.');
  const { rows } = await db.getPool().query(
    'SELECT * FROM minako_tiktok_settings WHERE guild_id=$1', [String(guildId)]
  );
  const row = rows[0];
  if (!row) return { guildId: String(guildId), ...DEFAULT_SETTINGS };
  return {
    guildId: row.guild_id,
    notificationChannelId: row.notification_channel_id,
    videoNotificationsEnabled: Boolean(row.video_notifications_enabled),
    liveNotificationsEnabled: false, // legado: anúncios de LIVE nunca são automáticos
    liveAnnouncementsEnabled: Boolean(row.live_announcements_enabled),
    liveMentionCreator: Boolean(row.live_mention_creator),
    liveAnnounceAccountCooldownSeconds: Number(row.live_announce_account_cooldown_seconds),
    liveAnnounceGuildCooldownSeconds: Number(row.live_announce_guild_cooldown_seconds),
    pollIntervalMinutes: Number(row.poll_interval_minutes),
    maxAccounts: Number(row.max_accounts),
    approvalMode: row.approval_mode
  };
}

async function saveSettings(guildId, patch = {}) {
  if (!guildId) throw new TypeError('guildId é obrigatório.');
  const current = await getSettings(guildId);
  const next = { ...current, ...patch };
  const interval = Number(next.pollIntervalMinutes);
  const maxAccounts = Number(next.maxAccounts);
  const accountCooldown = Number(next.liveAnnounceAccountCooldownSeconds);
  const guildCooldown = Number(next.liveAnnounceGuildCooldownSeconds);
  if (!Number.isInteger(interval) || interval < 5 || interval > 60) {
    throw new RangeError('O intervalo deve ser um número inteiro entre 5 e 60 minutos.');
  }
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 10) {
    throw new RangeError('O limite de contas deve estar entre 1 e 10.');
  }
  if (!Number.isInteger(accountCooldown) || accountCooldown < 300 || accountCooldown > 3600) throw new RangeError('O cooldown por criador deve ficar entre 300 e 3600 segundos.');
  if (!Number.isInteger(guildCooldown) || guildCooldown < 60 || guildCooldown > 1800) throw new RangeError('O cooldown global deve ficar entre 60 e 1800 segundos.');
  if (typeof next.videoNotificationsEnabled !== 'boolean' || typeof next.liveAnnouncementsEnabled !== 'boolean' || typeof next.liveMentionCreator !== 'boolean') {
    throw new TypeError('As opções de notificações precisam ser booleanas.');
  }
  if (next.notificationChannelId !== null && next.notificationChannelId !== undefined && (typeof next.notificationChannelId !== 'string' || next.notificationChannelId.length > 32)) {
    throw new TypeError('ID do canal de notificações inválido.');
  }
  if (next.approvalMode !== 'hybrid') throw new RangeError('O modo de aprovação permitido é hybrid.');

  const { rows } = await db.getPool().query(`
    INSERT INTO minako_tiktok_settings
      (guild_id, notification_channel_id, video_notifications_enabled,
       live_notifications_enabled, live_announcements_enabled, live_mention_creator,
       live_announce_account_cooldown_seconds, live_announce_guild_cooldown_seconds,
       poll_interval_minutes, max_accounts, approval_mode, updated_at)
    VALUES ($1,$2,$3,FALSE,$4,$5,$6,$7,$8,$9,'hybrid',now())
    ON CONFLICT (guild_id) DO UPDATE SET
      notification_channel_id=EXCLUDED.notification_channel_id,
      video_notifications_enabled=EXCLUDED.video_notifications_enabled,
      live_notifications_enabled=FALSE,
      live_announcements_enabled=EXCLUDED.live_announcements_enabled,
      live_mention_creator=EXCLUDED.live_mention_creator,
      live_announce_account_cooldown_seconds=EXCLUDED.live_announce_account_cooldown_seconds,
      live_announce_guild_cooldown_seconds=EXCLUDED.live_announce_guild_cooldown_seconds,
      poll_interval_minutes=EXCLUDED.poll_interval_minutes,
      max_accounts=EXCLUDED.max_accounts,
      approval_mode='hybrid', updated_at=now()
    RETURNING *`, [String(guildId), next.notificationChannelId || null,
      Boolean(next.videoNotificationsEnabled), Boolean(next.liveAnnouncementsEnabled), Boolean(next.liveMentionCreator),
      accountCooldown, guildCooldown, interval, maxAccounts]
  );
  const row = rows[0];
  return {
    guildId: row.guild_id,
    notificationChannelId: row.notification_channel_id,
    videoNotificationsEnabled: Boolean(row.video_notifications_enabled),
    liveNotificationsEnabled: false, // legado: anúncios de LIVE nunca são automáticos
    liveAnnouncementsEnabled: Boolean(row.live_announcements_enabled),
    liveMentionCreator: Boolean(row.live_mention_creator),
    liveAnnounceAccountCooldownSeconds: Number(row.live_announce_account_cooldown_seconds),
    liveAnnounceGuildCooldownSeconds: Number(row.live_announce_guild_cooldown_seconds),
    pollIntervalMinutes: Number(row.poll_interval_minutes),
    maxAccounts: Number(row.max_accounts),
    approvalMode: row.approval_mode
  };
}

async function requestAccount({ guildId, username, ownerDiscordId, requestedByDiscordId }) {
  if (!guildId || !username || !ownerDiscordId || !requestedByDiscordId) {
    throw new TypeError('guildId, username, ownerDiscordId e requestedByDiscordId são obrigatórios.');
  }
  const normalized = String(username).trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{2,24}$/.test(normalized)) throw new TypeError('Nome de usuário TikTok inválido.');

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO minako_tiktok_settings (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`, [String(guildId)]);
    const duplicate = await client.query(`SELECT id FROM minako_tiktok_accounts WHERE guild_id=$1 AND lower(username)=lower($2) AND approval_status <> 'rejected' LIMIT 1`, [String(guildId), normalized]);
    if (duplicate.rows[0]) { const error = new Error('Esse perfil TikTok já está cadastrado ou aguardando aprovação neste servidor.'); error.code = 'TIKTOK_ACCOUNT_EXISTS'; throw error; }
    const settings = await client.query('SELECT max_accounts FROM minako_tiktok_settings WHERE guild_id=$1 FOR UPDATE', [String(guildId)]);
    const limit = Number(settings.rows[0]?.max_accounts || DEFAULT_SETTINGS.maxAccounts);
    const count = await client.query(`SELECT COUNT(*)::int AS total FROM minako_tiktok_accounts
      WHERE guild_id=$1 AND approval_status IN ('pending','approved')`, [String(guildId)]);
    if (Number(count.rows[0].total) >= limit) {
      const error = new Error(`O servidor já atingiu o limite de ${limit} criadores solicitados/aprovados.`);
      error.code = 'TIKTOK_ACCOUNT_LIMIT';
      throw error;
    }
    let inserted;
    try {
      inserted = await client.query(`
        INSERT INTO minako_tiktok_accounts
          (guild_id, username, owner_discord_id, requested_by_discord_id, approval_status, connection_status)
        VALUES ($1,$2,$3,$4,'pending','pending')
        RETURNING id, guild_id, username, owner_discord_id, requested_by_discord_id,
          approval_status, connection_status, created_at`,
        [String(guildId), normalized, String(ownerDiscordId), String(requestedByDiscordId)]
      );
    } catch (error) {
      if (error.code === '23505') {
        const friendly = new Error('Esse perfil TikTok já está cadastrado ou aguardando aprovação neste servidor.');
        friendly.code = 'TIKTOK_ACCOUNT_EXISTS';
        throw friendly;
      }
      throw error;
    }
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listAccounts(guildId, { status } = {}) {
  if (!guildId) throw new TypeError('guildId é obrigatório.');
  const params = [String(guildId)];
  let where = 'guild_id=$1';
  if (status) {
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new TypeError('Status inválido.');
    params.push(status);
    where += ' AND approval_status=$2';
  }
  const { rows } = await db.getPool().query(`
    SELECT id, guild_id, tiktok_open_id, username, display_name, owner_discord_id,
      requested_by_discord_id, approval_status, connection_status,
      approved_by_discord_id, approved_at, rejected_by_discord_id, rejected_at,
      last_video_check_at, last_live_check_at, last_error, created_at, updated_at
    FROM minako_tiktok_accounts WHERE ${where} ORDER BY created_at DESC`, params);
  return rows;
}

async function approveAccount({ guildId, accountId, moderatorDiscordId }) {
  const { rows } = await db.getPool().query(`
    UPDATE minako_tiktok_accounts SET approval_status='approved',
      approved_by_discord_id=$3, approved_at=now(), rejected_by_discord_id=NULL,
      rejected_at=NULL, updated_at=now()
    WHERE guild_id=$1 AND id=$2 AND approval_status='pending'
    RETURNING id, guild_id, username, owner_discord_id, approval_status, connection_status`,
    [String(guildId), Number(accountId), String(moderatorDiscordId)]);
  return rows[0] || null;
}

async function rejectAccount({ guildId, accountId, moderatorDiscordId }) {
  const { rows } = await db.getPool().query(`
    UPDATE minako_tiktok_accounts SET approval_status='rejected',
      rejected_by_discord_id=$3, rejected_at=now(), updated_at=now()
    WHERE guild_id=$1 AND id=$2 AND approval_status='pending'
    RETURNING id, guild_id, username, owner_discord_id, approval_status, connection_status`,
    [String(guildId), Number(accountId), String(moderatorDiscordId)]);
  return rows[0] || null;
}


async function createOAuthState({ stateHash, guildId, discordUserId, accountId, expiresAt }) {
  if (!stateHash || !guildId || !discordUserId || !accountId || !expiresAt) throw new TypeError('Dados do estado OAuth incompletos.');
  await db.getPool().query(`DELETE FROM minako_tiktok_oauth_states WHERE expires_at < now() OR consumed_at IS NOT NULL`);
  await db.getPool().query(`INSERT INTO minako_tiktok_oauth_states (state_hash,guild_id,discord_user_id,account_id,expires_at)
    VALUES ($1,$2,$3,$4,$5)`, [String(stateHash), String(guildId), String(discordUserId), Number(accountId), expiresAt]);
}

async function consumeOAuthState(stateHash) {
  if (!stateHash) return null;
  const { rows } = await db.getPool().query(`UPDATE minako_tiktok_oauth_states
    SET consumed_at=now() WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at > now()
    RETURNING guild_id, discord_user_id, account_id`, [String(stateHash)]);
  return rows[0] || null;
}

async function getAccountById(guildId, accountId) {
  const { rows } = await db.getPool().query(`SELECT id, guild_id, tiktok_open_id, username, display_name,
    owner_discord_id, requested_by_discord_id, approval_status, connection_status
    FROM minako_tiktok_accounts WHERE guild_id=$1 AND id=$2`, [String(guildId), Number(accountId)]);
  return rows[0] || null;
}

async function setAccountConnected({ guildId, accountId, discordUserId, openId, displayName, grantedScopes, accessTokenCiphertext,
  refreshTokenCiphertext, tokenExpiresAt, refreshTokenExpiresAt }) {
  const { rows } = await db.getPool().query(`UPDATE minako_tiktok_accounts SET
    tiktok_open_id=$4, display_name=$5, granted_scopes=$6, connection_status='connected',
    access_token_ciphertext=$7, refresh_token_ciphertext=$8, token_expires_at=$9,
    refresh_token_expires_at=$10, last_error=NULL, updated_at=now()
    WHERE guild_id=$1 AND id=$2 AND owner_discord_id=$3 AND approval_status='approved'
    RETURNING id, guild_id, username, display_name, owner_discord_id, approval_status, connection_status`,
    [String(guildId), Number(accountId), String(discordUserId), String(openId), displayName || null, grantedScopes || null,
      accessTokenCiphertext, refreshTokenCiphertext || null, tokenExpiresAt || null, refreshTokenExpiresAt || null]);
  return rows[0] || null;
}

async function getAccountTokenCiphertext({ guildId, accountId, discordUserId }) {
  const { rows } = await db.getPool().query(`SELECT access_token_ciphertext, refresh_token_ciphertext, token_expires_at, refresh_token_expires_at, tiktok_open_id, connection_status, approval_status
    FROM minako_tiktok_accounts WHERE guild_id=$1 AND id=$2 AND owner_discord_id=$3`,
    [String(guildId), Number(accountId), String(discordUserId)]);
  return rows[0] || null;
}

async function updateAccountTokens({ guildId, accountId, openId, accessTokenCiphertext, refreshTokenCiphertext, tokenExpiresAt, refreshTokenExpiresAt }) {
  const { rows } = await db.getPool().query(`UPDATE minako_tiktok_accounts SET
    access_token_ciphertext=$4, refresh_token_ciphertext=$5, token_expires_at=$6,
    refresh_token_expires_at=$7, connection_status='connected', last_error=NULL, updated_at=now()
    WHERE guild_id=$1 AND id=$2 AND tiktok_open_id=$3 AND approval_status='approved'
    RETURNING id`, [String(guildId), Number(accountId), String(openId), accessTokenCiphertext,
      refreshTokenCiphertext, tokenExpiresAt || null, refreshTokenExpiresAt || null]);
  return Boolean(rows[0]);
}

async function markAccountError({ guildId, accountId, message }) {
  await db.getPool().query(`UPDATE minako_tiktok_accounts SET last_error=$3, updated_at=now()
    WHERE guild_id=$1 AND id=$2`, [String(guildId), Number(accountId), String(message || 'Falha na autorização TikTok').slice(0, 500)]);
}

async function disconnectAccount({ guildId, accountId, discordUserId }) {
  const { rows } = await db.getPool().query(`UPDATE minako_tiktok_accounts SET
    connection_status='revoked', access_token_ciphertext=NULL, refresh_token_ciphertext=NULL,
    token_expires_at=NULL, refresh_token_expires_at=NULL, updated_at=now()
    WHERE guild_id=$1 AND id=$2 AND owner_discord_id=$3
    RETURNING id, username, connection_status`, [String(guildId), Number(accountId), String(discordUserId)]);
  return rows[0] || null;
}


async function listMonitorTargets() {
  const { rows } = await db.getPool().query(`
    SELECT a.id, a.guild_id, a.username, a.display_name, a.owner_discord_id,
      a.last_video_check_at, s.notification_channel_id,
      s.video_notifications_enabled, s.poll_interval_minutes
    FROM minako_tiktok_accounts a
    JOIN minako_tiktok_settings s ON s.guild_id=a.guild_id
    WHERE a.approval_status='approved' AND a.connection_status='connected'
      AND a.access_token_ciphertext IS NOT NULL
    ORDER BY a.guild_id, a.id`);
  return rows;
}

async function markVideoCheck({ guildId, accountId }) {
  await db.getPool().query(`UPDATE minako_tiktok_accounts
    SET last_video_check_at=now(), updated_at=now()
    WHERE guild_id=$1 AND id=$2`, [String(guildId), Number(accountId)]);
}

async function clearAccountError({ guildId, accountId }) {
  await db.getPool().query(`UPDATE minako_tiktok_accounts SET last_error=NULL, updated_at=now()
    WHERE guild_id=$1 AND id=$2`, [String(guildId), Number(accountId)]);
}

async function reserveVideoEvent({ guildId, accountId, externalEventId, payload = {} }) {
  const pool = db.getPool();
  await pool.query(`INSERT INTO minako_tiktok_events
    (guild_id, account_id, event_type, external_event_id, title, description, url, cover_url, occurred_at, payload, delivery_status)
    VALUES ($1,$2,'video',$3,$4,$5,$6,$7,$8,$9::jsonb,'pending')
    ON CONFLICT (guild_id, account_id, event_type, external_event_id) DO NOTHING`,
  [String(guildId), Number(accountId), String(externalEventId), payload.title || null,
    payload.description || null, payload.url || null, payload.coverUrl || null,
    payload.occurredAt || null, JSON.stringify(payload)]);
  const { rows } = await pool.query(`SELECT id, delivery_status FROM minako_tiktok_events
    WHERE guild_id=$1 AND account_id=$2 AND event_type='video' AND external_event_id=$3`,
  [String(guildId), Number(accountId), String(externalEventId)]);
  return rows[0] || null;
}

async function markVideoEventSent({ eventId, channelId, messageId }) {
  await db.getPool().query(`UPDATE minako_tiktok_events SET delivery_status='sent',
    notification_channel_id=$2, notification_message_id=$3, delivery_error=NULL
    WHERE id=$1`, [Number(eventId), String(channelId), String(messageId)]);
}

async function markVideoEventFailed({ eventId, message }) {
  await db.getPool().query(`UPDATE minako_tiktok_events SET delivery_status='pending',
    delivery_error=$2 WHERE id=$1 AND delivery_status <> 'sent'`,
  [Number(eventId), String(message || 'Falha ao enviar notificação').slice(0, 500)]);
}

async function recordEvent({ guildId, accountId, eventType, externalEventId, payload = {} }) {
  if (!['video', 'live_started', 'live_ended'].includes(eventType)) throw new TypeError('Tipo de evento TikTok inválido.');
  if (!guildId || !accountId || !externalEventId) throw new TypeError('Identificadores do evento são obrigatórios.');
  const { rows } = await db.getPool().query(`
    INSERT INTO minako_tiktok_events
      (guild_id, account_id, event_type, external_event_id, title, description, url, cover_url, occurred_at, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (guild_id, account_id, event_type, external_event_id) DO NOTHING
    RETURNING id, guild_id, account_id, event_type, external_event_id, created_at`,
    [String(guildId), Number(accountId), eventType, String(externalEventId),
      payload.title || null, payload.description || null, payload.url || null,
      payload.coverUrl || null, payload.occurredAt || null, JSON.stringify(payload)]);
  return rows[0] || null;
}


async function reserveLiveAnnouncement({ guildId, accountId, accountCooldownSeconds = 900, guildCooldownSeconds = 180 }) {
  if (!guildId || !Number.isInteger(Number(accountId)) || Number(accountId) < 1) throw new TypeError('Servidor e conta são obrigatórios.');
  const accountCooldown = Number(accountCooldownSeconds);
  const guildCooldown = Number(guildCooldownSeconds);
  if (!Number.isInteger(accountCooldown) || accountCooldown < 300 || accountCooldown > 3600 ||
      !Number.isInteger(guildCooldown) || guildCooldown < 60 || guildCooldown > 1800) throw new RangeError('Cooldown inválido.');
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const guild = await client.query(`INSERT INTO minako_tiktok_live_announcement_limits (guild_id,last_announced_at)
      VALUES ($1,now()) ON CONFLICT (guild_id) DO UPDATE
      SET last_announced_at=now()
      WHERE minako_tiktok_live_announcement_limits.last_announced_at <= now() - ($2 * interval '1 second')
      RETURNING last_announced_at`, [String(guildId), guildCooldown]);
    if (!guild.rowCount) {
      const q = await client.query(`SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (last_announced_at + ($2 * interval '1 second') - now())))::int) AS retry
        FROM minako_tiktok_live_announcement_limits WHERE guild_id=$1`, [String(guildId), guildCooldown]);
      await client.query('ROLLBACK');
      return { ok: false, scope: 'guild', retryAfterSeconds: Number(q.rows[0]?.retry || guildCooldown) };
    }
    const account = await client.query(`INSERT INTO minako_tiktok_live_account_limits (guild_id,account_id,last_announced_at)
      VALUES ($1,$2,now()) ON CONFLICT (guild_id,account_id) DO UPDATE
      SET last_announced_at=now()
      WHERE minako_tiktok_live_account_limits.last_announced_at <= now() - ($3 * interval '1 second')
      RETURNING last_announced_at`, [String(guildId), Number(accountId), accountCooldown]);
    if (!account.rowCount) {
      const q = await client.query(`SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (last_announced_at + ($3 * interval '1 second') - now())))::int) AS retry
        FROM minako_tiktok_live_account_limits WHERE guild_id=$1 AND account_id=$2`, [String(guildId), Number(accountId), accountCooldown]);
      await client.query('ROLLBACK');
      return { ok: false, scope: 'account', retryAfterSeconds: Number(q.rows[0]?.retry || accountCooldown) };
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = {
  DEFAULT_SETTINGS, ensureSchema, getSettings, saveSettings,
  requestAccount, listAccounts, approveAccount, rejectAccount, recordEvent,
  listMonitorTargets, markVideoCheck, clearAccountError, reserveVideoEvent, markVideoEventSent, markVideoEventFailed,
  createOAuthState, consumeOAuthState, getAccountById, setAccountConnected, getAccountTokenCiphertext, updateAccountTokens, markAccountError, disconnectAccount, reserveLiveAnnouncement
};
