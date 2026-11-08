'use strict';
// Persistência dos sorteios no PostgreSQL compartilhado com a Ami Mizuno.
// Tabelas próprias (prefixo minako_giveaway*), sem tocar em app_data nem nas
// tabelas da Mizuno. Toda mutação roda em transação com a linha do sorteio
// travada (FOR UPDATE): é seguro mesmo com mais de uma instância do bot, ao
// contrário da fila em memória usada no /partida.
const db = require('./db');
const core = require('./giveawayCore');

class GiveawayError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS minako_giveaways (
  id                   BIGSERIAL PRIMARY KEY,
  guild_id             TEXT NOT NULL,
  name                 TEXT NOT NULL,
  name_key             TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('scheduled','starting','active','drawn','concluded','cancelled')),
  host_id              TEXT NOT NULL,
  channel_id           TEXT NOT NULL,
  message_id           TEXT,
  announce_message_id  TEXT,
  thread_id            TEXT,
  config               JSONB NOT NULL,
  starts_at            TIMESTAMPTZ,
  ends_at              TIMESTAMPTZ,
  drawn_at             TIMESTAMPTZ,
  concluded_at         TIMESTAMPTZ,
  winners              JSONB NOT NULL DEFAULT '[]'::jsonb,
  redraw_count         INTEGER NOT NULL DEFAULT 0,
  attempts             INTEGER NOT NULL DEFAULT 0,
  cancel_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nome exclusivo entre sorteios "vivos" do servidor (concluídos/cancelados liberam o nome).
CREATE UNIQUE INDEX IF NOT EXISTS minako_giveaways_live_name_uq
  ON minako_giveaways (guild_id, name_key)
  WHERE status IN ('scheduled','starting','active','drawn');

CREATE INDEX IF NOT EXISTS minako_giveaways_due_idx ON minako_giveaways (status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS minako_giveaway_entries (
  giveaway_id BIGINT NOT NULL REFERENCES minako_giveaways(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  seq         BIGSERIAL,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (giveaway_id, user_id)
);
CREATE INDEX IF NOT EXISTS minako_giveaway_entries_order_idx ON minako_giveaway_entries (giveaway_id, seq);

CREATE TABLE IF NOT EXISTS minako_giveaway_templates (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  config      JSONB NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, name_key)
);

CREATE TABLE IF NOT EXISTS minako_giveaway_cooldowns (
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  giveaway_id  BIGINT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('days','giveaways')),
  amount       INTEGER NOT NULL,
  until        TIMESTAMPTZ,
  seq_at_win   BIGINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, giveaway_id)
);
CREATE INDEX IF NOT EXISTS minako_giveaway_cooldowns_user_idx ON minako_giveaway_cooldowns (guild_id, user_id);

