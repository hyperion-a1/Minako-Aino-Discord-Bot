'use strict';
// Persistência transacional do matchmaking. Regra de ouro: toda mutação trava a linha da entidade
// (FOR UPDATE), relê o estado DENTRO da transação e só então decide com mmCore.
// Compromissos do usuário são serializados por trava consultiva (guild+usuário), em ordem
// determinística para evitar deadlock.
const db = require('../db');
const core = require('./mmCore');
const reliability = require('./reliability');

class MmError extends Error { constructor(code, message) { super(message || code); this.code = code; } }
const LIVE = ['open', 'confirmed', 'searching_replacement'];

async function withTx(fn) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function lockUsers(c, guildId, userIds) {
  for (const id of [...new Set(userIds)].sort()) {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mm:${guildId}:${id}`]);
  }
}
async function isBusy(c, guildId, userId, exceptGroupId = null) {
  const { rows } = await c.query(
    `SELECT 1 FROM minako_mm_group_members m JOIN minako_mm_groups g ON g.id=m.group_id
      WHERE g.guild_id=$1 AND m.user_id=$2 AND m.status='confirmed' AND g.state = ANY($3) AND ($4::bigint IS NULL OR g.id<>$4) LIMIT 1`,
    [guildId, userId, LIVE, exceptGroupId]);
  return rows.length > 0;
}
async function event(c, guildId, type, payload = {}, idemKey = null) {
  await c.query('INSERT INTO minako_mm_events (guild_id,type,payload,idem_key) VALUES ($1,$2,$3,$4) ON CONFLICT (idem_key) DO NOTHING',
    [guildId, type, JSON.stringify(payload), idemKey]);
}

// ---------- Configuração ----------
async function getSettings(guildId, c = db.getPool()) {
  const { rows } = await c.query('SELECT * FROM minako_mm_settings WHERE guild_id=$1', [guildId]);
  const r = rows[0] || {};
  const modes = Array.isArray(r.modes) && r.modes.length ? r.modes.map(core.makeMode) : core.DEFAULT_MODES;
  return {
    settings: core.normalizeSettings(r.settings || {}), modes,
    centralChannelId: r.central_channel_id || null, centralMessageId: r.central_message_id || null,
    groupsChannelId: r.groups_channel_id || null, topicsParentId: r.topics_parent_id || null, roleIds: r.role_ids || {},
  };
}
async function saveSettingsPatch(guildId, patch) {
  // Upsert por campo; só campos presentes em `patch` são alterados.
  return withTx(async (c) => {
    await c.query('INSERT INTO minako_mm_settings (guild_id) VALUES ($1) ON CONFLICT DO NOTHING', [guildId]);
    const cur = await getSettings(guildId, c);
    const merged = core.normalizeSettings({ ...cur.settings, ...(patch.settings || {}) });
    await c.query(`UPDATE minako_mm_settings SET settings=$2,
      modes=COALESCE($3::jsonb, modes),
      central_message_id=CASE WHEN $4::boolean AND $5 IS DISTINCT FROM central_channel_id THEN NULL ELSE central_message_id END,
      central_channel_id=CASE WHEN $4::boolean THEN $5 ELSE central_channel_id END,
      groups_channel_id=CASE WHEN $6::boolean THEN $7 ELSE groups_channel_id END,
      topics_parent_id=CASE WHEN $8::boolean THEN $9 ELSE topics_parent_id END,
      role_ids=COALESCE($10::jsonb, role_ids), updated_at=now() WHERE guild_id=$1`,
      [guildId, JSON.stringify(merged), patch.modes ? JSON.stringify(patch.modes.map(core.makeMode)) : null,
        'centralChannelId' in patch, patch.centralChannelId ?? null,
        'groupsChannelId' in patch, patch.groupsChannelId ?? null,
        'topicsParentId' in patch, patch.topicsParentId ?? null,
        patch.roleIds ? JSON.stringify({ ...cur.roleIds, ...patch.roleIds }) : null]);
    return getSettings(guildId, c);
  });
}
// A mensagem da Central é reivindicada por compare-and-set: duas recriações simultâneas não duplicam.
async function claimCentralMessage(guildId, expectedMessageId, newMessageId) {
  const { rowCount } = await db.getPool().query(
    `UPDATE minako_mm_settings SET central_message_id=$3, updated_at=now()
      WHERE guild_id=$1 AND central_message_id IS NOT DISTINCT FROM $2`, [guildId, expectedMessageId, newMessageId]);
  return rowCount === 1;
}

// ---------- Disponibilidade ----------
async function setAvailability(guildId, userId, { modeId, roles = [], elo = null, voice = null }, ttlSec) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, [userId]);
    if (await isBusy(c, guildId, userId)) throw new MmError('INCOMPATIBLE_COMMITMENT', 'Você já está em um grupo ativo.');
    await c.query(`INSERT INTO minako_mm_availability (guild_id,user_id,mode_id,roles,elo,voice,status,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'active', now() + make_interval(secs => $7))
      ON CONFLICT (guild_id,user_id) DO UPDATE SET mode_id=EXCLUDED.mode_id, roles=EXCLUDED.roles, elo=EXCLUDED.elo, voice=EXCLUDED.voice,
        status='active', paused_at=NULL, expires_at=EXCLUDED.expires_at, expiry_warned_at=NULL,
        waiting_since=CASE WHEN minako_mm_availability.status='active' AND minako_mm_availability.expires_at>now() THEN minako_mm_availability.waiting_since ELSE now() END`,
      [guildId, userId, modeId, JSON.stringify(roles), elo, voice, ttlSec]);
    await event(c, guildId, 'availability.set', { userId, modeId });
  });
}
async function changeAvailability(guildId, userId, action, ttlSec) {
  const sql = {
    renew: `UPDATE minako_mm_availability SET status='active', paused_at=NULL, expiry_warned_at=NULL, expires_at=now()+make_interval(secs=>$3) WHERE guild_id=$1 AND user_id=$2 AND status<>'ended'`,
    pause: `UPDATE minako_mm_availability SET status='paused', paused_at=now() WHERE guild_id=$1 AND user_id=$2 AND status='active'`,
    end: `UPDATE minako_mm_availability SET status='ended' WHERE guild_id=$1 AND user_id=$2 AND status<>'ended'`,
  }[action];
  if (!sql) throw new MmError('BAD_ACTION');
  const params = action === 'renew' ? [guildId, userId, ttlSec] : [guildId, userId];
  const { rowCount } = await db.getPool().query(sql, params);
  return rowCount === 1;
}
async function listQueue(guildId) {
  const { rows } = await db.getPool().query(
    `SELECT a.*, EXTRACT(EPOCH FROM a.since)*1000 AS since_ms, EXTRACT(EPOCH FROM a.waiting_since)*1000 AS waiting_ms,
            EXTRACT(EPOCH FROM a.expires_at)*1000 AS expires_ms
       FROM minako_mm_availability a WHERE a.guild_id=$1 AND a.status='active' AND a.expires_at>now()
        AND NOT EXISTS (SELECT 1 FROM minako_mm_proposal_members pm JOIN minako_mm_proposals p ON p.id=pm.proposal_id
                         WHERE p.guild_id=a.guild_id AND pm.user_id=a.user_id AND p.status='pending')`, [guildId]);
  return rows.map(r => ({ userId: r.user_id, modeId: r.mode_id, roles: r.roles, elo: r.elo, voice: r.voice, status: r.status,
    since: Number(r.since_ms), waitingSince: Number(r.waiting_ms), expiresAt: Number(r.expires_ms) }));
}
// Só conta disponibilidades válidas e ativas (usado pela Central).
async function countActiveAvailability(guildId) {
  const { rows } = await db.getPool().query(`SELECT count(*)::int n FROM minako_mm_availability WHERE guild_id=$1 AND status='active' AND expires_at>now()`, [guildId]);
  return rows[0].n;
}
async function blockedPairs(guildId) {
  const { rows } = await db.getPool().query('SELECT pair FROM minako_mm_blocked_pairs WHERE guild_id=$1 AND until_at>now()', [guildId]);
  return new Set(rows.map(r => r.pair));
}

// ---------- Grupos ----------

// Histórico de confiabilidade: um registro por (pessoa, grupo, tipo) — repetir a mesma ação não gera estatística ilimitada.
// Falha em registrar NUNCA pode impedir a ação principal (por isso SAVEPOINT).
async function relRecord(c, guildId, userId, kind, { groupId = null, matchId = null } = {}) {
  try {
    await c.query('SAVEPOINT rel');
    await c.query(`INSERT INTO minako_mm_reliability (guild_id,user_id,kind,group_id,match_id) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (guild_id,user_id,group_id,kind) WHERE group_id IS NOT NULL DO NOTHING`, [guildId, String(userId), kind, groupId, matchId]);
    await c.query('RELEASE SAVEPOINT rel');
  } catch (e) { await c.query('ROLLBACK TO SAVEPOINT rel').catch(() => {}); console.error('[matchmaking] registro de confiabilidade:', e.message); }
}

async function loadGroupForUpdate(c, guildId, groupId) {
  const g = (await c.query('SELECT * FROM minako_mm_groups WHERE id=$1 AND guild_id=$2 FOR UPDATE', [groupId, guildId])).rows[0];
  if (!g) throw new MmError('GROUP_NOT_FOUND', 'Grupo não encontrado.');
  // Qualquer mutação (entrada, pedido, saída, aprovação) conta como atividade do grupo aberto.
  if (g.state === 'open') await c.query("UPDATE minako_mm_groups SET updated_at=now() WHERE id=$1", [groupId]);
  const members = (await c.query('SELECT user_id, status, role, reserved_until FROM minako_mm_group_members WHERE group_id=$1', [groupId])).rows
    .map(m => ({ userId: m.user_id, status: m.status, role: m.role, reservedUntil: m.reserved_until ? new Date(m.reserved_until).getTime() : null }));
  return {
    id: String(g.id), guildId: g.guild_id, modeId: g.mode_id, organizerId: g.organizer_id, state: g.state, capacity: g.capacity,
    joinMethod: g.join_method, allowIncomplete: g.allow_incomplete,
    eloRange: g.elo_min != null && g.elo_max != null ? [g.elo_min, g.elo_max] : null,
    requiredRolesOpen: (Array.isArray(g.required_roles) ? g.required_roles : []).filter(r => !members.some(m => m.status === 'confirmed' && m.role === r)),
    requiredRoles: g.required_roles, members, row: g,
  };
}
async function createGroup(guildId, { modeId, organizerId, capacity, joinMethod = 'direct', allowIncomplete = false, eloRange = null, requiredRoles = [], organizerRole = null }) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, [organizerId]);
    if (await isBusy(c, guildId, organizerId)) throw new MmError('INCOMPATIBLE_COMMITMENT', 'Você já está em um grupo ativo.');
    const g = (await c.query(`INSERT INTO minako_mm_groups (guild_id,mode_id,organizer_id,state,capacity,join_method,allow_incomplete,elo_min,elo_max,required_roles)
      VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9) RETURNING id`,
      [guildId, modeId, organizerId, capacity, joinMethod, allowIncomplete, eloRange?.[0] ?? null, eloRange?.[1] ?? null, JSON.stringify(requiredRoles)])).rows[0];
    await c.query(`INSERT INTO minako_mm_group_members (group_id,user_id,status,role) VALUES ($1,$2,'confirmed',$3)`, [g.id, organizerId, organizerRole]);
    await relRecord(c, guildId, organizerId, 'joined', { groupId: g.id });
    await c.query(`UPDATE minako_mm_availability SET status='ended' WHERE guild_id=$1 AND user_id=$2 AND status<>'ended'`, [guildId, organizerId]);
    await event(c, guildId, 'group.created', { groupId: String(g.id), organizerId });
    return String(g.id);
  });
}
// Entrada direta ou pedido. A decisão usa a contagem recalculada sob trava.
async function requestJoin(guildId, groupId, user, mode) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, [user.userId]);
    const group = await loadGroupForUpdate(c, guildId, groupId);
    const busy = await isBusy(c, guildId, user.userId, group.id);
    // Membro da equipe com reserva ativa: confirma a SUA vaga (não disputa vaga aberta nem precisa de aprovação).
    const mine = group.members.find(m => m.userId === user.userId && m.status === 'reserved' && (m.reservedUntil == null || m.reservedUntil > Date.now()));
    if (mine && ['open', 'searching_replacement'].includes(group.state)) {
      if (busy) throw new MmError('INCOMPATIBLE_COMMITMENT');
      await confirmMember(c, group, user.userId, user.role);
      await event(c, guildId, 'group.joined', { groupId, userId: user.userId });
      return { action: 'confirmed', group: await snapshot(c, group.id) };
    }
    const d = core.decideJoin(group, { ...user, busyElsewhere: busy }, mode, { organizerApproval: group.joinMethod === 'approval', role: user.role });
    if (!d.ok) throw new MmError(d.code);
    if (d.action === 'request_pending') {
      await c.query(`INSERT INTO minako_mm_group_members (group_id,user_id,status,role) VALUES ($1,$2,'pending',$3)
        ON CONFLICT (group_id,user_id) DO UPDATE SET status='pending', role=EXCLUDED.role, updated_at=now() WHERE minako_mm_group_members.status IN ('left','declined')`,
        [group.id, user.userId, user.role || null]);
      await event(c, guildId, 'group.join_requested', { groupId, userId: user.userId });
      return { action: 'pending', group: await snapshot(c, group.id) };
    }
    await confirmMember(c, group, user.userId, user.role);
    await event(c, guildId, 'group.joined', { groupId, userId: user.userId });
    return { action: 'confirmed', group: await snapshot(c, group.id) };
  });
}
async function decideRequest(guildId, groupId, organizerId, userId, approve) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, [userId]);
    const group = await loadGroupForUpdate(c, guildId, groupId);
    if (group.organizerId !== organizerId) throw new MmError('NOT_ORGANIZER');
    const pending = group.members.find(m => m.userId === userId && m.status === 'pending');
    if (!pending) throw new MmError('REQUEST_NOT_FOUND');
    if (!approve) {
      await c.query(`UPDATE minako_mm_group_members SET status='declined', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [group.id, userId]);
      return { action: 'declined', group: await snapshot(c, group.id) };
    }
    // Revalida vaga e compromissos no momento da aprovação.
    const busy = await isBusy(c, guildId, userId, group.id);
    const mode = { eloRelevant: false };
    const d = core.decideJoin({ ...group, members: group.members.filter(m => m.userId !== userId) }, { userId, busyElsewhere: busy }, mode, { approved: true, role: pending.role });
    if (!d.ok) {
      if (d.code === 'NO_SLOT' || d.code === 'INCOMPATIBLE_COMMITMENT') {
        await c.query(`UPDATE minako_mm_group_members SET status='declined', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [group.id, userId]);
      }
      throw new MmError(d.code);
    }
    await confirmMember(c, group, userId, pending.role);
    return { action: 'confirmed', group: await snapshot(c, group.id) };
  });
}
async function confirmMember(c, group, userId, role) {
  await c.query(`INSERT INTO minako_mm_group_members (group_id,user_id,status,role) VALUES ($1,$2,'confirmed',$3)
    ON CONFLICT (group_id,user_id) DO UPDATE SET status='confirmed', role=COALESCE(EXCLUDED.role, minako_mm_group_members.role), updated_at=now()`,
    [group.id, userId, role || null]);
  await c.query(`UPDATE minako_mm_availability SET status='ended' WHERE guild_id=$1 AND user_id=$2 AND status<>'ended'`, [group.guildId, userId]);
  const after = group.members.filter(m => m.status === 'confirmed' && m.userId !== userId).length + 1;
  if (after >= group.capacity && group.state === 'open') {
    await c.query(`UPDATE minako_mm_groups SET state='confirmed', search_until=NULL, updated_at=now() WHERE id=$1`, [group.id]);
  } else if (after >= group.capacity && group.state === 'searching_replacement') {
    await c.query(`UPDATE minako_mm_groups SET state='confirmed', search_until=NULL, updated_at=now() WHERE id=$1`, [group.id]);
  }
  await relRecord(c, group.guildId, userId, 'joined', { groupId: group.id });
}
async function leaveGroup(guildId, groupId, userId, replacementTtlSec) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, [userId]);
    const group = await loadGroupForUpdate(c, guildId, groupId);
    const me = group.members.find(m => m.userId === userId && ['confirmed', 'pending'].includes(m.status));
    if (!me) throw new MmError('NOT_MEMBER');
    await c.query(`UPDATE minako_mm_group_members SET status='left', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [group.id, userId]);
    if (me.status === 'confirmed') await relRecord(c, guildId, userId, reliability.exitKind(group.state), { groupId: group.id });
    const next = { ...group, members: group.members.map(m => (m.userId === userId ? { ...m, status: 'left' } : m)) };
    const eff = me.status === 'confirmed' ? core.afterLeave(next) : { state: group.state, searchReplacement: false };
    if (eff.state !== group.state) {
      if (!core.canTransition(group.state, eff.state)) throw new MmError('BAD_TRANSITION');
      await c.query(`UPDATE minako_mm_groups SET state=$2, search_until=now()+make_interval(secs=>$3), replacement_notified_at=NULL, updated_at=now() WHERE id=$1`, [group.id, eff.state, replacementTtlSec]);
    }
    await event(c, guildId, 'group.left', { groupId, userId, organizerLeft: group.organizerId === userId });
    // Se o organizador sai, a Minako segue gerindo: o confirmado mais antigo assume. Sem confirmados, o grupo é encerrado.
    const remaining = next.members.filter(m => m.status === 'confirmed');
    if (!remaining.length) {
      if (['open', 'confirmed', 'searching_replacement'].includes(next.state)) await closeGroup(c, { ...group, state: next.state }, 'closed');
    } else if (group.organizerId === userId) {
      const heir = (await c.query(`SELECT user_id FROM minako_mm_group_members WHERE group_id=$1 AND status='confirmed' ORDER BY joined_at ASC, user_id ASC LIMIT 1`, [group.id])).rows[0];
      await c.query('UPDATE minako_mm_groups SET organizer_id=$2, updated_at=now() WHERE id=$1', [group.id, heir.user_id]);
      await event(c, guildId, 'group.organizer_changed', { groupId, to: heir.user_id });
    }
    // O grupo continua gerido pela Minako mesmo se o organizador sair; o fluxo de decisão cabe à administração/membros restantes.
    return { ...eff, group: await snapshot(c, group.id) };
  });
}
// Decisão do organizador quando o prazo de substituição vence.
async function replacementDecision(guildId, groupId, organizerId, decision, replacementTtlSec) {
  return withTx(async (c) => {
    const group = await loadGroupForUpdate(c, guildId, groupId);
    if (group.organizerId !== organizerId) throw new MmError('NOT_ORGANIZER');
    if (group.state !== 'searching_replacement') throw new MmError('BAD_STATE');
    if (decision === 'continue') {
      if (!group.allowIncomplete) throw new MmError('INCOMPLETE_NOT_ALLOWED');
      await c.query(`UPDATE minako_mm_groups SET state='confirmed', search_until=NULL, updated_at=now() WHERE id=$1`, [group.id]);
    } else if (decision === 'extend') {
      await c.query(`UPDATE minako_mm_groups SET search_until=now()+make_interval(secs=>$2), replacement_notified_at=NULL, updated_at=now() WHERE id=$1`, [group.id, replacementTtlSec]);
    } else if (decision === 'close') {
      await closeGroup(c, group, 'closed');
    } else throw new MmError('BAD_ACTION');
    return snapshot(c, group.id);
  });
}
async function closeGroup(c, group, state, archiveAfterSec = 259200) {
  if (!core.canTransition(group.state, state)) throw new MmError('BAD_TRANSITION');
  await c.query(`UPDATE minako_mm_groups SET state=$2, closed_at=now(), archive_at=now()+make_interval(secs=>$3), updated_at=now() WHERE id=$1`, [group.id, state, archiveAfterSec]);
  await event(c, group.guildId, `group.${state}`, { groupId: group.id });
}
async function snapshot(c, groupId) {
  const g = (await c.query('SELECT * FROM minako_mm_groups WHERE id=$1', [groupId])).rows[0];
  const m = (await c.query('SELECT user_id,status,role,reserved_until FROM minako_mm_group_members WHERE group_id=$1 ORDER BY joined_at', [groupId])).rows;
  const confirmed = m.filter(x => x.status === 'confirmed').length;
  const reserved = core.reservedCount({ members: m.map(x => ({ status: x.status, reservedUntil: x.reserved_until ? new Date(x.reserved_until).getTime() : null })) });
  const team = g.team_id ? (await c.query('SELECT id, name FROM minako_mm_teams WHERE id=$1', [g.team_id])).rows[0] : null;
  return { id: String(g.id), guildId: g.guild_id, modeId: g.mode_id, organizerId: g.organizer_id, state: g.state, capacity: g.capacity,
    confirmed, reserved, free: Math.max(0, g.capacity - confirmed - reserved), pending: m.filter(x => x.status === 'pending').map(x => x.user_id),
    members: m.filter(x => x.status === 'confirmed').map(x => ({ userId: x.user_id, role: x.role })),
    joinMethod: g.join_method, allowIncomplete: g.allow_incomplete, announceChannelId: g.announce_channel_id, announceMessageId: g.announce_message_id,
    threadId: g.thread_id, searchUntil: g.search_until ? new Date(g.search_until).getTime() : null, archiveAt: g.archive_at ? new Date(g.archive_at).getTime() : null,
    requiredRoles: g.required_roles, eloRange: g.elo_min != null ? [g.elo_min, g.elo_max] : null,
    teamId: team ? String(team.id) : null, teamName: team ? team.name : null };
}

