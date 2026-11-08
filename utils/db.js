const { Pool } = require('pg');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_data (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS minako_guilds (
  guild_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  week_start_day INTEGER NOT NULL DEFAULT 1,
  week_start_time TEXT NOT NULL DEFAULT '00:00',
  criterion TEXT NOT NULL DEFAULT 'messages',
  moderation_channel_id TEXT,
  publication_channel_id TEXT,
  star_role_id TEXT,
  partida_admin_role_ids TEXT[] NOT NULL DEFAULT '{}',
  night_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  night_mode_start_time TEXT NOT NULL DEFAULT '01:00',
  night_mode_end_time TEXT NOT NULL DEFAULT '05:00',
  night_mode_notice_channel_ids TEXT[] NOT NULL DEFAULT '{}',
  night_mode_notice_url TEXT,
  night_mode_category_ids TEXT[] NOT NULL DEFAULT '{}',
  night_mode_affected_channel_ids TEXT[] NOT NULL DEFAULT '{}',
  night_mode_immune_channel_ids TEXT[] NOT NULL DEFAULT '{}',
  night_mode_scope_initialized BOOLEAN NOT NULL DEFAULT FALSE,
  seasonal_packages JSONB NOT NULL DEFAULT '{"halloween": true, "natal": true, "ano_novo": true}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS partida_admin_role_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_start_time TEXT NOT NULL DEFAULT '01:00';
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_end_time TEXT NOT NULL DEFAULT '05:00';
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_notice_channel_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_notice_url TEXT;
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_category_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_affected_channel_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_immune_channel_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS night_mode_scope_initialized BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE minako_guilds SET night_mode_affected_channel_ids = night_mode_notice_channel_ids, night_mode_scope_initialized = TRUE WHERE night_mode_scope_initialized=FALSE AND cardinality(night_mode_notice_channel_ids)>0;
ALTER TABLE minako_guilds ADD COLUMN IF NOT EXISTS seasonal_packages JSONB NOT NULL DEFAULT '{"halloween": true, "natal": true, "ano_novo": true}'::jsonb;

CREATE TABLE IF NOT EXISTS minako_personality_state (
  guild_id TEXT PRIMARY KEY,
  week_id TEXT,
  used_phrase_ids TEXT[] NOT NULL DEFAULT '{}',
  last_phrase_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS minako_night_mode_state (
  guild_id TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  active_date TEXT,
  start_notice_date TEXT,
  start_applied_date TEXT,
  end_notice_date TEXT,
  original_overwrites JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE minako_night_mode_state ADD COLUMN IF NOT EXISTS original_overwrites JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS minako_weekly_rankings (
  guild_id TEXT NOT NULL,
  week_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  first_message_at TIMESTAMPTZ,
  streak INTEGER NOT NULL DEFAULT 1,
  previous_position INTEGER,
  movement TEXT,
  total_appearances INTEGER NOT NULL DEFAULT 1,
  growth_percent NUMERIC,
  is_returner BOOLEAN NOT NULL DEFAULT FALSE,
  source_message_id TEXT,
  source_channel_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'activity',
  source_format TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, week_id, user_id)
);

ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS source_message_id TEXT;
ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS source_channel_id TEXT;
ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'activity';
ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS source_format TEXT;
ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS max_streak INTEGER NOT NULL DEFAULT 1;
ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS snapshot_at TIMESTAMPTZ;
ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS previous_position INTEGER;
ALTER TABLE minako_weekly_rankings ADD COLUMN IF NOT EXISTS movement TEXT;

CREATE TABLE IF NOT EXISTS minako_history_imports (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  week_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_format TEXT,
  PRIMARY KEY (guild_id, message_id)
);

ALTER TABLE minako_history_imports ADD COLUMN IF NOT EXISTS source_format TEXT;

CREATE TABLE IF NOT EXISTS minako_weekly_snapshots (
  guild_id TEXT NOT NULL,
  week_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  first_message_at TIMESTAMPTZ,
  previous_position INTEGER,
  movement TEXT,
  streak INTEGER NOT NULL DEFAULT 1,
  total_appearances INTEGER NOT NULL DEFAULT 1,
  max_streak INTEGER NOT NULL DEFAULT 1,
  growth_percent NUMERIC,
  is_returner BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, week_id, user_id)
);

CREATE TABLE IF NOT EXISTS minako_weekly_cycles (
  guild_id TEXT NOT NULL,
  week_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  snapshot_at TIMESTAMPTZ,
  prepared_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  moderation_sent_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, week_id)
);

CREATE TABLE IF NOT EXISTS minako_editorials (
  guild_id TEXT NOT NULL,
  week_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  moderation_message_id TEXT,
  publication_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, week_id)
);