CREATE TABLE IF NOT EXISTS minako_giveaway_guild_state (
  guild_id         TEXT PRIMARY KEY,
  concluded_count  BIGINT NOT NULL DEFAULT 0,
  creator_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reward_role_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  global_rules     JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Cargos dados/removidos dos ganhadores (para poder corrigir num ressorteio e devolver os temporários).
CREATE TABLE IF NOT EXISTS minako_giveaway_role_ops (
  id           BIGSERIAL PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  giveaway_id  BIGINT NOT NULL REFERENCES minako_giveaways(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  role_id      TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('add','remove')),
  status       TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','reverting','reverted','failed')),
  revert_at    TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (giveaway_id, user_id, role_id, action)
);
CREATE INDEX IF NOT EXISTS minako_giveaway_role_ops_due_idx ON minako_giveaway_role_ops (revert_at) WHERE status IN ('applied','reverting');
`;

const nameKey = (name) => String(name).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

async function ensureSchema() {
  await db.getPool().query(SCHEMA_SQL);
  await db.getPool().query('ALTER TABLE minako_giveaways ADD COLUMN IF NOT EXISTS thread_id TEXT');
  await db.getPool().query("ALTER TABLE minako_giveaway_guild_state ADD COLUMN IF NOT EXISTS creator_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb");
  await db.getPool().query("ALTER TABLE minako_giveaway_guild_state ADD COLUMN IF NOT EXISTS reward_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb");
  await db.getPool().query("ALTER TABLE minako_giveaway_guild_state ADD COLUMN IF NOT EXISTS global_rules JSONB NOT NULL DEFAULT '{}'::jsonb");
}

async function tx(fn) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const query = (sql, params) => db.getPool().query(sql, params);

function mapRow(r) {
  if (!r) return null;
  return {
    id: String(r.id), guildId: r.guild_id, name: r.name, status: r.status, hostId: r.host_id,
    channelId: r.channel_id, messageId: r.message_id, announceMessageId: r.announce_message_id, threadId: r.thread_id,
    config: core.normalizeConfig(r.config),
    startsAt: r.starts_at ? new Date(r.starts_at) : null,
    endsAt: r.ends_at ? new Date(r.ends_at) : null,
    drawnAt: r.drawn_at ? new Date(r.drawn_at) : null,
    winners: Array.isArray(r.winners) ? r.winners.filter(core.isSnowflake) : [],
    redrawCount: r.redraw_count, attempts: r.attempts, cancelReason: r.cancel_reason,
  };
}

async function lockRow(c, guildId, id) {
  const { rows } = await c.query('SELECT * FROM minako_giveaways WHERE id=$1 AND guild_id=$2 FOR UPDATE', [id, guildId]);
  return rows[0] || null;
}
const countOf = async (c, id) => (await c.query('SELECT count(*)::int AS n FROM minako_giveaway_entries WHERE giveaway_id=$1', [id])).rows[0].n;

// ---------------------------------------------------------------------------
// Criação / ciclo de vida
// ---------------------------------------------------------------------------
// status: 'starting' (publicação imediata em andamento) ou 'scheduled'.
// A unicidade do nome é garantida pelo índice parcial: criações simultâneas
// com o mesmo nome nunca passam das duas.
async function insertGiveaway({ guildId, hostId, config, status, startsAt, endsAt }) {
  try {
    const { rows } = await query(
      `INSERT INTO minako_giveaways (guild_id,name,name_key,status,host_id,channel_id,config,starts_at,ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
      [guildId, config.name, nameKey(config.name), status, hostId, config.channelId, JSON.stringify(config), startsAt, endsAt]
    );
    return mapRow(rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new GiveawayError('NAME_TAKEN', 'Já existe um sorteio ativo com esse nome.');
    throw error;
  }
}

async function getGiveaway(guildId, id) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const { rows } = await query('SELECT * FROM minako_giveaways WHERE id=$1 AND guild_id=$2', [id, guildId]);
  return mapRow(rows[0]);
}

async function findLiveByName(guildId, name) {
  const { rows } = await query(
    `SELECT * FROM minako_giveaways WHERE guild_id=$1 AND name_key=$2 AND status IN ('scheduled','starting','active','drawn') LIMIT 1`,
    [guildId, nameKey(name)]
  );
  return mapRow(rows[0]);
}

async function searchLiveNames(guildId, text, limit = 25) {
  const like = `%${String(text || '').toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await query(
    `SELECT name, status FROM minako_giveaways WHERE guild_id=$1 AND status IN ('scheduled','active','drawn') AND name_key LIKE $2 ESCAPE '\\' ORDER BY created_at DESC LIMIT $3`,
    [guildId, like, limit]
  );
  return rows;
}

// 'starting' -> 'active' depois que a mensagem pública foi enviada.
async function markActive(id, { messageId, channelId, startsAt, endsAt }) {
  const { rows } = await query(
    `UPDATE minako_giveaways SET status='active', message_id=$2, channel_id=$3, starts_at=$4, ends_at=$5, updated_at=now()
     WHERE id=$1 AND status='starting' RETURNING *`,
    [id, messageId, channelId, startsAt, endsAt]
  );
  return mapRow(rows[0]);
}

// Limpa uma criação que falhou ao publicar (a mensagem pública não existe).
async function deleteStarting(id) { await query(`DELETE FROM minako_giveaways WHERE id=$1 AND status='starting' AND message_id IS NULL`, [id]); }

// Publicação agendada que falhou: volta para 'scheduled' com atraso; após 5 tentativas, cancela.
async function failStart(id, delaySeconds = 60) {
  const { rows } = await query(
    `UPDATE minako_giveaways SET attempts=attempts+1, updated_at=now(),
       status=CASE WHEN attempts+1>=5 THEN 'cancelled' ELSE 'scheduled' END,
       cancel_reason=CASE WHEN attempts+1>=5 THEN 'publish_failed' ELSE cancel_reason END,
       starts_at=CASE WHEN attempts+1>=5 THEN starts_at ELSE now() + make_interval(secs => $2) END
     WHERE id=$1 AND status='starting' RETURNING *`,
    [id, delaySeconds]
  );
  return mapRow(rows[0]);
}

// Reivindica, de forma atômica, agendamentos vencidos (seguro com várias instâncias).
async function claimDueStarts(limit = 5) {
  return tx(async (c) => {
    // Publicação imediata que caiu no meio (sem mensagem enviada): libera o nome.
    await c.query(`DELETE FROM minako_giveaways WHERE status='starting' AND message_id IS NULL AND starts_at IS NULL AND updated_at < now() - interval '5 minutes'`);
    await c.query(`UPDATE minako_giveaways SET status='scheduled' WHERE status='starting' AND message_id IS NULL AND starts_at IS NOT NULL AND updated_at < now() - interval '5 minutes' AND attempts < 5`);
    const { rows } = await c.query(
      `UPDATE minako_giveaways SET status='starting', updated_at=now()
       WHERE id IN (SELECT id FROM minako_giveaways WHERE status='scheduled' AND starts_at <= now() ORDER BY starts_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [limit]
    );
    return rows.map(mapRow);
  });
}

