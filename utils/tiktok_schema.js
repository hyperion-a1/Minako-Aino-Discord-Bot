'use strict';

const db = require('./db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS minako_tiktok_settings (
  guild_id TEXT PRIMARY KEY,
  notification_channel_id TEXT,
  video_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  live_notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  live_announcements_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  live_mention_creator BOOLEAN NOT NULL DEFAULT FALSE,
  live_announce_account_cooldown_seconds INTEGER NOT NULL DEFAULT 900 CHECK (live_announce_account_cooldown_seconds BETWEEN 300 AND 3600),
  live_announce_guild_cooldown_seconds INTEGER NOT NULL DEFAULT 180 CHECK (live_announce_guild_cooldown_seconds BETWEEN 60 AND 1800),
  poll_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval_minutes BETWEEN 5 AND 60),
  max_accounts INTEGER NOT NULL DEFAULT 10 CHECK (max_accounts BETWEEN 1 AND 10),
  approval_mode TEXT NOT NULL DEFAULT 'hybrid' CHECK (approval_mode IN ('hybrid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS minako_tiktok_accounts (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  tiktok_open_id TEXT,
  username TEXT NOT NULL,
  display_name TEXT,
  owner_discord_id TEXT NOT NULL,
  requested_by_discord_id TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  connection_status TEXT NOT NULL DEFAULT 'pending' CHECK (connection_status IN ('pending','connected','revoked','error')),
  access_token_ciphertext TEXT,
  refresh_token_ciphertext TEXT,
  token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  approved_by_discord_id TEXT,
  approved_at TIMESTAMPTZ,
  rejected_by_discord_id TEXT,
  rejected_at TIMESTAMPTZ,
  last_video_check_at TIMESTAMPTZ,
  last_live_check_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, tiktok_open_id)
);

ALTER TABLE minako_tiktok_settings ADD COLUMN IF NOT EXISTS live_announcements_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE minako_tiktok_settings ADD COLUMN IF NOT EXISTS live_mention_creator BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE minako_tiktok_settings ADD COLUMN IF NOT EXISTS live_announce_account_cooldown_seconds INTEGER NOT NULL DEFAULT 900;
ALTER TABLE minako_tiktok_settings ADD COLUMN IF NOT EXISTS live_announce_guild_cooldown_seconds INTEGER NOT NULL DEFAULT 180;
-- A antiga flag sugeria anúncio automático. O monitor nunca deve interpretá-la assim.
ALTER TABLE minako_tiktok_settings ALTER COLUMN live_notifications_enabled SET DEFAULT FALSE;
UPDATE minako_tiktok_settings SET live_notifications_enabled=FALSE WHERE live_notifications_enabled=TRUE;
ALTER TABLE minako_tiktok_settings DROP CONSTRAINT IF EXISTS minako_tiktok_settings_live_announce_account_cooldown_seconds_check;
ALTER TABLE minako_tiktok_settings ADD CONSTRAINT minako_tiktok_settings_live_announce_account_cooldown_seconds_check CHECK (live_announce_account_cooldown_seconds BETWEEN 300 AND 3600);
ALTER TABLE minako_tiktok_settings DROP CONSTRAINT IF EXISTS minako_tiktok_settings_live_announce_guild_cooldown_seconds_check;
ALTER TABLE minako_tiktok_settings ADD CONSTRAINT minako_tiktok_settings_live_announce_guild_cooldown_seconds_check CHECK (live_announce_guild_cooldown_seconds BETWEEN 60 AND 1800);

CREATE TABLE IF NOT EXISTS minako_tiktok_live_announcement_limits (
  guild_id TEXT PRIMARY KEY,
  last_announced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS minako_tiktok_live_account_limits (
  guild_id TEXT NOT NULL,
  account_id BIGINT NOT NULL REFERENCES minako_tiktok_accounts(id) ON DELETE CASCADE,
  last_announced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, account_id)
);

ALTER TABLE minako_tiktok_accounts ADD COLUMN IF NOT EXISTS granted_scopes TEXT;

CREATE INDEX IF NOT EXISTS minako_tiktok_accounts_guild_status_idx
  ON minako_tiktok_accounts (guild_id, approval_status, connection_status);
CREATE INDEX IF NOT EXISTS minako_tiktok_accounts_owner_idx
  ON minako_tiktok_accounts (guild_id, owner_discord_id);

-- Remove perfis duplicados ativos (mesmo username no mesmo servidor) antes de
-- criar a restrição única. Prioridade: manter o aprovado sobre o pendente; entre
-- iguais, manter o menor id. Recadastro após rejeição continua permitido.
DELETE FROM minako_tiktok_accounts a
USING minako_tiktok_accounts b
WHERE a.guild_id = b.guild_id
  AND lower(a.username) = lower(b.username)
  AND a.approval_status IN ('pending','approved')
  AND b.approval_status IN ('pending','approved')
  AND (
    (a.approval_status = 'approved' AND b.approval_status = 'approved' AND a.id > b.id)
    OR (a.approval_status = 'pending' AND b.approval_status = 'approved')
    OR (a.approval_status = 'pending' AND b.approval_status = 'pending' AND a.id > b.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS minako_tiktok_accounts_active_username_idx
  ON minako_tiktok_accounts (guild_id, username)
  WHERE approval_status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS minako_tiktok_events (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  account_id BIGINT NOT NULL REFERENCES minako_tiktok_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('video','live_started','live_ended')),
  external_event_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  url TEXT,
  cover_url TEXT,
  occurred_at TIMESTAMPTZ,
  notification_channel_id TEXT,
  notification_message_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, account_id, event_type, external_event_id)
);
ALTER TABLE minako_tiktok_events ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('pending','sent'));
ALTER TABLE minako_tiktok_events ADD COLUMN IF NOT EXISTS delivery_error TEXT;
CREATE INDEX IF NOT EXISTS minako_tiktok_events_pending_idx
  ON minako_tiktok_events (guild_id, delivery_status, created_at) WHERE delivery_status='pending';
CREATE INDEX IF NOT EXISTS minako_tiktok_events_guild_created_idx
  ON minako_tiktok_events (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS minako_tiktok_oauth_states (
  state_hash TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  account_id BIGINT REFERENCES minako_tiktok_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS minako_tiktok_oauth_states_expiry_idx
  ON minako_tiktok_oauth_states (expires_at);
`;

async function ensureSchema() {
  await db.getPool().query(SCHEMA_SQL);
}

module.exports = { SCHEMA_SQL, ensureSchema };
