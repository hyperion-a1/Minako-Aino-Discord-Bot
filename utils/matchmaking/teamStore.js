'use strict';
// Persistência de equipes/duplas recorrentes e das sessões da equipe. Decisões: teams.js (puro) e mmCore.
// A SESSÃO da equipe é um GRUPO comum (anúncio, vagas, tópico e registro de partida reaproveitados),
// com as vagas dos demais membros RESERVADAS até eles confirmarem; só vagas realmente abertas ficam visíveis a quem é de fora.
const db = require('../db');
const store = require('./store');
const core = require('./mmCore');
const teams = require('./teams');
const { MmError, withTx } = store;
const I = store._internals;

const ms = (v) => (v == null ? null : new Date(v).getTime());
const err = (code) => new MmError(code, teams.TEAM_ERRORS[code] || code);
const LIVE = ['open', 'confirmed', 'searching_replacement'];
const tview = (r) => r && ({ id: String(r.id), guildId: r.guild_id, name: r.name, ownerId: r.owner_id, status: r.status });

async function loadTeamForUpdate(c, teamId) {
  const t = tview((await c.query('SELECT * FROM minako_mm_teams WHERE id=$1 FOR UPDATE', [teamId])).rows[0]);
  if (!t) throw err('NOT_FOUND');
  return t;
}
const membersOf = async (c, teamId) => (await c.query('SELECT user_id, status, invited_by, EXTRACT(EPOCH FROM joined_at)*1000 AS joined_ms, EXTRACT(EPOCH FROM expires_at)*1000 AS expires_ms, EXTRACT(EPOCH FROM responded_at)*1000 AS responded_ms FROM minako_mm_team_members WHERE team_id=$1', [teamId])).rows
  .map(r => ({ userId: r.user_id, status: r.status, invitedBy: r.invited_by, joinedAt: r.joined_ms == null ? null : Number(r.joined_ms), expiresAt: r.expires_ms == null ? null : Number(r.expires_ms), respondedAt: r.responded_ms == null ? null : Number(r.responded_ms) }));
const teamCountOf = async (c, guildId, userId) => (await c.query(`SELECT count(*)::int n FROM minako_mm_team_members m JOIN minako_mm_teams t ON t.id=m.team_id WHERE t.guild_id=$1 AND t.status='active' AND m.user_id=$2 AND m.status='active'`, [guildId, userId])).rows[0].n;

async function teamGuildId(teamId) { const { rows } = await db.getPool().query('SELECT guild_id FROM minako_mm_teams WHERE id=$1', [teamId]); return rows[0]?.guild_id || null; }