async function listDueDraws(limit = 10) {
  const { rows } = await query(`SELECT * FROM minako_giveaways WHERE status='active' AND ends_at IS NOT NULL AND ends_at <= now() ORDER BY ends_at LIMIT $1`, [limit]);
  return rows.map(mapRow);
}

async function listUnannounced(limit = 5) {
  const { rows } = await query(
    `SELECT * FROM minako_giveaways WHERE status='drawn' AND announce_message_id IS NULL AND drawn_at < now() - interval '1 minute' ORDER BY drawn_at LIMIT $1`,
    [limit]
  );
  return rows.map(mapRow);
}

// Cargos autorizados a criar sorteios (além dos administradores). Vazio = só administradores.
async function getCreatorRoles(guildId) {
  const { rows } = await query('SELECT creator_role_ids FROM minako_giveaway_guild_state WHERE guild_id=$1', [guildId]);
  const v = rows[0]?.creator_role_ids;
  return Array.isArray(v) ? v.filter(core.isSnowflake) : [];
}
async function setCreatorRoles(guildId, ids) {
  const clean = [...new Set((ids || []).filter(core.isSnowflake))].slice(0, 10);
  await query(
    `INSERT INTO minako_giveaway_guild_state (guild_id, creator_role_ids) VALUES ($1,$2::jsonb)
     ON CONFLICT (guild_id) DO UPDATE SET creator_role_ids = EXCLUDED.creator_role_ids`,
    [guildId, JSON.stringify(clean)]
  );
  return clean;
}

// Cargos que o host PODE escolher para conferir/remover dos ganhadores (definidos pelo administrador).
async function getRewardRoles(guildId) {
  const { rows } = await query('SELECT reward_role_ids FROM minako_giveaway_guild_state WHERE guild_id=$1', [guildId]);
  const v = rows[0]?.reward_role_ids;
  return Array.isArray(v) ? v.filter(core.isSnowflake) : [];
}
async function setRewardRoles(guildId, ids) {
  const clean = [...new Set((ids || []).filter(core.isSnowflake))].slice(0, core.LIMITS.maxRoles);
  await query(
    `INSERT INTO minako_giveaway_guild_state (guild_id, reward_role_ids) VALUES ($1,$2::jsonb)
     ON CONFLICT (guild_id) DO UPDATE SET reward_role_ids = EXCLUDED.reward_role_ids`,
    [guildId, JSON.stringify(clean)]
  );
  return clean;
}

