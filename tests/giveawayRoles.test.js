'use strict';
// Cargos dos ganhadores: conferir/remover (permanente ou temporário), desfazer no ressorteio e devolver os
// temporários. Usa discord.js/pg falsos e um "banco" em memória no lugar das funções do store.
const assert = require('node:assert/strict');
const Module = require('node:module');

const noop = class { constructor() { return new Proxy(this, { get: (t, k) => (k === 'toJSON' ? () => ({}) : typeof k === 'symbol' ? undefined : () => t) }); } };
const stub = new Proxy({
  PermissionFlagsBits: { Administrator: 1n, ManageRoles: 2n },
  ChannelType: {}, MessageFlags: { Ephemeral: 64, IsComponentsV2: 32768 }, ButtonStyle: {}, SeparatorSpacingSize: {}, TextInputStyle: {},
}, { get: (t, k) => (k in t ? t[k] : noop) });
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Pool: class Pool { on() {} } };
  if (request === 'discord.js') return stub;
  return orig.call(this, request, parent, isMain);
};
const store = require('../utils/giveawayStore');
const core = require('../utils/giveawayCore');
const actions = require('../utils/giveawayActions');
Module._load = orig;

// ---- Discord falso ----
const GUILD = '900000000000000001';
const R = { grant: '100000000000000001', temp: '100000000000000002', drop: '100000000000000003', stranger: '100000000000000004', high: '100000000000000005' };
const U = { a: '200000000000000001', b: '200000000000000002', gone: '200000000000000003' };
const makeMember = (id, roleIds) => {
  const set = new Set(roleIds);
  return { id, roles: { cache: { has: (r) => set.has(r), keys: () => set.keys() }, add: async (r) => { set.add(r); }, remove: async (r) => { set.delete(r); } }, _set: set };
};
const members = { [U.a]: makeMember(U.a, [R.drop]), [U.b]: makeMember(U.b, [R.grant]) };
const roleObj = (id, extra = {}) => ({ id, name: `cargo-${id.slice(-1)}`, editable: true, managed: false, ...extra });
const roles = new Map([[R.grant, roleObj(R.grant)], [R.temp, roleObj(R.temp)], [R.drop, roleObj(R.drop)], [R.stranger, roleObj(R.stranger)], [R.high, roleObj(R.high, { editable: false })]]);
let canManage = true;
const guild = {
  id: GUILD, roles: { cache: roles },
  members: { me: { permissions: { has: () => canManage } }, fetch: async (id) => { if (!members[id]) { const e = new Error('Unknown Member'); e.code = 10007; throw e; } return members[id]; } },
};
const client = { guilds: { cache: { get: () => guild }, fetch: async () => guild }, channels: { fetch: async () => null } };

// ---- "banco" em memória ----
let ops = []; let seq = 1; let allowed = [R.grant, R.temp, R.drop, R.high];
store.getRewardRoles = async () => allowed;
store.insertRoleOp = async (o) => {
  if (ops.some((x) => x.giveawayId === o.giveawayId && x.userId === o.userId && x.roleId === o.roleId && x.action === o.action)) return null;
  const op = { id: seq++, status: 'applied', attempts: 0, ...o }; ops.push(op); return op.id;
};
store.deleteRoleOp = async (id) => { ops = ops.filter((o) => o.id !== id); };
store.listAppliedRoleOps = async (gid, users) => ops.filter((o) => o.giveawayId === gid && users.includes(o.userId) && o.status === 'applied');
store.markRoleOp = async (id, status) => { ops.find((o) => o.id === id).status = status; };
store.claimDueRoleOps = async () => ops.filter((o) => o.status === 'applied' && o.revertAt && o.revertAt <= new Date()).map((o) => { o.status = 'reverting'; return o; });
store.retryRoleOp = async (id) => { ops.find((o) => o.id === id).status = 'applied'; return false; };

const g = (wr) => ({ id: 7, guildId: GUILD, name: 'Sorteio "teste"', hostId: '300000000000000001', channelId: '1', config: core.normalizeConfig({ name: 'X', channelId: '1', winnerRoles: wr }) });
const has = (u, r) => members[u]._set.has(r);

