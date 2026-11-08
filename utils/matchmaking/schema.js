'use strict';
// Migrações do matchmaking. Prefixo exclusivo minako_mm_*; nunca toca app_data nem tabelas da Mizuno.
// Cada migração é idempotente e roda em transação, sob trava consultiva (seguro com 2 instâncias).
const db = require('../db');

const MIGRATIONS = [
  {
    version: 1,
    name: 'nucleo-v1',
    up: `
CREATE TABLE IF NOT EXISTS minako_mm_settings (
  guild_id TEXT PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  central_channel_id TEXT, central_message_id TEXT,
  groups_channel_id TEXT, topics_parent_id TEXT,
  role_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS minako_mm_availability (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, mode_id TEXT NOT NULL,
  roles JSONB NOT NULL DEFAULT '[]'::jsonb, elo TEXT, voice TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','paused','ended')),
  since TIMESTAMPTZ NOT NULL DEFAULT now(), waiting_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL, paused_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS minako_mm_availability_live_idx ON minako_mm_availability (guild_id, status, expires_at);
CREATE TABLE IF NOT EXISTS minako_mm_groups (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, mode_id TEXT NOT NULL, organizer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','confirmed','searching_replacement','completed','closed')),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 10),
  join_method TEXT NOT NULL DEFAULT 'direct' CHECK (join_method IN ('direct','approval')),
  allow_incomplete BOOLEAN NOT NULL DEFAULT FALSE,
  elo_min INTEGER, elo_max INTEGER, required_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  announce_channel_id TEXT, announce_message_id TEXT, thread_id TEXT,
  search_until TIMESTAMPTZ, replacement_notified_at TIMESTAMPTZ, archive_at TIMESTAMPTZ, archived_at TIMESTAMPTZ, source_proposal_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS minako_mm_groups_source_proposal_uq ON minako_mm_groups (source_proposal_id) WHERE source_proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS minako_mm_groups_live_idx ON minako_mm_groups (guild_id, state);
CREATE TABLE IF NOT EXISTS minako_mm_group_members (
  group_id BIGINT NOT NULL REFERENCES minako_mm_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','pending','left','declined')),
  role TEXT, joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS minako_mm_proposals (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, mode_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','expired')),
  incomplete BOOLEAN NOT NULL DEFAULT FALSE, relax_stage INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS minako_mm_proposals_due_idx ON minako_mm_proposals (status, expires_at);
CREATE TABLE IF NOT EXISTS minako_mm_proposal_members (
  proposal_id BIGINT NOT NULL REFERENCES minako_mm_proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, slot INTEGER,
  response TEXT CHECK (response IN ('accepted','declined')), responded_at TIMESTAMPTZ,
  dm_message_id TEXT, dm_channel_id TEXT,
  PRIMARY KEY (proposal_id, user_id)
);
CREATE TABLE IF NOT EXISTS minako_mm_blocked_pairs (
  guild_id TEXT NOT NULL, pair TEXT NOT NULL, until_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, pair)
);
CREATE TABLE IF NOT EXISTS minako_mm_matches (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL,
  group_id BIGINT NOT NULL UNIQUE REFERENCES minako_mm_groups(id),
  mode_id TEXT NOT NULL, organizer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_window','recorded','validated','review','not_played','resolved_rejected')),
  participant_ids JSONB NOT NULL, responses JSONB NOT NULL DEFAULT '{}'::jsonb,
  window_ends_at TIMESTAMPTZ NOT NULL, reviewed_by TEXT, review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS minako_mm_events (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb, idem_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
    // Reversão: remove SOMENTE tabelas minako_mm_*. Exige confirmação explícita no comando de manutenção.
    down: `
DROP TABLE IF EXISTS minako_mm_events, minako_mm_matches, minako_mm_blocked_pairs, minako_mm_proposal_members,
  minako_mm_proposals, minako_mm_group_members, minako_mm_groups, minako_mm_availability, minako_mm_settings CASCADE;
`,
  },
  {
    version: 2,
    name: 'preferencias-reconciliacao-v1_1',
    up: `
CREATE TABLE IF NOT EXISTS minako_mm_prefs (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  notif JSONB NOT NULL DEFAULT '{}'::jsonb, play JSONB,
  delivery_issue JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
ALTER TABLE minako_mm_availability ADD COLUMN IF NOT EXISTS expiry_warned_at TIMESTAMPTZ;
ALTER TABLE minako_mm_groups ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
`,
    down: `
DROP TABLE IF EXISTS minako_mm_prefs CASCADE;
ALTER TABLE minako_mm_availability DROP COLUMN IF EXISTS expiry_warned_at;
ALTER TABLE minako_mm_groups DROP COLUMN IF EXISTS reconciled_at;
`,
  },
  {
    version: 3,
    name: 'favoritos-parcerias-v1_2',
    up: `
ALTER TABLE minako_mm_prefs ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'partners' CHECK (visibility IN ('partners','none','favorites'));
CREATE TABLE IF NOT EXISTS minako_mm_favorites (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, target_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, target_id), CHECK (user_id <> target_id)
);
CREATE INDEX IF NOT EXISTS minako_mm_favorites_target_idx ON minako_mm_favorites (guild_id, target_id);
CREATE TABLE IF NOT EXISTS minako_mm_partnerships (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_a TEXT NOT NULL, user_b TEXT NOT NULL, inviter_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','declined','ended','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), responded_at TIMESTAMPTZ, ended_by TEXT, expires_at TIMESTAMPTZ NOT NULL,
  dm_channel_id TEXT, dm_message_id TEXT, CHECK (user_a < user_b)
);
CREATE UNIQUE INDEX IF NOT EXISTS minako_mm_partnerships_live_uq ON minako_mm_partnerships (guild_id, user_a, user_b) WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS minako_mm_partnerships_a_idx ON minako_mm_partnerships (guild_id, user_a);
CREATE INDEX IF NOT EXISTS minako_mm_partnerships_b_idx ON minako_mm_partnerships (guild_id, user_b);
CREATE TABLE IF NOT EXISTS minako_mm_notice_log (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, recipient_id TEXT NOT NULL, subject_id TEXT NOT NULL, category TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS minako_mm_notice_log_recipient_idx ON minako_mm_notice_log (guild_id, recipient_id, at DESC);
`,
    down: `
DROP TABLE IF EXISTS minako_mm_notice_log CASCADE;
DROP TABLE IF EXISTS minako_mm_partnerships CASCADE;
DROP TABLE IF EXISTS minako_mm_favorites CASCADE;
ALTER TABLE minako_mm_prefs DROP COLUMN IF EXISTS visibility;
`,
  },
  {
    version: 4,
    name: 'equipes-recorrentes-v1_3',
    up: `
CREATE TABLE IF NOT EXISTS minako_mm_teams (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disbanded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), disbanded_at TIMESTAMPTZ, disbanded_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS minako_mm_teams_name_uq ON minako_mm_teams (guild_id, name_key) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS minako_mm_team_members (
  team_id BIGINT NOT NULL REFERENCES minako_mm_teams(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('invited','active','declined','left','removed','expired')),
  invited_by TEXT, joined_at TIMESTAMPTZ, responded_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, dm_channel_id TEXT, dm_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS minako_mm_team_members_user_idx ON minako_mm_team_members (user_id, status);
ALTER TABLE minako_mm_groups ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES minako_mm_teams(id);
CREATE UNIQUE INDEX IF NOT EXISTS minako_mm_groups_team_live_uq ON minako_mm_groups (team_id) WHERE team_id IS NOT NULL AND state IN ('open','confirmed','searching_replacement');
ALTER TABLE minako_mm_group_members ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'minako_mm_group_members'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE minako_mm_group_members DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE minako_mm_group_members ADD CONSTRAINT minako_mm_group_members_status_check CHECK (status IN ('confirmed','pending','left','declined','reserved'));
`,
    down: `
DELETE FROM minako_mm_group_members WHERE status = 'reserved';
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'minako_mm_group_members'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE minako_mm_group_members DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE minako_mm_group_members ADD CONSTRAINT minako_mm_group_members_status_check CHECK (status IN ('confirmed','pending','left','declined'));
DROP INDEX IF EXISTS minako_mm_groups_team_live_uq;
ALTER TABLE minako_mm_groups DROP COLUMN IF EXISTS team_id;
ALTER TABLE minako_mm_group_members DROP COLUMN IF EXISTS reserved_until;
DROP TABLE IF EXISTS minako_mm_team_members CASCADE;
DROP TABLE IF EXISTS minako_mm_teams CASCADE;
`,
  },
  {
    version: 5,
    name: 'confiabilidade-v1_4',
    up: `
CREATE TABLE IF NOT EXISTS minako_mm_reliability (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('joined','completed','left_early','left_late')),
  group_id BIGINT, match_id BIGINT, at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disputed','removed')),
  note TEXT, disputed_at TIMESTAMPTZ, resolved_by TEXT, resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS minako_mm_reliability_once_uq ON minako_mm_reliability (guild_id, user_id, group_id, kind) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS minako_mm_reliability_user_idx ON minako_mm_reliability (guild_id, user_id, at DESC);
CREATE INDEX IF NOT EXISTS minako_mm_reliability_match_idx ON minako_mm_reliability (match_id) WHERE match_id IS NOT NULL;
`,
    down: `
DROP TABLE IF EXISTS minako_mm_reliability CASCADE;
`,
  },
  {
    version: 6,
    name: 'notificacoes-avancadas-v1_5',
    up: `
ALTER TABLE minako_mm_prefs ADD COLUMN IF NOT EXISTS quiet JSONB;
ALTER TABLE minako_mm_prefs ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;
ALTER TABLE minako_mm_prefs ADD COLUMN IF NOT EXISTS digest_last_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS minako_mm_op_messages (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  channel_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS minako_mm_op_messages_ref_idx ON minako_mm_op_messages (guild_id, kind, ref);
CREATE TABLE IF NOT EXISTS minako_mm_notice_queue (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, recipient_id TEXT NOT NULL, category TEXT NOT NULL, subject_id TEXT NOT NULL,
  mode_label TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS minako_mm_notice_queue_idx ON minako_mm_notice_queue (guild_id, recipient_id, created_at);
CREATE TABLE IF NOT EXISTS minako_mm_alert_state (
  guild_id TEXT NOT NULL, kind TEXT NOT NULL, last_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (guild_id, kind)
);
`,
    down: `
DROP TABLE IF EXISTS minako_mm_alert_state CASCADE;
DROP TABLE IF EXISTS minako_mm_notice_queue CASCADE;
DROP TABLE IF EXISTS minako_mm_op_messages CASCADE;
ALTER TABLE minako_mm_prefs DROP COLUMN IF EXISTS digest_last_at;
ALTER TABLE minako_mm_prefs DROP COLUMN IF EXISTS paused_until;
ALTER TABLE minako_mm_prefs DROP COLUMN IF EXISTS quiet;
`,
  },
];

const LOCK_KEY = 704201; // trava consultiva exclusiva das migrações do matchmaking

async function migrate() {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query('CREATE TABLE IF NOT EXISTS minako_mm_schema (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT version FROM minako_mm_schema');
    const done = new Set(rows.map(r => r.version));
    const applied = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query(m.up);
      await client.query('INSERT INTO minako_mm_schema (version, name) VALUES ($1,$2)', [m.version, m.name]);
      applied.push(m.version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// Reversão total do módulo: apaga SOMENTE as tabelas minako_mm_*. Exige a frase de confirmação exata.
const ROLLBACK_PHRASE = 'APAGAR-MATCHMAKING';
async function rollback(phrase) {
  if (phrase !== ROLLBACK_PHRASE) throw new Error(`Confirmação inválida. Passe exatamente: ${ROLLBACK_PHRASE}`);
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    for (const m of [...MIGRATIONS].reverse()) await client.query(m.down);
    await client.query('DROP TABLE IF EXISTS minako_mm_schema');
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

module.exports = { MIGRATIONS, migrate, rollback, ROLLBACK_PHRASE };