// Regras (cargos/membros) que valem para todos os sorteios do servidor.
async function getGlobalRules(guildId) {
  const { rows } = await query('SELECT global_rules FROM minako_giveaway_guild_state WHERE guild_id=$1', [guildId]);
  return core.normalizeRules(rows[0]?.global_rules);
}
async function setGlobalRules(guildId, rules) {
  const clean = core.normalizeRules(rules);
  await query(
    `INSERT INTO minako_giveaway_guild_state (guild_id, global_rules) VALUES ($1,$2::jsonb)
     ON CONFLICT (guild_id) DO UPDATE SET global_rules = EXCLUDED.global_rules`,
    [guildId, JSON.stringify(clean)]
  );
  return clean;
}
// União atômica (trava a linha do servidor) — usada quando um admin cria um sorteio com escopo global.
async function mergeGlobalRules(guildId, extra) {
  return tx(async (c) => {
    await c.query('INSERT INTO minako_giveaway_guild_state (guild_id) VALUES ($1) ON CONFLICT DO NOTHING', [guildId]);
    const cur = (await c.query('SELECT global_rules FROM minako_giveaway_guild_state WHERE guild_id=$1 FOR UPDATE', [guildId])).rows[0]?.global_rules;
    const { rules, truncated } = core.mergeRules(cur, extra);
    await c.query('UPDATE minako_giveaway_guild_state SET global_rules=$2::jsonb WHERE guild_id=$1', [guildId, JSON.stringify(rules)]);
    return { rules, truncated };
  });
}