(async () => {
  // 1) conferir (temporário 7d) + remover (permanente)
  const game = g({ grantRoleIds: [R.temp], grantDays: 7, removeRoleIds: [R.drop], removeDays: 0 });
  let res = await actions.applyWinnerRoles(client, game, [U.a, U.b]);
  assert.deepEqual(res.problems, []);
  assert.ok(has(U.a, R.temp) && has(U.b, R.temp));
  assert.ok(!has(U.a, R.drop));                                   // a tinha o cargo → removido
  assert.equal(ops.filter((o) => o.userId === U.b && o.action === 'remove').length, 0, 'b não tinha o cargo: nada a registrar');
  const temp = ops.find((o) => o.userId === U.a && o.action === 'add');
  assert.ok(temp.revertAt && temp.revertAt > new Date(Date.now() + 6 * 86400000), 'temporário tem prazo');
  assert.equal(ops.find((o) => o.action === 'remove').revertAt, null, 'permanente não tem prazo');

  // 2) idempotência: aplicar de novo não duplica nem mexe
  const before = ops.length;
  await actions.applyWinnerRoles(client, game, [U.a, U.b]);
  assert.equal(ops.length, before);

  // 3) quem já tem o cargo conferido não gera operação (e nunca será "desfeito")
  const g2 = g({ grantRoleIds: [R.grant], grantDays: 0 });
  await actions.applyWinnerRoles(client, { ...g2, id: 8 }, [U.b]);
  assert.equal(ops.filter((o) => o.giveawayId === 8).length, 0);
  await actions.revertWinnerRoles(client, { ...g2, id: 8 }, [U.b]);
  assert.ok(has(U.b, R.grant), 'cargo que a pessoa já tinha antes continua com ela');

  // 4) ressorteio: desfaz para o substituído (A) — devolve o removido e tira o conferido
  const undone = await actions.revertWinnerRoles(client, game, [U.a]);
  assert.deepEqual(undone.problems, []);
  assert.ok(!has(U.a, R.temp) && has(U.a, R.drop));
  assert.ok(ops.filter((o) => o.userId === U.a).every((o) => o.status === 'reverted'));
  assert.ok(has(U.b, R.temp), 'quem continua ganhador mantém o cargo');

  // 5) devolução automática do temporário vencido
  ops.find((o) => o.userId === U.b && o.action === 'add').revertAt = new Date(Date.now() - 1000);
  await actions.processDueRoleOps(client);
  assert.ok(!has(U.b, R.temp));
  assert.equal(ops.find((o) => o.userId === U.b && o.action === 'add').status, 'reverted');

  // 6) cargo fora da lista liberada pelo admin / acima do bot / sem permissão: nada é alterado e há aviso
  const g3 = { ...g({ grantRoleIds: [R.stranger, R.high] }), id: 9 };
  res = await actions.applyWinnerRoles(client, g3, [U.b]);
  assert.equal(res.problems.length, 2);
  assert.ok(!has(U.b, R.stranger) && !has(U.b, R.high));
  canManage = false;
  res = await actions.applyWinnerRoles(client, { ...g({ grantRoleIds: [R.temp] }), id: 10 }, [U.b]);
  assert.match(res.problems[0], /Gerenciar Cargos/);
  assert.ok(!has(U.b, R.temp));
  canManage = true;

  // 7) ganhador que saiu do servidor: aviso, sem erro
  res = await actions.applyWinnerRoles(client, { ...g({ grantRoleIds: [R.temp] }), id: 11 }, [U.gone]);
  assert.equal(res.problems.length, 1);

  // 8) checagem na criação do sorteio
  assert.deepEqual(await actions.checkRewardRoles(guild, core.normalizeWinnerRoles({ grantRoleIds: [R.temp] })), []);
  assert.ok((await actions.checkRewardRoles(guild, core.normalizeWinnerRoles({ grantRoleIds: [R.stranger] }))).length > 0);
  assert.ok((await actions.checkRewardRoles(guild, core.normalizeWinnerRoles({ removeRoleIds: [R.high] }))).length > 0);
  console.log('giveawayRoles.test.js: OK');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit(process.exitCode || 0));