// ---------- Propostas ----------
async function createProposal(guildId, proposal) {
  return withTx(async (c) => {
    await lockUsers(c, guildId, proposal.userIds);
    for (const userId of proposal.userIds) {
      const av = (await c.query(`SELECT 1 FROM minako_mm_availability WHERE guild_id=$1 AND user_id=$2 AND status='active' AND expires_at>now()`, [guildId, userId])).rows;
      if (!av.length) throw new MmError('NOT_AVAILABLE');
      if (await isBusy(c, guildId, userId)) throw new MmError('INCOMPATIBLE_COMMITMENT');
      const pend = (await c.query(`SELECT 1 FROM minako_mm_proposal_members pm JOIN minako_mm_proposals p ON p.id=pm.proposal_id
        WHERE p.guild_id=$1 AND pm.user_id=$2 AND p.status='pending' AND p.expires_at>now()`, [guildId, userId])).rows;
      if (pend.length) throw new MmError('ALREADY_PROPOSED');
    }
    const p = (await c.query(`INSERT INTO minako_mm_proposals (guild_id,mode_id,incomplete,relax_stage,expires_at)
      VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0)) RETURNING id`, [guildId, proposal.modeId, proposal.incomplete, proposal.relaxStage, proposal.expiresAt])).rows[0];
    for (const userId of proposal.userIds) {
      await c.query('INSERT INTO minako_mm_proposal_members (proposal_id,user_id,slot) VALUES ($1,$2,$3)', [p.id, userId, proposal.slotByUser[userId] ?? null]);
    }
    await event(c, guildId, 'proposal.created', { proposalId: String(p.id), userIds: proposal.userIds });
    return String(p.id);
  });
}
// Resposta de um participante. Idempotente: repetir a mesma resposta não muda nada nem duplica o grupo.
async function respondProposal(guildId, proposalId, userId, answer, groupDefaults = {}) {
  if (!['accepted', 'declined'].includes(answer)) throw new MmError('BAD_ACTION');
  return withTx(async (c) => {
    const p = (await c.query('SELECT * FROM minako_mm_proposals WHERE id=$1 AND guild_id=$2 FOR UPDATE', [proposalId, guildId])).rows[0];
    if (!p) throw new MmError('PROPOSAL_NOT_FOUND');
    const mem = (await c.query('SELECT user_id,response,slot FROM minako_mm_proposal_members WHERE proposal_id=$1', [proposalId])).rows;
    if (!mem.some(m => m.user_id === userId)) throw new MmError('NOT_PARTICIPANT');
    if (p.status !== 'pending' || new Date(p.expires_at).getTime() <= Date.now()) {
      return { outcome: p.status === 'pending' ? 'expired' : p.status, final: true, stale: true };
    }
    await c.query('UPDATE minako_mm_proposal_members SET response=$3, responded_at=clock_timestamp() WHERE proposal_id=$1 AND user_id=$2 AND response IS NULL', [proposalId, userId, answer]);
    return resolveLocked(c, p, groupDefaults);
  });
}
async function resolveLocked(c, p, groupDefaults, now = Date.now()) {
  const mem = (await c.query('SELECT user_id,response FROM minako_mm_proposal_members WHERE proposal_id=$1', [p.id])).rows;
  const userIds = mem.map(m => m.user_id);
  const responses = Object.fromEntries(mem.filter(m => m.response).map(m => [m.user_id, m.response]));
  const avail = (await c.query(`SELECT user_id FROM minako_mm_availability WHERE guild_id=$1 AND user_id=ANY($2) AND status='active' AND expires_at>now()`, [p.guild_id, userIds])).rows.map(r => r.user_id);
  // Se todos aceitaram mas alguém já assumiu outro grupo nesse meio-tempo, essa pessoa conta como recusa (sem punição).
  let effective = responses;
  if (userIds.every(id => responses[id] === 'accepted')) {
    const busyIds = []; for (const id of userIds) if (await isBusy(c, p.guild_id, id)) busyIds.push(id);
    effective = core.applyBusyToResponses(responses, userIds, busyIds);
  }
  const r = core.resolveProposal({ userIds, expiresAt: new Date(p.expires_at).getTime(), status: p.status }, effective, now, id => avail.includes(id));
  if (!r.final) return { ...r, proposalId: String(p.id) };
  await c.query(`UPDATE minako_mm_proposals SET status=$2, resolved_at=now() WHERE id=$1 AND status='pending'`, [p.id, r.outcome]);
  if (r.outcome === 'confirmed') {
    await lockUsers(c, p.guild_id, userIds);
    // Organizador = primeiro a aceitar (decisão aprovada).
    const first = (await c.query(`SELECT user_id FROM minako_mm_proposal_members WHERE proposal_id=$1 AND response='accepted' ORDER BY responded_at ASC, user_id ASC LIMIT 1`, [p.id])).rows[0];
    const g = (await c.query(`INSERT INTO minako_mm_groups (guild_id,mode_id,organizer_id,state,capacity,join_method,allow_incomplete,source_proposal_id)
      VALUES ($1,$2,$3,'confirmed',$4,'approval',$5,$6) ON CONFLICT (source_proposal_id) WHERE source_proposal_id IS NOT NULL DO NOTHING RETURNING id`,
      [p.guild_id, p.mode_id, first.user_id, userIds.length, Boolean(groupDefaults.allowIncomplete), p.id])).rows[0];
    if (g) {
      for (const id of userIds) await c.query(`INSERT INTO minako_mm_group_members (group_id,user_id,status) VALUES ($1,$2,'confirmed')`, [g.id, id]);
      for (const id of userIds) await relRecord(c, p.guild_id, id, 'joined', { groupId: g.id });
      await c.query(`UPDATE minako_mm_availability SET status='ended' WHERE guild_id=$1 AND user_id=ANY($2)`, [p.guild_id, userIds]);
      await event(c, p.guild_id, 'proposal.confirmed', { proposalId: String(p.id), groupId: String(g.id) }, `proposal.confirmed:${p.id}`);
      return { ...r, proposalId: String(p.id), groupId: String(g.id), group: await snapshot(c, g.id) };
    }
  }
  for (const pair of r.blockedPairs || []) {
    await c.query(`INSERT INTO minako_mm_blocked_pairs (guild_id,pair,until_at) VALUES ($1,$2, now()+interval '30 minutes')
      ON CONFLICT (guild_id,pair) DO UPDATE SET until_at=EXCLUDED.until_at`, [p.guild_id, pair]);
  }
  await event(c, p.guild_id, `proposal.${r.outcome}`, { proposalId: String(p.id), requeue: r.requeue || [] });
  return { ...r, proposalId: String(p.id) };
}
// Varredura do agendador: encerra propostas vencidas (nunca reativa) e retorna quem foi afetado para avisar.
async function sweepExpiredProposals(limit = 20) {
  return withTx(async (c) => {
    const due = (await c.query(`SELECT * FROM minako_mm_proposals WHERE status='pending' AND expires_at<=now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    const out = [];
    for (const p of due) out.push(await resolveLocked(c, p, {}));
    return out;
  });
}
// Disponibilidades vencidas viram 'ended' (sem punição); retorna quem expirou para avisar conforme preferência.
async function sweepExpiredAvailability(limit = 100) {
  const { rows } = await db.getPool().query(
    `UPDATE minako_mm_availability SET status='ended' WHERE (guild_id,user_id) IN
       (SELECT guild_id,user_id FROM minako_mm_availability WHERE status='active' AND expires_at<=now() LIMIT $1)
     RETURNING guild_id, user_id`, [limit]);
  return rows.map(r => ({ guildId: r.guild_id, userId: r.user_id }));
}
// Grupos em busca de substituto cujo prazo venceu: sinaliza para o organizador decidir (não encerra sozinho).
async function listReplacementDue(limit = 20) {
  const { rows } = await db.getPool().query(`SELECT id, guild_id, organizer_id FROM minako_mm_groups WHERE state='searching_replacement' AND search_until<=now() ORDER BY search_until LIMIT $1`, [limit]);
  return rows.map(r => ({ groupId: String(r.id), guildId: r.guild_id, organizerId: r.organizer_id }));
}
async function listOpenGroups(guildId, modeId = null) {
  const { rows } = await db.getPool().query(
    `SELECT g.id, (SELECT count(*) FROM minako_mm_group_members m WHERE m.group_id=g.id AND m.status='confirmed')::int AS confirmed
       FROM minako_mm_groups g WHERE g.guild_id=$1 AND g.state IN ('open','searching_replacement') AND ($2::text IS NULL OR g.mode_id=$2) ORDER BY g.created_at`, [guildId, modeId]);
  const out = [];
  for (const r of rows) out.push(await snapshot(db.getPool(), r.id));
  return out;
}

// ---------- Dados da Central (somente números reais) ----------
async function listCentralGuilds() {
  const { rows } = await db.getPool().query(`SELECT guild_id FROM minako_mm_settings WHERE central_channel_id IS NOT NULL`);
  return rows.map(r => r.guild_id);
}
async function getCentralData(guildId, tz = 'America/Sao_Paulo') {
  const pool = db.getPool();
  const q = (sql, params) => pool.query(sql, params).then(r => r.rows);
  const [pend, today, week, recent, hourly] = await Promise.all([
    q(`SELECT count(*)::int n FROM minako_mm_proposals WHERE guild_id=$1 AND status='pending' AND expires_at>now()`, [guildId]),
    // "Concluídas no dia": conclusão registrada e não contestada/cancelada.
    q(`SELECT count(*)::int n FROM minako_mm_matches WHERE guild_id=$1 AND status IN ('pending_window','recorded','validated')
        AND created_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`, [guildId, tz]),
    q(`SELECT (SELECT count(*)::int FROM minako_mm_groups WHERE guild_id=$1 AND created_at>now()-interval '7 days') AS groups,
              (SELECT count(*)::int FROM minako_mm_matches WHERE guild_id=$1 AND status IN ('pending_window','recorded','validated') AND created_at>now()-interval '7 days') AS matches`, [guildId]),
    q(`SELECT type, payload, EXTRACT(EPOCH FROM created_at)*1000 AS at FROM minako_mm_events
        WHERE guild_id=$1 AND type IN ('group.created','group.joined','proposal.confirmed','group.completed') ORDER BY id DESC LIMIT 8`, [guildId]),
    q(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS h, count(*)::int n, count(DISTINCT (created_at AT TIME ZONE $2)::date)::int d
         FROM minako_mm_events WHERE guild_id=$1 AND type='availability.set' AND created_at>now()-interval '28 days' GROUP BY 1`, [guildId, tz]),
  ]);
  const daysRow = await q(`SELECT count(DISTINCT (created_at AT TIME ZONE $2)::date)::int d FROM minako_mm_events WHERE guild_id=$1 AND type='availability.set' AND created_at>now()-interval '28 days'`, [guildId, tz]);
  const hours = Array(24).fill(0); for (const r of hourly) hours[r.h] = r.n;
  return {
    availableNow: await countActiveAvailability(guildId), openGroups: await listOpenGroups(guildId),
    pendingProposals: pend[0].n, matchesToday: today[0].n, weekGroups: week[0].groups, weekMatches: week[0].matches,
    recentEvents: recent.map(r => ({ type: r.type, payload: r.payload, at: Number(r.at) })),
    hourlyActivity: { hourly: hours, days: daysRow[0].d },
  };
}

// ---------- Apoio a propostas e eventos ----------
async function logEvent(guildId, type, payload = {}, idemKey = null) { await event(db.getPool(), guildId, type, payload, idemKey); }
async function proposalGuildId(proposalId) {
  const { rows } = await db.getPool().query('SELECT guild_id FROM minako_mm_proposals WHERE id=$1', [proposalId]);
  return rows[0]?.guild_id || null;
}
async function setProposalDm(proposalId, userId, channelId, messageId) {
  await db.getPool().query('UPDATE minako_mm_proposal_members SET dm_channel_id=$3, dm_message_id=$4 WHERE proposal_id=$1 AND user_id=$2', [proposalId, userId, channelId, messageId]);
}
async function listProposalMembers(proposalId) {
  const { rows } = await db.getPool().query('SELECT user_id, response, dm_channel_id, dm_message_id FROM minako_mm_proposal_members WHERE proposal_id=$1 ORDER BY user_id', [proposalId]);
  return rows.map(r => ({ userId: r.user_id, response: r.response, dmChannelId: r.dm_channel_id, dmMessageId: r.dm_message_id }));
}
async function getProposal(proposalId) {
  const { rows } = await db.getPool().query('SELECT id, guild_id, mode_id, status, incomplete, EXTRACT(EPOCH FROM expires_at)*1000 AS expires_ms FROM minako_mm_proposals WHERE id=$1', [proposalId]);
  const r = rows[0]; if (!r) return null;
  return { id: String(r.id), guildId: r.guild_id, modeId: r.mode_id, status: r.status, incomplete: r.incomplete, expiresAt: Number(r.expires_ms), members: await listProposalMembers(proposalId) };
}
// Proposta pendente do usuário (para quem está com DMs fechadas poder responder pela Central).
async function pendingProposalForUser(guildId, userId) {
  const { rows } = await db.getPool().query(
    `SELECT p.id FROM minako_mm_proposals p JOIN minako_mm_proposal_members pm ON pm.proposal_id=p.id
      WHERE p.guild_id=$1 AND pm.user_id=$2 AND p.status='pending' AND p.expires_at>now() AND pm.response IS NULL LIMIT 1`, [guildId, userId]);
  return rows[0] ? getProposal(rows[0].id) : null;
}
async function getAvailability(guildId, userId) {
  const { rows } = await db.getPool().query(
    `SELECT mode_id, roles, elo, voice, status, EXTRACT(EPOCH FROM expires_at)*1000 AS expires_ms FROM minako_mm_availability WHERE guild_id=$1 AND user_id=$2`, [guildId, userId]);
  const r = rows[0]; if (!r || r.status === 'ended' || Number(r.expires_ms) <= Date.now()) return null;
  return { modeId: r.mode_id, roles: r.roles, elo: r.elo, voice: r.voice, status: r.status, expiresAt: Number(r.expires_ms) };
}

// ---------- Anúncio, tópico privado, encerramento e arquivamento ----------
async function groupGuildId(groupId) {
  const { rows } = await db.getPool().query('SELECT guild_id FROM minako_mm_groups WHERE id=$1', [groupId]);
  return rows[0]?.guild_id || null;
}
async function getGroup(guildId, groupId) {
  const { rows } = await db.getPool().query('SELECT 1 FROM minako_mm_groups WHERE id=$1 AND guild_id=$2', [groupId, guildId]);
  return rows[0] ? snapshot(db.getPool(), groupId) : null;
}
async function setAnnouncement(groupId, channelId, messageId) {
  await db.getPool().query('UPDATE minako_mm_groups SET announce_channel_id=$2, announce_message_id=$3, updated_at=now() WHERE id=$1', [groupId, channelId, messageId]);
}
// Compare-and-set: só um tópico por grupo, mesmo com chamadas repetidas.
async function claimThread(groupId, threadId) {
  const { rowCount } = await db.getPool().query('UPDATE minako_mm_groups SET thread_id=$2, updated_at=now() WHERE id=$1 AND thread_id IS NULL', [groupId, threadId]);
  return rowCount === 1;
}
// Organizador inicia o grupo incompleto (se o modo permitir e o mínimo foi atingido).
async function startIncomplete(guildId, groupId, organizerId, minSize) {
  return withTx(async (c) => {
    const group = await loadGroupForUpdate(c, guildId, groupId);
    if (group.organizerId !== organizerId) throw new MmError('NOT_ORGANIZER');
    if (!group.allowIncomplete) throw new MmError('INCOMPLETE_NOT_ALLOWED');
    if (group.state !== 'open') throw new MmError('BAD_STATE');
    const n = core.confirmedCount(group);
    if (n < minSize) throw new MmError('BELOW_MINIMUM');
    // Pedidos pendentes são encerrados: o grupo passa a ter exatamente quem está confirmado.
    await c.query(`UPDATE minako_mm_group_members SET status='declined', updated_at=now() WHERE group_id=$1 AND status IN ('pending','reserved')`, [group.id]);
    await c.query(`UPDATE minako_mm_groups SET state='confirmed', capacity=$2, updated_at=now() WHERE id=$1`, [group.id, n]);
    await event(c, guildId, 'group.started_incomplete', { groupId, size: n });
    return snapshot(c, group.id);
  });
}
// Encerramento pelo organizador (ou por quem tem permissão, validada na camada de cima).
async function closeGroupById(guildId, groupId, archiveAfterSec) {
  return withTx(async (c) => {
    const group = await loadGroupForUpdate(c, guildId, groupId);
    if (['closed', 'completed'].includes(group.state)) return snapshot(c, group.id);
    await closeGroup(c, group, 'closed', archiveAfterSec);
    return snapshot(c, group.id);
  });
}
async function markReplacementNotified(groupId) {
  const { rowCount } = await db.getPool().query('UPDATE minako_mm_groups SET replacement_notified_at=now() WHERE id=$1 AND replacement_notified_at IS NULL', [groupId]);
  return rowCount === 1; // true só para quem avisou primeiro (evita aviso duplicado)
}
async function listArchiveDue(limit = 20) {
  const { rows } = await db.getPool().query(`SELECT id, guild_id, thread_id FROM minako_mm_groups WHERE state IN ('closed','completed') AND archive_at<=now() AND archived_at IS NULL ORDER BY archive_at LIMIT $1`, [limit]);
  return rows.map(r => ({ groupId: String(r.id), guildId: r.guild_id, threadId: r.thread_id }));
}
async function markArchived(groupId) { await db.getPool().query('UPDATE minako_mm_groups SET archived_at=now() WHERE id=$1 AND archived_at IS NULL', [groupId]); }

// ---------- Registro de partidas ----------
const matchView = (r) => r && ({
  id: String(r.id), guildId: r.guild_id, groupId: String(r.group_id), modeId: r.mode_id, organizerId: r.organizer_id, status: r.status,
  participantIds: r.participant_ids, responses: r.responses || {}, windowEndsAt: new Date(r.window_ends_at).getTime(), reviewedBy: r.reviewed_by || null,
});
async function matchGuildId(matchId) {
  const { rows } = await db.getPool().query('SELECT guild_id FROM minako_mm_matches WHERE id=$1', [matchId]);
  return rows[0]?.guild_id || null;
}
async function getMatch(guildId, matchId) {
  const { rows } = await db.getPool().query('SELECT * FROM minako_mm_matches WHERE id=$1 AND guild_id=$2', [matchId, guildId]);
  return matchView(rows[0]);
}
// "Registrar conclusão": idempotente por grupo (UNIQUE group_id). Distingue grupo formado de partida concluída.
async function registerMatch(guildId, groupId, organizerId, windowSec, archiveAfterSec) {
  return withTx(async (c) => {
    const group = await loadGroupForUpdate(c, guildId, groupId);
    if (group.organizerId !== organizerId) throw new MmError('NOT_ORGANIZER');
    const existing = (await c.query('SELECT * FROM minako_mm_matches WHERE group_id=$1', [group.id])).rows[0];
    if (existing) return { match: matchView(existing), created: false };
    if (group.state !== 'confirmed') throw new MmError('BAD_STATE');
    const ids = group.members.filter(m => m.status === 'confirmed').map(m => m.userId);
    const m = (await c.query(`INSERT INTO minako_mm_matches (guild_id,group_id,mode_id,organizer_id,status,participant_ids,window_ends_at)
      VALUES ($1,$2,$3,$4,'pending_window',$5, now()+make_interval(secs=>$6)) RETURNING *`, [guildId, group.id, group.modeId, organizerId, JSON.stringify(ids), windowSec])).rows[0];
    await closeGroup(c, group, 'completed', archiveAfterSec);
    for (const id of ids) await relRecord(c, guildId, id, 'completed', { groupId: group.id, matchId: m.id });
    await event(c, guildId, 'group.completed', { groupId, matchId: String(m.id) }, `group.completed:${group.id}`);
    return { match: matchView(m), created: true };
  });
}
async function markNotPlayed(guildId, groupId, organizerId, archiveAfterSec) {
  return withTx(async (c) => {
    const group = await loadGroupForUpdate(c, guildId, groupId);
    if (group.organizerId !== organizerId) throw new MmError('NOT_ORGANIZER');
    const existing = (await c.query('SELECT * FROM minako_mm_matches WHERE group_id=$1', [group.id])).rows[0];
    if (existing) return { match: matchView(existing), created: false };
    if (group.state !== 'confirmed') throw new MmError('BAD_STATE');
    const ids = group.members.filter(m => m.status === 'confirmed').map(m => m.userId);
    const m = (await c.query(`INSERT INTO minako_mm_matches (guild_id,group_id,mode_id,organizer_id,status,participant_ids,window_ends_at,resolved_at)
      VALUES ($1,$2,$3,$4,'not_played',$5, now(), now()) RETURNING *`, [guildId, group.id, group.modeId, organizerId, JSON.stringify(ids)])).rows[0];
    await closeGroup(c, group, 'closed', archiveAfterSec);
    await event(c, guildId, 'group.not_played', { groupId }, `group.not_played:${group.id}`);
    return { match: matchView(m), created: true };
  });
}
// Confirmar/contestar. Silêncio não é resposta. Contestação => revisão (sem punição, sem recompensa final).
async function respondMatch(guildId, matchId, userId, answer) {
  if (!['confirmed', 'contested'].includes(answer)) throw new MmError('BAD_ACTION');
  return withTx(async (c) => {
    const r = (await c.query('SELECT * FROM minako_mm_matches WHERE id=$1 AND guild_id=$2 FOR UPDATE', [matchId, guildId])).rows[0];
    if (!r) throw new MmError('MATCH_NOT_FOUND');
    const m = matchView(r);
    if (!m.participantIds.includes(userId)) throw new MmError('NOT_PARTICIPANT');
    if (userId === m.organizerId) throw new MmError('IS_ORGANIZER');
    if (!['pending_window', 'review'].includes(m.status) || (m.status === 'pending_window' && m.windowEndsAt <= Date.now())) return { match: m, stale: true };
    const responses = { ...m.responses, [userId]: answer };
    let status = m.status; let newlyContested = false;
    if (answer === 'contested') { newlyContested = m.status !== 'review'; status = 'review'; }
    else if (status === 'pending_window' && m.participantIds.filter(id => id !== m.organizerId).every(id => responses[id] === 'confirmed')) status = 'validated';
    const u = (await c.query(`UPDATE minako_mm_matches SET responses=$2, status=$3, resolved_at=CASE WHEN $3='validated' THEN now() ELSE resolved_at END WHERE id=$1 RETURNING *`, [matchId, JSON.stringify(responses), status])).rows[0];
    await event(c, guildId, `match.${answer}`, { matchId, userId });
    return { match: matchView(u), newlyContested };
  });
}
// Fecha janelas vencidas: sem contestação o registro permanece (validado se todos confirmaram, senão "registrado").
async function sweepMatchWindows(limit = 20) {
  return withTx(async (c) => {
    const rows = (await c.query(`SELECT * FROM minako_mm_matches WHERE status='pending_window' AND window_ends_at<=now() ORDER BY window_ends_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    const out = [];
    for (const r of rows) {
      const m = matchView(r);
      const res = core.resolveMatchRecord({ participantIds: m.participantIds, organizerId: m.organizerId, windowEndsAt: m.windowEndsAt, responses: m.responses }, Date.now());
      if (!res.final) continue;
      await c.query(`UPDATE minako_mm_matches SET status=$2, resolved_at=now() WHERE id=$1`, [m.id, res.status]);
      out.push({ ...m, status: res.status });
    }
    return out;
  });
}
async function resolveReview(guildId, matchId, reviewerId, decision, note = null) {
  if (!['valid', 'reject'].includes(decision)) throw new MmError('BAD_ACTION');
  return withTx(async (c) => {
    const r = (await c.query('SELECT * FROM minako_mm_matches WHERE id=$1 AND guild_id=$2 FOR UPDATE', [matchId, guildId])).rows[0];
    if (!r) throw new MmError('MATCH_NOT_FOUND');
    if (r.status !== 'review') throw new MmError('BAD_STATE');
    const u = (await c.query(`UPDATE minako_mm_matches SET status=$2, reviewed_by=$3, review_note=$4, resolved_at=now() WHERE id=$1 RETURNING *`,
      [matchId, decision === 'valid' ? 'validated' : 'resolved_rejected', reviewerId, note])).rows[0];
    if (decision === 'reject') await c.query(`UPDATE minako_mm_reliability SET status='removed', note='Registro de partida rejeitado pela revisão.', resolved_at=now() WHERE match_id=$1 AND kind='completed' AND status<>'removed'`, [matchId]);
    await event(c, guildId, `match.review_${decision}`, { matchId, reviewerId });
    return matchView(u);
  });
}

// Diagnóstico operacional (somente leitura): contagens reais do módulo.
async function getDiagnostics(guildId) {
  const q = async (sql, p = [guildId]) => (await db.getPool().query(sql, p)).rows[0];
  const [av, groups, props, matches, failures, ver] = await Promise.all([
    q(`SELECT count(*)::int n FROM minako_mm_availability WHERE guild_id=$1 AND status='active' AND expires_at>now()`),
    q(`SELECT count(*) FILTER (WHERE state IN ('open','searching_replacement'))::int open_n, count(*) FILTER (WHERE state='confirmed')::int confirmed_n FROM minako_mm_groups WHERE guild_id=$1`),
    q(`SELECT count(*)::int n FROM minako_mm_proposals WHERE guild_id=$1 AND status='pending' AND expires_at>now()`),
    q(`SELECT count(*) FILTER (WHERE status='review')::int review_n, count(*) FILTER (WHERE status='pending_window')::int pending_n FROM minako_mm_matches WHERE guild_id=$1`),
    q(`SELECT count(*)::int n FROM minako_mm_events WHERE guild_id=$1 AND created_at>now()-interval '24 hours' AND type IN ('proposal.dm_failed','group.announcement_failed','group.thread_failed','group.thread_unavailable','group.organizer_dm_failed','match.review_unrouted','match.window_unposted')`),
    q('SELECT max(version) AS v FROM minako_mm_schema', []),
  ]);
  return { schemaVersion: ver.v, availableNow: av.n, openGroups: groups.open_n, confirmedGroups: groups.confirmed_n, pendingProposals: props.n,
    matchesInReview: matches.review_n, matchesPendingWindow: matches.pending_n, failuresLast24h: failures.n };
}
// Exportação para backup (somente leitura). Retorna { tabela: linhas[] } apenas das tabelas minako_mm_*.
const BACKUP_TABLES = ['minako_mm_settings', 'minako_mm_prefs', 'minako_mm_favorites', 'minako_mm_partnerships', 'minako_mm_notice_log', 'minako_mm_teams', 'minako_mm_team_members', 'minako_mm_reliability', 'minako_mm_availability', 'minako_mm_groups', 'minako_mm_group_members', 'minako_mm_proposals', 'minako_mm_proposal_members', 'minako_mm_blocked_pairs', 'minako_mm_matches', 'minako_mm_events', 'minako_mm_schema'];
async function exportAll(guildId) {
  if (!guildId) throw new Error('exportAll exige o ID do servidor.');
  const sqls = {
    minako_mm_group_members: 'SELECT * FROM minako_mm_group_members WHERE group_id IN (SELECT id FROM minako_mm_groups WHERE guild_id=$1)',
    minako_mm_proposal_members: 'SELECT * FROM minako_mm_proposal_members WHERE proposal_id IN (SELECT id FROM minako_mm_proposals WHERE guild_id=$1)',
    minako_mm_team_members: 'SELECT * FROM minako_mm_team_members WHERE team_id IN (SELECT id FROM minako_mm_teams WHERE guild_id=$1)',
    minako_mm_schema: 'SELECT *, $1::text AS _guild FROM minako_mm_schema',
  };
  const out = {};
  for (const t of BACKUP_TABLES) out[t] = (await db.getPool().query(sqls[t] || `SELECT * FROM ${t} WHERE guild_id=$1`, [guildId])).rows;
  return out;
}

// Grupos ABERTOS sem movimento além do prazo do servidor são encerrados (sem penalidade).
// SKIP LOCKED: se alguém está entrando agora, o grupo não é tocado neste ciclo.
async function sweepInactiveGroups(limit = 20) {
  return withTx(async (c) => {
    const rows = (await c.query(
      `SELECT g.id, g.guild_id, g.organizer_id, COALESCE(NULLIF(s.settings->>'archiveAfterSec','')::int, 259200) AS archive_sec
         FROM minako_mm_groups g LEFT JOIN minako_mm_settings s ON s.guild_id=g.guild_id
        WHERE g.state='open'
          AND g.updated_at < now() - make_interval(secs => COALESCE(NULLIF(s.settings->>'groupInactivityTtlSec','')::int, 7200))
        ORDER BY g.updated_at LIMIT $1 FOR UPDATE OF g SKIP LOCKED`, [limit])).rows;
    const out = [];
    for (const r of rows) {
      await closeGroup(c, { id: String(r.id), guildId: r.guild_id, state: 'open' }, 'closed', r.archive_sec);
      await event(c, r.guild_id, 'group.expired_inactive', { groupId: String(r.id) }, `group.expired_inactive:${r.id}`);
      out.push({ groupId: String(r.id), guildId: r.guild_id, organizerId: r.organizer_id });
    }
    return out;
  });
}

// ---------- Preferências do usuário ----------
async function getPrefs(guildId, userId, c = db.getPool()) {
  const { rows } = await c.query('SELECT notif, play, visibility, quiet, EXTRACT(EPOCH FROM paused_until)*1000 AS paused_ms, delivery_issue FROM minako_mm_prefs WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
  const r = rows[0];
  return { ...core.normalizePrefs({ notif: r?.notif, play: r?.play, visibility: r?.visibility, quiet: r?.quiet, pausedUntil: r?.paused_ms == null ? null : Number(r.paused_ms) }), deliveryIssue: r?.delivery_issue || null };
}
// patch: { notif?: {categoria: destino}, play?: {...} | null }. Alterar só notificações NUNCA mexe na disponibilidade.
async function savePrefs(guildId, userId, patch) {
  return withTx(async (c) => {
    const cur = await getPrefs(guildId, userId, c);
    const next = core.normalizePrefs({
      notif: { ...cur.notif, ...(patch.notif || {}) }, play: 'play' in patch ? patch.play : cur.play, visibility: patch.visibility ?? cur.visibility,
      quiet: 'quiet' in patch ? patch.quiet : cur.quiet, pausedUntil: 'pausedUntil' in patch ? patch.pausedUntil : cur.pausedUntil,
    });
    await c.query(`INSERT INTO minako_mm_prefs (guild_id,user_id,notif,play,visibility,quiet,paused_until) VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::double precision IS NULL THEN NULL ELSE to_timestamp($7/1000.0) END)
      ON CONFLICT (guild_id,user_id) DO UPDATE SET notif=EXCLUDED.notif, play=EXCLUDED.play, visibility=EXCLUDED.visibility, quiet=EXCLUDED.quiet, paused_until=EXCLUDED.paused_until, updated_at=now()`,
      [guildId, userId, JSON.stringify(next.notif), next.play ? JSON.stringify(next.play) : null, next.visibility, next.quiet ? JSON.stringify(next.quiet) : null, next.pausedUntil]);
    return { ...next, deliveryIssue: cur.deliveryIssue };
  });
}
async function recordDeliveryIssue(guildId, userId, category, via) {
  await db.getPool().query(`INSERT INTO minako_mm_prefs (guild_id,user_id,delivery_issue) VALUES ($1,$2,$3)
    ON CONFLICT (guild_id,user_id) DO UPDATE SET delivery_issue=EXCLUDED.delivery_issue`, [guildId, userId, JSON.stringify({ category, via, at: Date.now() })]);
}
async function clearDeliveryIssue(guildId, userId) {
  await db.getPool().query('UPDATE minako_mm_prefs SET delivery_issue=NULL WHERE guild_id=$1 AND user_id=$2', [guildId, userId]);
}
// Avisos de expiração: só para quem habilitou (notif.expiry='dm'); marca como avisado ANTES de enviar (um aviso por disponibilidade).
async function claimExpiryWarnings(limit = 50) {
  const { rows } = await db.getPool().query(
    `UPDATE minako_mm_availability a SET expiry_warned_at=now()
      WHERE (a.guild_id,a.user_id) IN (
        SELECT av.guild_id, av.user_id FROM minako_mm_availability av
          JOIN minako_mm_prefs p ON p.guild_id=av.guild_id AND p.user_id=av.user_id AND p.notif->>'expiry'='dm'
         WHERE av.status='active' AND av.expiry_warned_at IS NULL AND av.expires_at>now() AND av.expires_at<=now()+make_interval(secs=>$2)
         LIMIT $1 FOR UPDATE OF av SKIP LOCKED)
      RETURNING a.guild_id, a.user_id, EXTRACT(EPOCH FROM a.expires_at)*1000 AS expires_ms`, [limit, core.EXPIRY_WARNING_SEC]);
  return rows.map(r => ({ guildId: r.guild_id, userId: r.user_id, expiresAt: Number(r.expires_ms) }));
}
// Reconciliação: lote de grupos vivos ainda não conferidos nos últimos 5 min (marca no mesmo comando; seguro com 2 instâncias).
async function claimReconcileBatch(limit = 20) {
  const { rows } = await db.getPool().query(
    `UPDATE minako_mm_groups SET reconciled_at=now() WHERE id IN (
       SELECT id FROM minako_mm_groups WHERE state IN ('open','confirmed','searching_replacement')
          AND (reconciled_at IS NULL OR reconciled_at < now() - interval '5 minutes')
        ORDER BY reconciled_at NULLS FIRST LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, guild_id, state, thread_id, announce_message_id`, [limit]);
  return rows.map(r => ({ groupId: String(r.id), guildId: r.guild_id, state: r.state, threadId: r.thread_id, announceMessageId: r.announce_message_id }));
}

module.exports = {
  _internals: { lockUsers, isBusy, event, loadGroupForUpdate, snapshot, confirmMember, closeGroup, relRecord },
  getPrefs, savePrefs, recordDeliveryIssue, clearDeliveryIssue, claimExpiryWarnings, claimReconcileBatch,
  sweepInactiveGroups,
  getDiagnostics, exportAll, BACKUP_TABLES,
  matchGuildId, getMatch, registerMatch, markNotPlayed, respondMatch, sweepMatchWindows, resolveReview,
  groupGuildId, getGroup, setAnnouncement, claimThread, startIncomplete, closeGroupById, markReplacementNotified, listArchiveDue, markArchived,
  logEvent, proposalGuildId, setProposalDm, listProposalMembers, getProposal, pendingProposalForUser, getAvailability,
  listCentralGuilds, getCentralData,
  MmError, withTx, getSettings, saveSettingsPatch, claimCentralMessage,
  setAvailability, changeAvailability, listQueue, countActiveAvailability, blockedPairs,
  createGroup, requestJoin, decideRequest, leaveGroup, replacementDecision, listOpenGroups,
  createProposal, respondProposal, sweepExpiredProposals, sweepExpiredAvailability, listReplacementDue,
};