// ---- cargos dos ganhadores ----
// Registra ANTES de mexer no Discord; o índice único impede aplicar duas vezes (multi-instância/reenvio).
async function insertRoleOp({ guildId, giveawayId, userId, roleId, action, revertAt }) {
  const { rows } = await query(
    `INSERT INTO minako_giveaway_role_ops (guild_id, giveaway_id, user_id, role_id, action, revert_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
    [guildId, giveawayId, userId, roleId, action, revertAt || null]
  );
  return rows[0] ? Number(rows[0].id) : null;
}
async function deleteRoleOp(id) { await query('DELETE FROM minako_giveaway_role_ops WHERE id=$1', [id]); }
async function listAppliedRoleOps(giveawayId, userIds) {
  const { rows } = await query(
    `SELECT id, guild_id, giveaway_id, user_id, role_id, action FROM minako_giveaway_role_ops
     WHERE giveaway_id=$1 AND user_id = ANY($2::text[]) AND status='applied'`,
    [giveawayId, userIds]
  );
  return rows.map((r) => ({ id: Number(r.id), guildId: r.guild_id, giveawayId: Number(r.giveaway_id), userId: r.user_id, roleId: r.role_id, action: r.action }));
}
async function markRoleOp(id, status) { await query('UPDATE minako_giveaway_role_ops SET status=$2, updated_at=now() WHERE id=$1', [id, status]); }
// Devolução automática dos cargos temporários: reivindica lotes vencidos (SKIP LOCKED = seguro com várias instâncias).
async function claimDueRoleOps(limit = 20) {
  return tx(async (c) => {
    await c.query(`UPDATE minako_giveaway_role_ops SET status='applied' WHERE status='reverting' AND updated_at < now() - interval '5 minutes'`);
    const { rows } = await c.query(
      `UPDATE minako_giveaway_role_ops SET status='reverting', updated_at=now()
       WHERE id IN (SELECT id FROM minako_giveaway_role_ops WHERE status='applied' AND revert_at IS NOT NULL AND revert_at <= now()
                    ORDER BY revert_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, guild_id, giveaway_id, user_id, role_id, action, attempts`,
      [limit]
    );
    return rows.map((r) => ({ id: Number(r.id), guildId: r.guild_id, giveawayId: Number(r.giveaway_id), userId: r.user_id, roleId: r.role_id, action: r.action, attempts: r.attempts }));
  });
}
// Falhou ao devolver: tenta de novo em 10 min; depois de 8 tentativas desiste (fica 'failed').
async function retryRoleOp(id, attempts) {
  const giveUp = attempts + 1 >= 8;
  await query(
    `UPDATE minako_giveaway_role_ops SET status=$2, attempts=attempts+1, revert_at=now() + interval '10 minutes', updated_at=now() WHERE id=$1`,
    [id, giveUp ? 'failed' : 'applied']
  );
  return giveUp;
}

// Tópico privado: reivindicação atômica (só uma instância cria). Valores: NULL = não criado,
// 'pending' = em criação, 'failed' = falhou (o moderador cria/ajusta manualmente), senão o ID do tópico.
async function claimThread(id) {
  const { rowCount } = await query(`UPDATE minako_giveaways SET thread_id='pending', updated_at=now() WHERE id=$1 AND thread_id IS NULL`, [id]);
  return rowCount === 1;
}
async function setThread(id, threadId) { await query('UPDATE minako_giveaways SET thread_id=$2, updated_at=now() WHERE id=$1', [id, threadId]); }

async function setAnnounceMessage(id, messageId) { await query('UPDATE minako_giveaways SET announce_message_id=$2, updated_at=now() WHERE id=$1', [id, messageId]); }

// ---------------------------------------------------------------------------
// Participantes
// ---------------------------------------------------------------------------
async function joinEntry(guildId, id, userId, memberRoleIds, now = new Date()) {
  return tx(async (c) => {
    const row = await lockRow(c, guildId, id);
    if (!row) return { check: { ok: false, reason: 'missing' }, count: 0 };
    const config = core.normalizeConfig(row.config);
    const count = await countOf(c, id);
    const joined = (await c.query('SELECT 1 FROM minako_giveaway_entries WHERE giveaway_id=$1 AND user_id=$2', [id, userId])).rowCount > 0;
    const cds = (await c.query(
      `SELECT mode, amount, until, seq_at_win FROM minako_giveaway_cooldowns WHERE guild_id=$1 AND user_id=$2 AND (mode='giveaways' OR until > now())`,
      [guildId, userId]
    )).rows.map((r) => ({ mode: r.mode, amount: r.amount, until: r.until, seqAtWin: Number(r.seq_at_win) }));
    const concludedCount = Number((await c.query('SELECT concluded_count FROM minako_giveaway_guild_state WHERE guild_id=$1', [guildId])).rows[0]?.concluded_count || 0);
    const globalRules = core.normalizeRules((await c.query('SELECT global_rules FROM minako_giveaway_guild_state WHERE guild_id=$1', [guildId])).rows[0]?.global_rules);
    const check = core.checkJoin({ config, status: row.status, endsAt: row.ends_at, count, alreadyJoined: joined, memberRoleIds, userId, globalRules, cooldowns: cds, concludedCount, now });
    if (!check.ok) return { check, count, giveaway: mapRow(row) };
    await c.query('INSERT INTO minako_giveaway_entries (giveaway_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, userId]);
    return { check, count: count + 1, giveaway: mapRow(row) };
  });
}

async function leaveEntry(guildId, id, userId) {
  return tx(async (c) => {
    const row = await lockRow(c, guildId, id);
    if (!row) return { missing: true, left: false, count: 0 };
    if (row.status !== 'active') return { closed: true, left: false, count: await countOf(c, id) };
    const res = await c.query('DELETE FROM minako_giveaway_entries WHERE giveaway_id=$1 AND user_id=$2', [id, userId]);
    return { left: res.rowCount > 0, count: await countOf(c, id) };
  });
}

// Remoção administrativa (a permissão é checada por quem chama, no servidor).
async function removeEntry(guildId, id, userId) {
  return tx(async (c) => {
    const row = await lockRow(c, guildId, id);
    if (!row) return { missing: true, removed: false, count: 0 };
    if (row.status !== 'active') return { closed: true, removed: false, count: await countOf(c, id) };
    const res = await c.query('DELETE FROM minako_giveaway_entries WHERE giveaway_id=$1 AND user_id=$2', [id, userId]);
    return { removed: res.rowCount > 0, count: await countOf(c, id) };
  });
}

async function countEntries(id) { return (await query('SELECT count(*)::int AS n FROM minako_giveaway_entries WHERE giveaway_id=$1', [id])).rows[0].n; }
async function listEntries(id, limit, offset) {
  const { rows } = await query('SELECT user_id FROM minako_giveaway_entries WHERE giveaway_id=$1 ORDER BY seq LIMIT $2 OFFSET $3', [id, limit, offset]);
  return rows.map((r) => r.user_id);
}
async function listAllEntries(id) {
  const { rows } = await query('SELECT user_id FROM minako_giveaway_entries WHERE giveaway_id=$1 ORDER BY seq', [id]);
  return rows.map((r) => r.user_id);
}

// ---------------------------------------------------------------------------
// Sorteio, ressorteio, conclusão e cancelamento
// ---------------------------------------------------------------------------
// invalidIds: participantes já verificados no Discord (saíram do servidor / perderam elegibilidade).
async function drawTx(guildId, id, { invalidIds = new Set(), force = false, rng, now = new Date() } = {}) {
  return tx(async (c) => {
    const row = await lockRow(c, guildId, id);
    if (!row) return { kind: 'missing' };
    if (row.status !== 'active') return { kind: 'noop', giveaway: mapRow(row) };
    if (!force && row.ends_at && new Date(row.ends_at) > now) return { kind: 'noop', giveaway: mapRow(row) };
    const cfg = core.normalizeConfig(row.config);
    const ids = (await c.query('SELECT user_id FROM minako_giveaway_entries WHERE giveaway_id=$1 ORDER BY seq', [id])).rows.map((r) => r.user_id);

    if (ids.length < cfg.minParticipants) {
      if (force) return { kind: 'below_min', count: ids.length, min: cfg.minParticipants };
      const r = await c.query(`UPDATE minako_giveaways SET status='cancelled', cancel_reason='min_participants', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      return { kind: 'cancelled', reason: 'min_participants', count: ids.length, giveaway: mapRow(r.rows[0]) };
    }
    const pool = ids.filter((u) => !invalidIds.has(u));
    if (!pool.length) {
      const r = await c.query(`UPDATE minako_giveaways SET status='cancelled', cancel_reason='no_valid_participants', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
      return { kind: 'cancelled', reason: 'no_valid_participants', count: ids.length, giveaway: mapRow(r.rows[0]) };
    }
    const winners = core.pickWinners(pool, cfg.winnerCount, rng);
    const r = await c.query(`UPDATE minako_giveaways SET status='drawn', winners=$2::jsonb, drawn_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id, JSON.stringify(winners)]);
    return { kind: 'drawn', winners, count: ids.length, giveaway: mapRow(r.rows[0]) };
  });
}