// ---------- Equipes ----------
async function createTeam(guildId, ownerId, rawName) {
  return withTx(async (c) => {
    await I.lockUsers(c, guildId, [ownerId]);
    const n = teams.normalizeTeamName(rawName);
    const taken = n.ok ? (await c.query(`SELECT 1 FROM minako_mm_teams WHERE guild_id=$1 AND name_key=$2 AND status='active'`, [guildId, n.key])).rows.length > 0 : false;
    const owned = (await c.query(`SELECT count(*)::int n FROM minako_mm_teams WHERE guild_id=$1 AND owner_id=$2 AND status='active'`, [guildId, ownerId])).rows[0].n;
    const d = teams.canCreateTeam(rawName, { nameTaken: taken, ownedCount: owned, memberTeamCount: await teamCountOf(c, guildId, ownerId) });
    if (!d.ok) throw err(d.code);
    const t = (await c.query(`INSERT INTO minako_mm_teams (guild_id,name,name_key,owner_id) VALUES ($1,$2,$3,$4) RETURNING id`, [guildId, d.name, d.key, ownerId])).rows[0];
    await c.query(`INSERT INTO minako_mm_team_members (team_id,user_id,status,joined_at) VALUES ($1,$2,'active',now())`, [t.id, ownerId]);
    await I.event(c, guildId, 'team.created', { teamId: String(t.id) });
    return { id: String(t.id), name: d.name };
  });
}
async function listMyTeams(guildId, userId) {
  const mine = (await db.getPool().query(
    `SELECT t.id, t.name, t.owner_id, (SELECT count(*)::int FROM minako_mm_team_members x WHERE x.team_id=t.id AND x.status='active') AS active_n
       FROM minako_mm_teams t JOIN minako_mm_team_members m ON m.team_id=t.id AND m.user_id=$2 AND m.status='active'
      WHERE t.guild_id=$1 AND t.status='active' ORDER BY t.created_at`, [guildId, userId])).rows;
  const inv = (await db.getPool().query(
    `SELECT t.id, t.name, m.invited_by, EXTRACT(EPOCH FROM m.expires_at)*1000 AS expires_ms
       FROM minako_mm_team_members m JOIN minako_mm_teams t ON t.id=m.team_id
      WHERE t.guild_id=$1 AND t.status='active' AND m.user_id=$2 AND m.status='invited' AND m.expires_at>now() ORDER BY m.created_at`, [guildId, userId])).rows;
  return {
    teams: mine.map(r => ({ id: String(r.id), name: r.name, ownerId: r.owner_id, activeCount: r.active_n, isOwner: r.owner_id === userId })),
    invites: inv.map(r => ({ teamId: String(r.id), name: r.name, invitedBy: r.invited_by, expiresAt: Number(r.expires_ms) })),
  };
}
async function getTeamDetail(guildId, teamId) {
  const c = db.getPool();
  const t = tview((await c.query('SELECT * FROM minako_mm_teams WHERE id=$1 AND guild_id=$2', [teamId, guildId])).rows[0]);
  if (!t) return null;
  const members = (await membersOf(c, teamId)).filter(m => m.status === 'active' || (m.status === 'invited' && m.expiresAt > Date.now()));
  const live = (await c.query(`SELECT id FROM minako_mm_groups WHERE team_id=$1 AND state = ANY($2) LIMIT 1`, [teamId, LIVE])).rows[0];
  return { ...t, members, liveGroupId: live ? String(live.id) : null };
}

