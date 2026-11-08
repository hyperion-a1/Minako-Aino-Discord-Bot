'use strict';
const assert = require('node:assert/strict');
const T = require('../utils/matchmaking/teams');
const core = require('../utils/matchmaking/mmCore');
let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
const NOW = 1_800_000_000_000; const D = 86400_000;
t('nome da equipe: normaliza espaços, limita tamanho e barra menções/links/símbolos', () => {
  assert.deepEqual(T.normalizeTeamName('  Os   Lendários  '), { ok: true, name: 'Os Lendários', key: 'os lendários' });
  assert.equal(T.normalizeTeamName('ab').code, 'NAME_LENGTH'); assert.equal(T.normalizeTeamName('x'.repeat(31)).code, 'NAME_LENGTH');
  for (const bad of ['@everyone fans', 'Time #1', 'site https://x.com', 'discord.gg/abc', 'Time <b>', 'Time_*x*', 'a/b/c', '😀😀😀']) assert.equal(T.normalizeTeamName(bad).code, 'NAME_CHARS', bad);
  assert.ok(T.normalizeTeamName("D'Ouro & Cia - 2").ok);
});
t('criar equipe: nome repetido (sem diferenciar maiúsculas), limite de equipes próprias e de participação', () => {
  assert.equal(T.canCreateTeam('Time Ouro', { nameTaken: true, ownedCount: 0, memberTeamCount: 0 }).code, 'NAME_TAKEN');
  assert.equal(T.canCreateTeam('Time Ouro', { nameTaken: false, ownedCount: 2, memberTeamCount: 0 }).code, 'OWNER_LIMIT');
  assert.equal(T.canCreateTeam('Time Ouro', { nameTaken: false, ownedCount: 0, memberTeamCount: 3 }).code, 'MEMBER_LIMIT');
  assert.deepEqual(T.canCreateTeam('Time Ouro', { nameTaken: false, ownedCount: 1, memberTeamCount: 2 }), { ok: true, name: 'Time Ouro', key: 'time ouro' });
});
const ctx = (o = {}) => ({ team: { status: 'active', ownerId: 'o' }, members: [{ userId: 'o', status: 'active' }], targetIsBot: false, targetTeamCount: 0, lastClosed: null, ...o });
t('convite à equipe: só o dono, sem repetir, com teto de membros (convites abertos contam) e de equipes por pessoa', () => {
  assert.equal(T.canInviteToTeam('x', 'u', ctx(), NOW).code, 'NOT_OWNER'); assert.equal(T.canInviteToTeam('o', 'o', ctx(), NOW).code, 'SELF'); assert.equal(T.canInviteToTeam('o', 'u', ctx({ targetIsBot: true }), NOW).code, 'BOT');
  assert.equal(T.canInviteToTeam('o', 'u', ctx({ team: { status: 'disbanded', ownerId: 'o' } }), NOW).code, 'TEAM_DISBANDED');
  assert.equal(T.canInviteToTeam('o', 'u', ctx({ members: [{ userId: 'o', status: 'active' }, { userId: 'u', status: 'active' }] }), NOW).code, 'ALREADY_MEMBER');
  assert.equal(T.canInviteToTeam('o', 'u', ctx({ members: [{ userId: 'o', status: 'active' }, { userId: 'u', status: 'invited' }] }), NOW).code, 'ALREADY_INVITED');
  const full = [{ userId: 'o', status: 'active' }, ...['a', 'b', 'c'].map(u => ({ userId: u, status: 'active' })), { userId: 'd', status: 'invited' }];
  assert.equal(T.canInviteToTeam('o', 'u', ctx({ members: full }), NOW).code, 'TEAM_FULL'); assert.equal(T.canInviteToTeam('o', 'u', ctx({ targetTeamCount: 3 }), NOW).code, 'TARGET_LIMIT');
  assert.ok(T.canInviteToTeam('o', 'u', ctx(), NOW).ok);
});
t('convite recusado/expirado só se repete após o intervalo; sair da equipe não bloqueia', () => {
  assert.equal(T.canInviteToTeam('o', 'u', ctx({ lastClosed: { status: 'declined', at: NOW - 2 * D } }), NOW).code, 'COOLDOWN');
  assert.ok(T.canInviteToTeam('o', 'u', ctx({ lastClosed: { status: 'declined', at: NOW - 8 * D } }), NOW).ok); assert.ok(T.canInviteToTeam('o', 'u', ctx({ lastClosed: { status: 'left', at: NOW - 1000 } }), NOW).ok);
});
t('saída: membro comum só sai; dono passa a liderança ao mais antigo; último a sair dissolve', () => {
  const m = [{ userId: 'o', joinedAt: 1 }, { userId: 'b', joinedAt: 5 }, { userId: 'a', joinedAt: 3 }];
  assert.deepEqual(T.afterTeamLeave({ ownerId: 'o' }, 'b', m), { action: 'leave' });
  assert.deepEqual(T.afterTeamLeave({ ownerId: 'o' }, 'o', m), { action: 'transfer', newOwnerId: 'a' });
  assert.deepEqual(T.afterTeamLeave({ ownerId: 'o' }, 'o', [{ userId: 'o', joinedAt: 1 }]), { action: 'disband' });
});
t('sessão: reserva os demais membros ativos; quem já está ocupado fica de fora; equipe maior que o modo é recusada', () => {
  const mode = { idealSize: 5 };
  assert.deepEqual(T.planSession({ activeMembers: ['s', 'a', 'b'], starterId: 's', mode }), { ok: true, capacity: 5, reserveIds: ['a', 'b'], skippedBusy: [] });
  assert.deepEqual(T.planSession({ activeMembers: ['s', 'a', 'b'], starterId: 's', mode, busyIds: ['b'] }), { ok: true, capacity: 5, reserveIds: ['a'], skippedBusy: ['b'] });
  assert.equal(T.planSession({ activeMembers: ['s', 'a', 'b'], starterId: 's', mode: { idealSize: 2 } }).code, 'TEAM_TOO_BIG');
  assert.equal(T.planSession({ activeMembers: ['s', 'a'], starterId: 'x', mode }).code, 'NOT_MEMBER'); assert.equal(T.planSession({ activeMembers: ['s', 'a'], starterId: 's', mode, busyIds: ['s'] }).code, 'STARTER_BUSY');
});
t('reservas: ativa, vencida e inexistente (reserva vencida nunca é reativada)', () => {
  assert.equal(T.reservationState({ status: 'reserved', reservedUntil: NOW + 1000 }, NOW), 'active'); assert.equal(T.reservationState({ status: 'reserved', reservedUntil: NOW - 1 }, NOW), 'expired');
  assert.equal(T.reservationState({ status: 'confirmed' }, NOW), 'none'); assert.equal(T.reservationState(null, NOW), 'none');
});
t('dupla é uma equipe com 2 membros ativos', () => { assert.equal(T.teamKind(2), 'Dupla'); assert.equal(T.teamKind(3), 'Equipe'); assert.equal(T.teamKind(1), 'Equipe'); });
t('vagas abertas descontam as reservas ativas; reserva vencida libera a vaga', () => {
  const g = (o = {}) => ({ capacity: 5, members: [{ userId: 's', status: 'confirmed' }, { userId: 'a', status: 'reserved', reservedUntil: NOW + 1000 }, { userId: 'b', status: 'reserved', reservedUntil: NOW + 1000 }], ...o });
  assert.equal(core.freeSlots(g(), NOW), 2); assert.equal(core.reservedCount(g(), NOW), 2);
  assert.equal(core.freeSlots(g(), NOW + 2000), 4);                                                  // reservas vencidas deixam de ocupar vaga
  assert.equal(core.decideJoin({ ...g({ capacity: 3 }), state: 'open' }, { userId: 'x' }, { eloRelevant: false }).code, 'NO_SLOT'); // 1 confirmado + 2 reservas = lotado para quem é de fora
  assert.equal(core.decideJoin({ ...g({ capacity: 3 }), state: 'open' }, { userId: 'x' }, { eloRelevant: false }, {}).code, 'NO_SLOT');
  assert.equal(core.decideJoin({ ...g({ capacity: 4 }), state: 'open' }, { userId: 'x' }, { eloRelevant: false }).action, 'confirm'); // 1 vaga realmente aberta
});
t('compromisso incompatível: quem aceitou a proposta mas ficou ocupado vira recusa (sem punição)', () => {
  assert.deepEqual(core.applyBusyToResponses({ a: 'accepted', b: 'accepted' }, ['a', 'b'], ['b']), { a: 'accepted', b: 'declined' });
  const r = core.resolveProposal({ userIds: ['a', 'b'], expiresAt: Date.now() + 1000 }, core.applyBusyToResponses({ a: 'accepted', b: 'accepted' }, ['a', 'b'], ['b']), Date.now());
  assert.equal(r.outcome, 'declined'); assert.deepEqual(r.requeue, ['a']); assert.equal(r.penalty, null);
});
t('todo código de erro tem mensagem', () => {
  for (const c of ['NAME_LENGTH', 'NAME_CHARS', 'NAME_TAKEN', 'OWNER_LIMIT', 'MEMBER_LIMIT', 'TEAM_DISBANDED', 'NOT_OWNER', 'SELF', 'BOT', 'ALREADY_MEMBER', 'ALREADY_INVITED', 'TEAM_FULL', 'TARGET_LIMIT', 'COOLDOWN', 'NOT_MEMBER', 'TEAM_TOO_BIG', 'STARTER_BUSY', 'SESSION_LIVE', 'NOT_FOUND']) assert.ok(T.TEAM_ERRORS[c], c);
});
console.log(`\n${n} testes passaram.`);
