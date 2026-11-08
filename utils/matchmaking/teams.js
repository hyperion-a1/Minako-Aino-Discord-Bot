'use strict';
// Regras PURAS de equipes e duplas recorrentes (briefing 2.10). Sem Discord, sem banco.
//  - Associação a uma equipe NÃO é disponibilidade: cada membro confirma CADA sessão.
//  - A sessão procura apenas vagas realmente abertas (vagas dos membros ficam reservadas até eles responderem).
//  - Ninguém assume compromissos incompatíveis; sair, recusar ou não confirmar não gera penalidade.
const LIMITS = Object.freeze({
  maxMembers: 5,            // membros ativos + convites abertos por equipe (dupla = 2)
  maxTeamsPerUser: 3,       // equipes em que uma pessoa pode ser membro ativo
  maxOwnedPerUser: 2,       // equipes que uma pessoa pode criar/ser dona
  inviteTtlMs: 7 * 86400_000, reinviteCooldownMs: 7 * 86400_000,
  nameMin: 3, nameMax: 30,
});

// Nome público (aparece em anúncios): sem menções, links ou símbolos que abram brechas de abuso.
function normalizeTeamName(raw) {
  const name = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) return { ok: false, code: 'NAME_LENGTH' };
  if (/[@#<>`*_~|\\/\[\]]/.test(name) || /https?:|www\.|discord\.gg/i.test(name)) return { ok: false, code: 'NAME_CHARS' };
  if (!/^[\p{L}\p{N} .'\-!&+]+$/u.test(name)) return { ok: false, code: 'NAME_CHARS' };
  return { ok: true, name, key: name.toLowerCase() };
}
const teamKind = (activeCount) => (activeCount === 2 ? 'Dupla' : 'Equipe');

// ctx: { nameTaken, ownedCount, memberTeamCount }
function canCreateTeam(rawName, ctx) {
  const n = normalizeTeamName(rawName);
  if (!n.ok) return n;
  if (ctx.nameTaken) return { ok: false, code: 'NAME_TAKEN' };
  if (ctx.ownedCount >= LIMITS.maxOwnedPerUser) return { ok: false, code: 'OWNER_LIMIT' };
  if (ctx.memberTeamCount >= LIMITS.maxTeamsPerUser) return { ok: false, code: 'MEMBER_LIMIT' };
  return { ok: true, name: n.name, key: n.key };
}

// ctx: { team:{status,ownerId}, members:[{userId,status}], targetIsBot, targetTeamCount, lastClosed:{status,at}|null }
function canInviteToTeam(inviterId, targetId, ctx, now) {
  if (ctx.team.status !== 'active') return { ok: false, code: 'TEAM_DISBANDED' };
  if (String(ctx.team.ownerId) !== String(inviterId)) return { ok: false, code: 'NOT_OWNER' };
  if (String(inviterId) === String(targetId)) return { ok: false, code: 'SELF' };
  if (ctx.targetIsBot) return { ok: false, code: 'BOT' };
  const cur = ctx.members.find(m => String(m.userId) === String(targetId));
  if (cur?.status === 'active') return { ok: false, code: 'ALREADY_MEMBER' };
  if (cur?.status === 'invited') return { ok: false, code: 'ALREADY_INVITED' };
  if (ctx.members.filter(m => ['active', 'invited'].includes(m.status)).length >= LIMITS.maxMembers) return { ok: false, code: 'TEAM_FULL' };
  if (ctx.targetTeamCount >= LIMITS.maxTeamsPerUser) return { ok: false, code: 'TARGET_LIMIT' };
  if (ctx.lastClosed && ['declined', 'expired'].includes(ctx.lastClosed.status) && now - ctx.lastClosed.at < LIMITS.reinviteCooldownMs) return { ok: false, code: 'COOLDOWN' };
  return { ok: true };
}

// Saída de um membro (ou do dono). Dono que sai passa a equipe ao membro ativo mais antigo; sozinho, a equipe se desfaz.
// activeMembers: [{userId, joinedAt}] incluindo quem sai.
function afterTeamLeave(team, leaverId, activeMembers) {
  const rest = activeMembers.filter(m => String(m.userId) !== String(leaverId)).sort((a, b) => a.joinedAt - b.joinedAt || String(a.userId).localeCompare(String(b.userId)));
  if (!rest.length) return { action: 'disband' };
  if (String(team.ownerId) === String(leaverId)) return { action: 'transfer', newOwnerId: rest[0].userId };
  return { action: 'leave' };
}

// Planejamento de uma sessão. Só o que decide quem entra na reserva; persistência fica no banco.
//   activeMembers: ids dos membros ativos · busyIds: ids já comprometidos em outro grupo · mode: { idealSize }
function planSession({ activeMembers, starterId, mode, busyIds = [] }) {
  const members = activeMembers.map(String);
  if (!members.includes(String(starterId))) return { ok: false, code: 'NOT_MEMBER' };
  if (members.length > mode.idealSize) return { ok: false, code: 'TEAM_TOO_BIG' };
  if (busyIds.map(String).includes(String(starterId))) return { ok: false, code: 'STARTER_BUSY' };
  const others = members.filter(id => id !== String(starterId));
  const skippedBusy = others.filter(id => busyIds.map(String).includes(id));
  return { ok: true, capacity: mode.idealSize, reserveIds: others.filter(id => !skippedBusy.includes(id)), skippedBusy };
}

// Resposta de um membro à reserva. now vs reservedUntil: reserva vencida NÃO é reativada (a vaga pode já ter sido preenchida).
function reservationState(member, now) {
  if (!member || member.status !== 'reserved') return 'none';
  return member.reservedUntil != null && member.reservedUntil <= now ? 'expired' : 'active';
}

const TEAM_ERRORS = Object.freeze({
  NAME_LENGTH: `O nome precisa ter de ${LIMITS.nameMin} a ${LIMITS.nameMax} caracteres.`, NAME_CHARS: 'Use só letras, números, espaços e - . \' ! & + no nome (sem menções, links ou símbolos especiais).',
  NAME_TAKEN: 'Já existe uma equipe com esse nome.', OWNER_LIMIT: `Você já é dono de ${LIMITS.maxOwnedPerUser} equipes. Dissolva uma ou passe a liderança antes de criar outra.`,
  MEMBER_LIMIT: `Você já participa de ${LIMITS.maxTeamsPerUser} equipes. Saia de uma para criar ou entrar em outra.`,
  TEAM_DISBANDED: 'Essa equipe foi dissolvida.', NOT_OWNER: 'Apenas o dono da equipe pode fazer isso.', SELF: 'Você não pode convidar a si mesmo.', BOT: 'Bots não podem ser membros.',
  ALREADY_MEMBER: 'Essa pessoa já está na equipe.', ALREADY_INVITED: 'Essa pessoa já tem um convite aberto.', TEAM_FULL: `A equipe já tem o máximo de ${LIMITS.maxMembers} membros (contando convites abertos).`,
  TARGET_LIMIT: 'Essa pessoa já participa do máximo de equipes.', COOLDOWN: 'Esse convite foi recusado ou expirou há pouco. Para não incomodar, espere alguns dias para tentar de novo.',
  NOT_MEMBER: 'Só membros da equipe podem iniciar uma sessão.', TEAM_TOO_BIG: 'A equipe tem mais membros do que as vagas desse modo. Escolha outro modo.', STARTER_BUSY: 'Você já está em outro grupo ativo. Termine ou saia dele antes de iniciar uma sessão.',
  SESSION_LIVE: 'Essa equipe já tem uma sessão em andamento.', NOT_FOUND: 'Essa equipe não existe mais.',
});

module.exports = { LIMITS, normalizeTeamName, teamKind, canCreateTeam, canInviteToTeam, afterTeamLeave, planSession, reservationState, TEAM_ERRORS };