// Ressorteio: o host escolhe 1 ou mais ganhadores atuais (replaceIds); a quantidade escolhida é a quantidade
// de novos ganhadores. Cada substituto assume a posição de um substituído; os demais ganhadores ficam como estão.
// Ganhadores atuais (inclusive os substituídos) nunca voltam ao sorteio desta rodada.
async function redrawTx(guildId, id, { replaceIds, excludedIds = [], invalidIds = new Set(), rng } = {}) {
  return tx(async (c) => {
    const row = await lockRow(c, guildId, id);
    if (!row) return { kind: 'missing' };
    if (row.status !== 'drawn') return { kind: 'not_drawn', giveaway: mapRow(row) };
    const current = Array.isArray(row.winners) ? row.winners : [];
    const targets = [...new Set(Array.isArray(replaceIds) ? replaceIds : [])];
    if (!targets.length || targets.some((u) => !current.includes(u))) return { kind: 'bad_target' };
    const ids = (await c.query('SELECT user_id FROM minako_giveaway_entries WHERE giveaway_id=$1 ORDER BY seq', [id])).rows.map((r) => r.user_id);
    const excluded = new Set(excludedIds);
    const pool = ids.filter((u) => !current.includes(u) && !excluded.has(u) && !invalidIds.has(u));
    const needed = targets.length;
    if (pool.length < needed) return { kind: 'not_enough', available: pool.length, needed };
    const added = core.pickWinners(pool, needed, rng);
    const swap = new Map(targets.map((u, n) => [u, added[n]]));
    const winners = current.map((u) => (swap.has(u) ? swap.get(u) : u));
    const r = await c.query(`UPDATE minako_giveaways SET winners=$2::jsonb, redraw_count=redraw_count+1, updated_at=now() WHERE id=$1 RETURNING *`, [id, JSON.stringify(winners)]);
    return { kind: 'redrawn', winners, added, removed: targets, giveaway: mapRow(r.rows[0]) };
  });
}