CREATE TABLE IF NOT EXISTS minako_matches (
  id TEXT PRIMARY KEY DEFAULT 'current',
  payload JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS minako_match_profiles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  current_rank TEXT NOT NULL DEFAULT '',
  peak_rank TEXT NOT NULL DEFAULT '',
  heroes JSONB NOT NULL DEFAULT '[]'::jsonb,
  routes JSONB NOT NULL DEFAULT '[]'::jsonb,
  modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  group_size TEXT NOT NULL DEFAULT 'duo',
  schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS minako_match_profiles_active_idx
  ON minako_match_profiles (guild_id, active);

CREATE TABLE IF NOT EXISTS minako_achievements (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT,
  description TEXT,
  editorial_text TEXT,
  role_id TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS minako_achievement_grants (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'moderation',
  reason TEXT,
  week_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DELETE FROM minako_achievement_grants a
USING minako_achievement_grants b
WHERE a.id > b.id
  AND a.guild_id = b.guild_id
  AND a.user_id = b.user_id
  AND a.achievement_id = b.achievement_id;

CREATE UNIQUE INDEX IF NOT EXISTS minako_achievement_grants_unique_member_achievement
  ON minako_achievement_grants (guild_id, user_id, achievement_id);
`;

let pool = null;
function isEnabled() { return Boolean(process.env.DATABASE_URL); }
function getPool() {
  if (!isEnabled()) throw new Error('DATABASE_URL não configurada.');
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 5000 });
    pool.on('error', err => console.error('[minako-db] Erro no pool:', err.message));
  }
  return pool;
}
async function initSchema() { await getPool().query(SCHEMA_SQL); }
async function loadConfig(guildId) {
  const { rows } = await getPool().query('SELECT * FROM minako_guilds WHERE guild_id=$1', [guildId]);
  return rows[0] || null;
}
async function saveConfig(guildId, config) {
  await getPool().query(`
    INSERT INTO minako_guilds (guild_id, timezone, week_start_day, week_start_time, criterion, moderation_channel_id, publication_channel_id, star_role_id, partida_admin_role_ids, night_mode_enabled, night_mode_start_time, night_mode_end_time, night_mode_notice_channel_ids, night_mode_notice_url, night_mode_category_ids, night_mode_affected_channel_ids, night_mode_immune_channel_ids, night_mode_scope_initialized, seasonal_packages, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
    ON CONFLICT (guild_id) DO UPDATE SET
      timezone=EXCLUDED.timezone,
      week_start_day=EXCLUDED.week_start_day,
      week_start_time=EXCLUDED.week_start_time,
      criterion=EXCLUDED.criterion,
      moderation_channel_id=EXCLUDED.moderation_channel_id,
      publication_channel_id=EXCLUDED.publication_channel_id,
      star_role_id=EXCLUDED.star_role_id,
      partida_admin_role_ids=EXCLUDED.partida_admin_role_ids,
      night_mode_enabled=EXCLUDED.night_mode_enabled,
      night_mode_start_time=EXCLUDED.night_mode_start_time,
      night_mode_end_time=EXCLUDED.night_mode_end_time,
      night_mode_notice_channel_ids=EXCLUDED.night_mode_notice_channel_ids,
      night_mode_notice_url=EXCLUDED.night_mode_notice_url,
      night_mode_category_ids=EXCLUDED.night_mode_category_ids,
      night_mode_affected_channel_ids=EXCLUDED.night_mode_affected_channel_ids,
      night_mode_immune_channel_ids=EXCLUDED.night_mode_immune_channel_ids,
      night_mode_scope_initialized=EXCLUDED.night_mode_scope_initialized,
      seasonal_packages=EXCLUDED.seasonal_packages,
      updated_at=now()`,
    [guildId, config.timezone, config.weekStartDay, config.weekStartTime, config.criterion, config.moderationChannelId, config.publicationChannelId, config.starRoleId, config.partidaAdminRoleIds || [], Boolean(config.nightModeEnabled), config.nightModeStartTime, config.nightModeEndTime, config.nightModeNoticeChannelIds || [], config.nightModeNoticeUrl || null, config.nightModeCategoryIds || [], config.nightModeAffectedChannelIds || [], config.nightModeImmuneChannelIds || [], true, JSON.stringify(config.seasonalPackages || { halloween:true, natal:true, ano_novo:true })]);
}
async function listActivityWeeks(guildId) {
  const { rows } = await getPool().query(`
    SELECT week_id, user_id, points, messages, channels, first_message_at
    FROM activity_weeks WHERE guild_id=$1 ORDER BY week_id ASC`, [guildId]);
  return rows;
}
async function loadActivityConfig(guildId) {
  const { rows } = await getPool().query('SELECT excluded_role_ids, excluded_channel_ids FROM activity_guilds WHERE guild_id=$1', [guildId]);
  return rows[0] || { excluded_role_ids: [], excluded_channel_ids: [] };
}
async function upsertWeeklyRankings(guildId, weekId, rows) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM minako_weekly_rankings WHERE guild_id=$1 AND week_id=$2', [guildId, weekId]);
    for (const r of rows) {
      await client.query(`INSERT INTO minako_weekly_rankings
        (guild_id,week_id,user_id,position,messages,points,first_message_at,streak,total_appearances,growth_percent,is_returner,source_message_id,source_channel_id,source_type,source_format)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [guildId, weekId, r.userId, r.position, r.messages, r.points, r.firstMessageAt, r.streak, r.totalAppearances, r.growthPercent, r.isReturner, r.sourceMessageId || null, r.sourceChannelId || null, r.sourceType || 'activity', r.sourceFormat || null]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function upsertImportedWeeklyRankings(guildId, parsed) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO minako_history_imports (guild_id, channel_id, message_id, week_id, status, error, source_format)
      VALUES ($1,$2,$3,$4,'IMPORTED',NULL,$5)
      ON CONFLICT (guild_id, message_id) DO UPDATE SET
        channel_id=EXCLUDED.channel_id,
        week_id=EXCLUDED.week_id,
        status='IMPORTED',
        error=NULL,
        source_format=EXCLUDED.source_format,
        imported_at=now()`,
      [guildId, parsed.sourceChannelId, parsed.sourceMessageId, parsed.weekId, parsed.sourceFormat || null]);

    for (const r of parsed.rankings) {
      await client.query(`
        INSERT INTO minako_weekly_rankings
          (guild_id,week_id,user_id,position,messages,points,first_message_at,streak,total_appearances,growth_percent,is_returner,source_message_id,source_channel_id,source_type,source_format)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'discord_history',$14)
        ON CONFLICT (guild_id,week_id,user_id) DO UPDATE SET
          position=EXCLUDED.position,
          messages=EXCLUDED.messages,
          points=EXCLUDED.points,
          streak=EXCLUDED.streak,
          total_appearances=EXCLUDED.total_appearances,
          growth_percent=EXCLUDED.growth_percent,
          source_message_id=EXCLUDED.source_message_id,
          source_channel_id=EXCLUDED.source_channel_id,
          source_type='discord_history',
          source_format=EXCLUDED.source_format
        WHERE minako_weekly_rankings.source_type='discord_history'`,
        [guildId, parsed.weekId, r.userId, r.position, r.messages, r.points, r.firstMessageAt, r.streak, r.totalAppearances, r.growthPercent, r.isReturner, parsed.sourceMessageId, parsed.sourceChannelId, parsed.sourceFormat || null]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
async function recordHistoryImportFailure(guildId, parsed, error) {
  await getPool().query(`
    INSERT INTO minako_history_imports (guild_id, channel_id, message_id, week_id, status, error, source_format)
    VALUES ($1,$2,$3,$4,'ERROR',$5,$6)
    ON CONFLICT (guild_id,message_id) DO UPDATE SET status='ERROR', error=EXCLUDED.error, source_format=EXCLUDED.source_format, imported_at=now()`,
    [guildId, parsed.sourceChannelId, parsed.sourceMessageId, parsed.weekId || null, String(error || 'Erro desconhecido').slice(0, 1000), parsed.sourceFormat || null]);
}
async function listImportedHistoryMessageIds(guildId) {
  const { rows } = await getPool().query(`
    SELECT message_id
    FROM minako_history_imports
    WHERE guild_id=$1 AND status='IMPORTED'`, [guildId]);
  return new Set(rows.map(row => String(row.message_id)));
}
async function loadImportedRankings(guildId) {
  const { rows } = await getPool().query(`
    SELECT guild_id, week_id, user_id, position, messages, points, first_message_at,
           streak, total_appearances, growth_percent, is_returner,
           source_message_id, source_channel_id, source_type, source_format
    FROM minako_weekly_rankings
    WHERE guild_id=$1 AND source_type='discord_history'
    ORDER BY week_id ASC, position ASC`, [guildId]);
  return rows;
}


async function upsertManualWeeklyRanking(guildId, weekId, rows) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM minako_weekly_rankings WHERE guild_id=$1 AND week_id=$2 AND source_type='manual_history'", [guildId, weekId]);
    for (const r of rows) {
      await client.query(`INSERT INTO minako_weekly_rankings
        (guild_id,week_id,user_id,position,messages,points,first_message_at,streak,total_appearances,growth_percent,is_returner,source_type,source_format,max_streak)
        VALUES ($1,$2,$3,$4,$5,$5,NULL,1,1,NULL,FALSE,'manual_history','manual',1)
        ON CONFLICT (guild_id,week_id,user_id) DO UPDATE SET
          position=EXCLUDED.position,
          messages=EXCLUDED.messages,
          points=EXCLUDED.points,
          source_type='manual_history',
          source_format='manual'`,
        [guildId, weekId, r.userId, r.position, r.messages]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function loadManualHistoryRankings(guildId) {
  const { rows } = await getPool().query(`
    SELECT guild_id, week_id, user_id, position, messages, points, streak, total_appearances,
           growth_percent, is_returner, source_type, source_format
    FROM minako_weekly_rankings
    WHERE guild_id=$1 AND source_type='manual_history'
    ORDER BY week_id ASC, position ASC`, [guildId]);
  return rows;
}

async function updateManualHistoryMetrics(guildId, metrics) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const row of metrics) {
      await client.query(`UPDATE minako_weekly_rankings
        SET streak=$4, total_appearances=$5, max_streak=$6, growth_percent=$7
        WHERE guild_id=$1 AND week_id=$2 AND user_id=$3 AND source_type='manual_history'`,
        [guildId, row.weekId, row.userId, row.streak, row.totalAppearances, row.maxStreak, row.growthPercent]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}


async function loadEditorial(guildId, weekId) {
  const { rows } = await getPool().query('SELECT * FROM minako_editorials WHERE guild_id=$1 AND week_id=$2', [guildId, weekId]);
  return rows[0] || null;
}
async function saveEditorial(guildId, weekId, status, payload, moderationMessageId=null) {
  const { rows } = await getPool().query(`
    INSERT INTO minako_editorials (guild_id,week_id,status,payload,moderation_message_id,updated_at)
    VALUES ($1,$2,$3,$4,$5,now())
    ON CONFLICT (guild_id,week_id) DO UPDATE SET
      status=EXCLUDED.status,
      payload=EXCLUDED.payload,
      moderation_message_id=COALESCE(EXCLUDED.moderation_message_id,minako_editorials.moderation_message_id),
      updated_at=now()
    RETURNING *`, [guildId, weekId, status, JSON.stringify(payload || {}), moderationMessageId]);
  return rows[0];
}
async function updateEditorial(guildId, weekId, patch) {
  const current = await loadEditorial(guildId, weekId);
  if (!current) return null;
  const payload = patch.payload ? patch.payload : current.payload;
  const status = patch.status || current.status;
  const moderationMessageId = patch.moderationMessageId || current.moderation_message_id || null;
  const publicationMessageId = patch.publicationMessageId || current.publication_message_id || null;
  const { rows } = await getPool().query(`
    UPDATE minako_editorials
    SET status=$3,payload=$4,moderation_message_id=$5,publication_message_id=$6,updated_at=now()
    WHERE guild_id=$1 AND week_id=$2 RETURNING *`,
    [guildId, weekId, status, JSON.stringify(payload || {}), moderationMessageId, publicationMessageId]);
  return rows[0] || null;
}
async function loadWeeklyRanking(guildId, weekId) {
  const { rows } = await getPool().query('SELECT * FROM minako_weekly_rankings WHERE guild_id=$1 AND week_id=$2 ORDER BY position', [guildId, weekId]);
  return rows;
}


async function listActivitySnapshots(guildId) {
  const { rows } = await getPool().query(`
    SELECT guild_id, week_id, user_id, position, messages, points, first_message_at,
           streak, previous_position, movement, total_appearances, max_streak, growth_percent, is_returner, snapshot_at
    FROM minako_weekly_snapshots
    WHERE guild_id=$1
    ORDER BY week_id ASC, position ASC`, [guildId]);
  return rows;
}

async function loadActivitySnapshot(guildId, weekId) {
  const { rows } = await getPool().query(`
    SELECT guild_id, week_id, user_id, position, messages, points, first_message_at,
           streak, previous_position, movement, total_appearances, max_streak, growth_percent, is_returner, snapshot_at
    FROM minako_weekly_snapshots
    WHERE guild_id=$1 AND week_id=$2
    ORDER BY position ASC`, [guildId, weekId]);
  return rows;
}

async function createActivitySnapshot(guildId, weekId, rows, snapshotAt = new Date()) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`
      SELECT user_id FROM minako_weekly_snapshots
      WHERE guild_id=$1 AND week_id=$2`, [guildId, weekId]);
    if (existing.rows.length) {
      await client.query('COMMIT');
      return { created: false, rows: existing.rows };
    }
    if (!Array.isArray(rows) || rows.length !== 5) throw new Error('O snapshot precisa conter exatamente cinco membros.');
    for (const r of rows) {
      await client.query(`
        INSERT INTO minako_weekly_snapshots
          (guild_id,week_id,user_id,position,messages,points,first_message_at,previous_position,movement,streak,total_appearances,max_streak,growth_percent,is_returner,snapshot_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [guildId, weekId, r.userId, r.position, r.messages, r.points, r.firstMessageAt || null,
          r.previousPosition, r.movement, r.streak, r.totalAppearances, r.maxStreak, r.growthPercent, r.isReturner, snapshotAt]);
    }
    await client.query(`
      INSERT INTO minako_weekly_cycles (guild_id,week_id,status,snapshot_at,updated_at)
      VALUES ($1,$2,'SNAPSHOT_CREATED',$3,now())
      ON CONFLICT (guild_id,week_id) DO UPDATE SET
        status=CASE WHEN minako_weekly_cycles.snapshot_at IS NULL THEN 'SNAPSHOT_CREATED' ELSE minako_weekly_cycles.status END,
        snapshot_at=COALESCE(minako_weekly_cycles.snapshot_at,EXCLUDED.snapshot_at),
        updated_at=now()`, [guildId, weekId, snapshotAt]);
    await client.query('COMMIT');
    return { created: true, rows };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function loadWeeklyCycle(guildId, weekId) {
  const { rows } = await getPool().query('SELECT * FROM minako_weekly_cycles WHERE guild_id=$1 AND week_id=$2', [guildId, weekId]);
  return rows[0] || null;
}
async function updateWeeklyCycle(guildId, weekId, patch) {
  const current = await loadWeeklyCycle(guildId, weekId);
  if (!current) {
    const { rows } = await getPool().query(`
      INSERT INTO minako_weekly_cycles (guild_id,week_id,status,snapshot_at,prepared_at,ready_at,moderation_sent_at,last_error,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`,
      [guildId, weekId, patch.status || 'PENDING', patch.snapshotAt || null, patch.preparedAt || null, patch.readyAt || null, patch.moderationSentAt || null, patch.lastError || null]);
    return rows[0];
  }
  const values = {
    status: patch.status ?? current.status,
    snapshotAt: patch.snapshotAt ?? current.snapshot_at,
    preparedAt: patch.preparedAt ?? current.prepared_at,
    readyAt: patch.readyAt ?? current.ready_at,
    moderationSentAt: patch.moderationSentAt ?? current.moderation_sent_at,
    lastError: patch.lastError ?? current.last_error
  };
  const { rows } = await getPool().query(`
    UPDATE minako_weekly_cycles
    SET status=$3,snapshot_at=$4,prepared_at=$5,ready_at=$6,moderation_sent_at=$7,last_error=$8,updated_at=now()
    WHERE guild_id=$1 AND week_id=$2 RETURNING *`,
    [guildId, weekId, values.status, values.snapshotAt, values.preparedAt, values.readyAt, values.moderationSentAt, values.lastError]);
  return rows[0] || null;
}
async function hasAchievementGrant(guildId, userId, achievementId) {
  const { rows } = await getPool().query(
    'SELECT 1 FROM minako_achievement_grants WHERE guild_id=$1 AND user_id=$2 AND achievement_id=$3 LIMIT 1',
    [guildId, userId, achievementId]
  );
  return rows.length > 0;
}
async function createAchievementGrant(guildId, userId, achievementId, grantedBy, weekId, reason = null, metadata = {}) {
  const { rows } = await getPool().query(`
    INSERT INTO minako_achievement_grants
      (guild_id,user_id,achievement_id,granted_by,week_id,reason,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (guild_id,user_id,achievement_id) DO NOTHING
    RETURNING *`,
    [guildId, userId, achievementId, grantedBy, weekId, reason, JSON.stringify(metadata || {})]
  );
  return rows[0] || null;
}

async function loadAchievementDefinitions(ids) {
  if (!ids?.length) return [];
  const { rows } = await getPool().query(
    'SELECT id, role_id FROM minako_achievements WHERE id = ANY($1::text[]) AND active=TRUE',
    [ids]
  );
  return rows;
}
async function loadSharedHeroCatalog() {
  const { rows } = await getPool().query('SELECT value FROM app_data WHERE key=$1 LIMIT 1', ['heroes']);
  return Array.isArray(rows[0]?.value) ? rows[0].value : [];
}

async function loadMatchProfile(guildId, userId) {
  const { rows } = await getPool().query('SELECT * FROM minako_match_profiles WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
  return rows[0] || null;
}
async function saveMatchProfile(guildId, userId, profile) {
  await getPool().query(`
    INSERT INTO minako_match_profiles
      (guild_id,user_id,current_rank,peak_rank,heroes,routes,modes,group_size,schedule,active,updated_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,now())
    ON CONFLICT (guild_id,user_id) DO UPDATE SET
      current_rank=EXCLUDED.current_rank,
      peak_rank=EXCLUDED.peak_rank,
      heroes=EXCLUDED.heroes,
      routes=EXCLUDED.routes,
      modes=EXCLUDED.modes,
      group_size=EXCLUDED.group_size,
      schedule=EXCLUDED.schedule,
      active=EXCLUDED.active,
      updated_at=now()`,
    [guildId, userId, profile.currentRank || '', profile.peakRank || '', JSON.stringify(profile.heroes || []), JSON.stringify(profile.routes || []), JSON.stringify(profile.modes || []), profile.groupSize || 'duo', JSON.stringify(profile.schedule || {}), Boolean(profile.active)]
  );
}
async function setMatchProfileActive(guildId, userId, active) {
  await getPool().query('UPDATE minako_match_profiles SET active=$3, updated_at=now() WHERE guild_id=$1 AND user_id=$2', [guildId, userId, Boolean(active)]);
}
async function listActiveMatchProfiles(guildId) {
  const { rows } = await getPool().query('SELECT * FROM minako_match_profiles WHERE guild_id=$1 AND active=TRUE ORDER BY updated_at DESC', [guildId]);
  return rows;
}

async function loadMatches() {
  const { rows } = await getPool().query('SELECT payload FROM minako_matches WHERE id=\'current\' LIMIT 1');
  return rows[0]?.payload ?? [];
}
async function saveMatches(matches) {
  const pool = getPool();
  const client = await pool.connect();
  const payload = JSON.stringify(Array.isArray(matches) ? matches : []);

  try {
    await client.query('BEGIN');
    // Ensure the singleton row exists before locking it. This is additive and
    // preserves the current payload when the row already exists.
    await client.query(`
      INSERT INTO minako_matches (id, payload, updated_at)
      VALUES ('current', '[]'::jsonb, now())
      ON CONFLICT (id) DO NOTHING
    `);
    // Serialize writes to the singleton record and commit the complete JSONB
    // payload atomically. A failed write is rolled back rather than partially
    // applied.
    await client.query(`SELECT id FROM minako_matches WHERE id='current' FOR UPDATE`);
    await client.query(`
      UPDATE minako_matches
      SET payload=$1::jsonb, updated_at=now()
      WHERE id='current'
    `, [payload]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('[minako-db] Falha no rollback de minako_matches:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}


async function loadNightModeState(guildId) {
  const { rows } = await getPool().query('SELECT * FROM minako_night_mode_state WHERE guild_id=$1', [guildId]);
  const row = rows[0];
  if (!row) return null;
  return { ...row, active: Boolean(row.active), activeDate: row.active_date, startNoticeDate: row.start_notice_date, startAppliedDate: row.start_applied_date, endNoticeDate: row.end_notice_date, originalOverwrites: row.original_overwrites || {} };
}
async function saveNightModeState(guildId, state) {
  await getPool().query(`
    INSERT INTO minako_night_mode_state (guild_id, active, active_date, start_notice_date, start_applied_date, end_notice_date, original_overwrites, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (guild_id) DO UPDATE SET
      active=EXCLUDED.active, active_date=EXCLUDED.active_date,
      start_notice_date=EXCLUDED.start_notice_date, start_applied_date=EXCLUDED.start_applied_date,
      end_notice_date=EXCLUDED.end_notice_date, original_overwrites=EXCLUDED.original_overwrites, updated_at=now()`,
    [guildId, Boolean(state.active), state.activeDate || null, state.startNoticeDate || null, state.startAppliedDate || null, state.endNoticeDate || null, JSON.stringify(state.originalOverwrites || {})]);
}

async function loadPersonalityState(guildId) {
  const { rows } = await getPool().query('SELECT * FROM minako_personality_state WHERE guild_id=$1', [guildId]);
  const row = rows[0];
  if (!row) return null;
  return { guildId: row.guild_id, weekId: row.week_id, usedPhraseIds: Array.isArray(row.used_phrase_ids) ? row.used_phrase_ids : [], lastPhraseId: row.last_phrase_id || null };
}
async function savePersonalityState(guildId, state) {
  await getPool().query(`
    INSERT INTO minako_personality_state (guild_id, week_id, used_phrase_ids, last_phrase_id, updated_at)
    VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (guild_id) DO UPDATE SET week_id=EXCLUDED.week_id, used_phrase_ids=EXCLUDED.used_phrase_ids, last_phrase_id=EXCLUDED.last_phrase_id, updated_at=now()`,
    [guildId, state.weekId || null, state.usedPhraseIds || [], state.lastPhraseId || null]);
}
async function closePool() { if (pool) { await pool.end(); pool = null; } }
module.exports = { closePool, getPool, initSchema, isEnabled, loadMatches, saveMatches, loadSharedHeroCatalog, loadMatchProfile, saveMatchProfile, setMatchProfileActive, listActiveMatchProfiles, loadConfig, saveConfig, loadNightModeState, saveNightModeState, loadPersonalityState, savePersonalityState, listActivityWeeks, listActivitySnapshots, loadActivityConfig, upsertWeeklyRankings, upsertImportedWeeklyRankings, recordHistoryImportFailure, listImportedHistoryMessageIds, loadImportedRankings, upsertManualWeeklyRanking, loadManualHistoryRankings, updateManualHistoryMetrics, loadWeeklyRanking, loadActivitySnapshot, createActivitySnapshot, loadWeeklyCycle, updateWeeklyCycle, loadEditorial, saveEditorial, updateEditorial, hasAchievementGrant, createAchievementGrant, loadAchievementDefinitions };