async function inviteMember(guildId, teamId, inviterId, targetId, { targetIsBot = false, now = Date.now() } = {}) {
  return withTx(async (c) => {
    await I.lockUsers(c, guildId, [inviterId, targetId]);
    const team = await loadTeamForUpdate(c, teamId);
    if (team.guildId !== guildId) throw err('NOT_FOUND');
    await c.query(`UPDATE minako_mm_team_members SET status='expired', responded_at=now() WHERE team_id=$1 AND user_id=$2 AND status='invited' AND expires_at<=now()`, [teamId, targetId]);
    const members = await membersOf(c, teamId);
    const cur = members.find(m => m.userId === String(targetId));
    const d = teams.canInviteToTeam(inviterId, targetId, { team, members, targetIsBot, targetTeamCount: await teamCountOf(c, guildId, targetId),
      lastClosed: cur && ['declined', 'expired', 'left', 'removed'].includes(cur.status) ? { status: cur.status, at: cur.respondedAt ?? 0 } : null }, now);
    if (!d.ok) throw err(d.code);
    await c.query(`INSERT INTO minako_mm_team_members (team_id,user_id,status,invited_by,expires_at) VALUES ($1,$2,'invited',$3, now() + make_interval(secs=>$4))
      ON CONFLICT (team_id,user_id) DO UPDATE SET status='invited', invited_by=EXCLUDED.invited_by, expires_at=EXCLUDED.expires_at, joined_at=NULL, responded_at=NULL, dm_channel_id=NULL, dm_message_id=NULL`,
      [teamId, String(targetId), String(inviterId), teams.LIMITS.inviteTtlMs / 1000]);
    await I.event(c, guildId, 'team.invited', { teamId });
    return { team: { id: team.id, name: team.name, ownerId: team.ownerId } };
  });
}
// Responder convite à equipe (idempotente; convite vencido ou equipe dissolvida não é reativado).
async function respondInvite(teamId, userId, accept) {
  return withTx(async (c) => {
    const team = await loadTeamForUpdate(c, teamId);
    await I.lockUsers(c, team.guildId, [userId]);
    const m = (await membersOf(c, teamId)).find(x => x.userId === String(userId));
    if (!m) throw new MmError('NOT_INVITED', 'Esse convite não é seu.');
    if (m.status !== 'invited') return { stale: true, status: m.status, team };
    if (team.status !== 'active') return { stale: true, status: 'disbanded', team };
    if (m.expiresAt <= Date.now()) { await c.query(`UPDATE minako_mm_team_members SET status='expired', responded_at=now() WHERE team_id=$1 AND user_id=$2`, [teamId, userId]); return { stale: true, status: 'expired', team }; }
    if (!accept) { await c.query(`UPDATE minako_mm_team_members SET status='declined', responded_at=now() WHERE team_id=$1 AND user_id=$2`, [teamId, userId]); return { status: 'declined', team }; }
    if ((await teamCountOf(c, team.guildId, userId)) >= teams.LIMITS.maxTeamsPerUser) throw err('TARGET_LIMIT');
    await c.query(`UPDATE minako_mm_team_members SET status='active', joined_at=now(), responded_at=now() WHERE team_id=$1 AND user_id=$2`, [teamId, userId]);
    await I.event(c, team.guildId, 'team.member_joined', { teamId });
    return { status: 'active', team };
  });
}
async function removeMember(guildId, teamId, ownerId, targetId) {
  return withTx(async (c) => {
    const team = await loadTeamForUpdate(c, teamId);
    if (team.guildId !== guildId) throw err('NOT_FOUND');
    if (team.ownerId !== String(ownerId)) throw err('NOT_OWNER');
    if (String(targetId) === team.ownerId) throw new MmError('OWNER_CANNOT_BE_REMOVED', 'O dono não pode ser removido; use "Sair da equipe" para passar a liderança.');
    const { rowCount } = await c.query(`UPDATE minako_mm_team_members SET status='removed', responded_at=now() WHERE team_id=$1 AND user_id=$2 AND status IN ('active','invited')`, [teamId, String(targetId)]);
    return rowCount === 1;
  });
}
async function leaveTeam(guildId, teamId, userId) {
  return withTx(async (c) => {
    const team = await loadTeamForUpdate(c, teamId);
    if (team.guildId !== guildId) throw err('NOT_FOUND');
    const active = (await membersOf(c, teamId)).filter(m => m.status === 'active');
    if (!active.some(m => m.userId === String(userId))) throw new MmError('NOT_MEMBER', 'Você não está nessa equipe.');
    const d = teams.afterTeamLeave(team, userId, active.map(m => ({ userId: m.userId, joinedAt: m.joinedAt ?? 0 })));
    await c.query(`UPDATE minako_mm_team_members SET status='left', responded_at=now() WHERE team_id=$1 AND user_id=$2`, [teamId, String(userId)]);
    if (d.action === 'transfer') await c.query('UPDATE minako_mm_teams SET owner_id=$2 WHERE id=$1', [teamId, d.newOwnerId]);
    if (d.action === 'disband') { await c.query(`UPDATE minako_mm_teams SET status='disbanded', disbanded_at=now(), disbanded_by=$2 WHERE id=$1`, [teamId, String(userId)]); }
    await I.event(c, guildId, `team.left_${d.action}`, { teamId });
    return { ...d, team };
  });
}
async function disbandTeam(guildId, teamId, byId, { staff = false } = {}) {
  return withTx(async (c) => {
    const team = await loadTeamForUpdate(c, teamId);
    if (team.guildId !== guildId) throw err('NOT_FOUND');
    if (team.status !== 'active') return { already: true, team };
    if (!staff && team.ownerId !== String(byId)) throw err('NOT_OWNER');
    await c.query(`UPDATE minako_mm_teams SET status='disbanded', disbanded_at=now(), disbanded_by=$2 WHERE id=$1`, [teamId, String(byId)]);
    await c.query(`UPDATE minako_mm_team_members SET status='expired', responded_at=now() WHERE team_id=$1 AND status='invited'`, [teamId]);
    await I.event(c, guildId, 'team.disbanded', { teamId, staff });
    return { already: false, team };
  });
}
async function setInviteDm(teamId, userId, channelId, messageId) { await db.getPool().query('UPDATE minako_mm_team_members SET dm_channel_id=$3, dm_message_id=$4 WHERE team_id=$1 AND user_id=$2', [teamId, String(userId), channelId, messageId]); }
async function getInvite(teamId, userId) {
  const { rows } = await db.getPool().query(`SELECT t.id, t.name, t.guild_id, m.invited_by, m.status, EXTRACT(EPOCH FROM m.expires_at)*1000 AS expires_ms FROM minako_mm_team_members m JOIN minako_mm_teams t ON t.id=m.team_id WHERE m.team_id=$1 AND m.user_id=$2`, [teamId, String(userId)]);
  const r = rows[0]; return r && { teamId: String(r.id), name: r.name, guildId: r.guild_id, invitedBy: r.invited_by, status: r.status, expiresAt: Number(r.expires_ms) };
}
async function sweepTeamInvites(limit = 50) {
  const { rows } = await db.getPool().query(`UPDATE minako_mm_team_members SET status='expired', responded_at=now() WHERE (team_id,user_id) IN (SELECT team_id,user_id FROM minako_mm_team_members WHERE status='invited' AND expires_at<=now() LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING team_id, user_id, dm_message_id, invited_by`, [limit]);
  return rows.map(r => ({ teamId: String(r.team_id), userId: r.user_id, dmMessageId: r.dm_message_id, invitedBy: r.invited_by }));
}