async function concludeTx(guildId, id) {
  return tx(async (c) => {
    const row = await lockRow(c, guildId, id);
    if (!row) return { kind: 'missing' };
    if (row.status !== 'drawn') return { kind: 'noop', giveaway: mapRow(row) };
    const cfg = core.normalizeConfig(row.config);
    const winners = Array.isArray(row.winners) ? row.winners : [];
    const gs = await c.query(
      `INSERT INTO minako_giveaway_guild_state (guild_id, concluded_count) VALUES ($1,1)
       ON CONFLICT (guild_id) DO UPDATE SET concluded_count = minako_giveaway_guild_state.concluded_count + 1 RETURNING concluded_count`,
      [guildId]
    );
    const seq = Number(gs.rows[0].concluded_count);
    for (const userId of winners) {
      if (cfg.cooldown.days > 0) {
        await c.query(
          `INSERT INTO minako_giveaway_cooldowns (guild_id,user_id,giveaway_id,mode,amount,until,seq_at_win)
           VALUES ($1,$2,$3,'days',$4, now() + make_interval(days => $4), $5) ON CONFLICT DO NOTHING`,
          [guildId, userId, id, cfg.cooldown.days, seq]
        );
      } else if (cfg.cooldown.giveaways > 0) {
        await c.query(
          `INSERT INTO minako_giveaway_cooldowns (guild_id,user_id,giveaway_id,mode,amount,until,seq_at_win)
           VALUES ($1,$2,$3,'giveaways',$4,NULL,$5) ON CONFLICT DO NOTHING`,
          [guildId, userId, id, cfg.cooldown.giveaways, seq]
        );
      }
    }
    const r = await c.query(`UPDATE minako_giveaways SET status='concluded', concluded_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    return { kind: 'concluded', winners, giveaway: mapRow(r.rows[0]) };
  });
}

async function cancelTx(guildId, id, reason, statuses = ['scheduled', 'active']) {
  return tx(async (c) => {
    const row = await lockRow(c, guildId, id);
    if (!row) return { kind: 'missing' };
    if (!statuses.includes(row.status)) return { kind: 'noop', giveaway: mapRow(row) };
    const r = await c.query(`UPDATE minako_giveaways SET status='cancelled', cancel_reason=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, reason]);
    return { kind: 'cancelled', giveaway: mapRow(r.rows[0]) };
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
async function listTemplates(guildId, limit = 25) {
  const { rows } = await query('SELECT id, name FROM minako_giveaway_templates WHERE guild_id=$1 ORDER BY name_key LIMIT $2', [guildId, limit]);
  return rows.map((r) => ({ id: String(r.id), name: r.name }));
}
async function getTemplate(guildId, id) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const { rows } = await query('SELECT id, name, config FROM minako_giveaway_templates WHERE guild_id=$1 AND id=$2', [guildId, id]);
  return rows[0] ? { id: String(rows[0].id), name: rows[0].name, config: core.normalizeConfig(rows[0].config) } : null;
}
async function saveTemplate(guildId, name, config, userId) {
  try {
    await query(
      'INSERT INTO minako_giveaway_templates (guild_id,name,name_key,config,created_by) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [guildId, name, nameKey(name), JSON.stringify(config), userId]
    );
  } catch (error) {
    if (error.code === '23505') throw new GiveawayError('TEMPLATE_TAKEN', 'Já existe um template com esse nome.');
    throw error;
  }
}
async function deleteTemplate(guildId, name) {
  const res = await query('DELETE FROM minako_giveaway_templates WHERE guild_id=$1 AND name_key=$2', [guildId, nameKey(name)]);
  return res.rowCount > 0;
}
async function searchTemplateNames(guildId, text, limit = 25) {
  const like = `%${String(text || '').toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await query(`SELECT name FROM minako_giveaway_templates WHERE guild_id=$1 AND name_key LIKE $2 ESCAPE '\\' ORDER BY name_key LIMIT $3`, [guildId, like, limit]);
  return rows.map((r) => r.name);
}

module.exports = {
  GiveawayError, SCHEMA_SQL, nameKey, ensureSchema,
  insertGiveaway, getGiveaway, findLiveByName, searchLiveNames, markActive, deleteStarting, failStart,
  claimDueStarts, listDueDraws, listUnannounced, setAnnounceMessage, claimThread, setThread, getCreatorRoles, setCreatorRoles,
  getRewardRoles, setRewardRoles, getGlobalRules, setGlobalRules, mergeGlobalRules,
  insertRoleOp, deleteRoleOp, listAppliedRoleOps, markRoleOp, claimDueRoleOps, retryRoleOp,
  joinEntry, leaveEntry, removeEntry, countEntries, listEntries, listAllEntries,
  drawTx, redrawTx, concludeTx, cancelTx,
  listTemplates, getTemplate, saveTemplate, deleteTemplate, searchTemplateNames,
};