// ---------- Sessão da equipe ----------
// Cada membro ativo confirma CADA sessão. Os demais ficam com a vaga RESERVADA por reserveTtlSec; quem já está ocupado em outro grupo não é reservado.
async function startSession(guildId, teamId, starterId, { mode, joinMethod = 'approval', reserveTtlSec = 600 }) {
  return withTx(async (c) => {
    const team = await loadTeamForUpdate(c, teamId);
    if (team.guildId !== guildId) throw err('NOT_FOUND');
    if (team.status !== 'active') throw err('TEAM_DISBANDED');
    const active = (await membersOf(c, teamId)).filter(m => m.status === 'active').map(m => m.userId);
    await I.lockUsers(c, guildId, active);
    const busyIds = []; for (const id of active) if (await I.isBusy(c, guildId, id)) busyIds.push(id);
    const plan = teams.planSession({ activeMembers: active, starterId, mode, busyIds });
    if (!plan.ok) throw err(plan.code);
    if ((await c.query('SELECT 1 FROM minako_mm_groups WHERE team_id=$1 AND state = ANY($2)', [teamId, LIVE])).rows.length) throw err('SESSION_LIVE');
    const g = (await c.query(`INSERT INTO minako_mm_groups (guild_id,mode_id,organizer_id,state,capacity,join_method,allow_incomplete,team_id)
      VALUES ($1,$2,$3,'open',$4,$5,$6,$7) RETURNING id`, [guildId, mode.id, String(starterId), plan.capacity, joinMethod === 'direct' ? 'direct' : 'approval', Boolean(mode.allowIncomplete), teamId])).rows[0];
    await c.query(`INSERT INTO minako_mm_group_members (group_id,user_id,status) VALUES ($1,$2,'confirmed')`, [g.id, String(starterId)]);
    await I.relRecord(c, guildId, starterId, 'joined', { groupId: g.id });
    for (const id of plan.reserveIds) await c.query(`INSERT INTO minako_mm_group_members (group_id,user_id,status,reserved_until) VALUES ($1,$2,'reserved', now() + make_interval(secs=>$3))`, [g.id, id, reserveTtlSec]);
    await c.query(`UPDATE minako_mm_availability SET status='ended' WHERE guild_id=$1 AND user_id=$2 AND status<>'ended'`, [guildId, String(starterId)]);
    await I.event(c, guildId, 'team.session_started', { teamId, groupId: String(g.id), reserved: plan.reserveIds.length });
    return { groupId: String(g.id), reserveIds: plan.reserveIds, skippedBusy: plan.skippedBusy, team, group: await I.snapshot(c, g.id) };
  });
}
// Resposta do membro à sessão. 'yes' confirma (revalidando compromissos); 'no' libera a vaga. Reserva vencida só vale se a vaga continuar livre.
async function answerReservation(guildId, groupId, userId, answer, { now = Date.now() } = {}) {
  if (!['yes', 'no'].includes(answer)) throw new MmError('BAD_ACTION');
  return withTx(async (c) => {
    await I.lockUsers(c, guildId, [userId]);
    const group = await I.loadGroupForUpdate(c, guildId, groupId);
    if (!['open', 'searching_replacement'].includes(group.state)) return { stale: 'closed', group: await I.snapshot(c, group.id) };
    const row = group.members.find(m => m.userId === String(userId));
    const st = teams.reservationState(row, now);
    if (row?.status === 'confirmed') return { stale: 'already', group: await I.snapshot(c, group.id) };
    if (answer === 'no') {
      if (st === 'none') return { stale: 'none', group: await I.snapshot(c, group.id) };
      await c.query(`UPDATE minako_mm_group_members SET status='declined', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [group.id, String(userId)]);
      await I.event(c, guildId, 'team.reservation_declined', { groupId });
      return { status: 'declined', group: await I.snapshot(c, group.id) };
    }
    if (st === 'none') return { stale: 'none', group: await I.snapshot(c, group.id) };
    if (st === 'expired' && core.freeSlots(group, now) <= 0) return { stale: 'expired', group: await I.snapshot(c, group.id) };   // a vaga já foi preenchida
    if (await I.isBusy(c, guildId, userId, group.id)) throw new MmError('INCOMPATIBLE_COMMITMENT', 'Você já está em outro grupo ativo.');
    await I.confirmMember(c, group, String(userId), null);
    await I.event(c, guildId, 'group.joined', { groupId, userId: String(userId) });
    return { status: 'confirmed', group: await I.snapshot(c, group.id) };
  });
}
// Reservas vencidas viram "não confirmou" (sem punição) e a vaga passa a estar realmente aberta.
async function sweepReservations(limit = 50) {
  return withTx(async (c) => {
    const rows = (await c.query(
      `SELECT m.group_id, m.user_id, g.guild_id, g.state, g.organizer_id FROM minako_mm_group_members m JOIN minako_mm_groups g ON g.id=m.group_id
        WHERE m.status='reserved' AND m.reserved_until<=now() ORDER BY m.reserved_until LIMIT $1 FOR UPDATE OF m SKIP LOCKED`, [limit])).rows;
    for (const r of rows) await c.query(`UPDATE minako_mm_group_members SET status='declined', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [r.group_id, r.user_id]);
    return rows.filter(r => ['open', 'searching_replacement'].includes(r.state)).map(r => ({ groupId: String(r.group_id), guildId: r.guild_id, userId: r.user_id, organizerId: r.organizer_id }));
  });
}

module.exports = { teamGuildId, createTeam, listMyTeams, getTeamDetail, inviteMember, respondInvite, removeMember, leaveTeam, disbandTeam, setInviteDm, getInvite, sweepTeamInvites, startSession, answerReservation, sweepReservations };
