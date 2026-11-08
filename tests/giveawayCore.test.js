'use strict';
const assert = require('node:assert/strict');
const core = require('../utils/giveawayCore');

// --- duração / datas ---
assert.equal(core.parseDuration('90min'), 90);
assert.equal(core.parseDuration('2h'), 120);
assert.equal(core.parseDuration('1d 12h'), 36 * 60);
assert.equal(core.parseDuration('1h30m'), 90);
assert.equal(core.parseDuration('abc'), null);
assert.equal(core.parseDuration('0m'), null);
assert.equal(core.parseDuration('999d'), null);
const d = core.parseDateTime('25/12/2026 20:00', 'America/Sao_Paulo');
assert.equal(d.toISOString(), '2026-12-25T23:00:00.000Z');
assert.equal(core.formatDateTime(d, 'America/Sao_Paulo'), '25/12/2026 20:00');
assert.equal(core.parseDateTime('31/02/2026 10:00'), null);
assert.equal(core.parseDateTime('25/12/2026 25:00'), null);
assert.deepEqual(core.parseColor('#f5a9b8'), { ok: true, value: 0xf5a9b8 });
assert.deepEqual(core.parseColor(''), { ok: true, value: null });
assert.equal(core.parseColor('zzz').ok, false);

// --- placeholders (passada única, sem reinjeção) ---
const ctx = { hostId: '111111111111111111', name: 'Sorteio {user1} @everyone', winnerIds: ['222222222222222222', '333333333333333333'], participants: 7, min: 2, max: 0, winnerCount: 2, channelId: '444444444444444444' };
assert.equal(core.renderPlaceholders('{host}', ctx), '<@111111111111111111>');
assert.equal(core.renderPlaceholders('{user2}|{user3}', ctx), '<@333333333333333333>|—');
assert.equal(core.renderPlaceholders('{users}', ctx), '<@222222222222222222>, <@333333333333333333>');
assert.equal(core.renderPlaceholders('{max}/{participants}', ctx), '∞/7');
assert.equal(core.renderPlaceholders('{naoexiste}', ctx), '{naoexiste}');
const n = core.renderPlaceholders('{giveaway}', ctx);
assert.ok(n.includes('{user1}'), 'valor inserido não é reprocessado');
assert.ok(!/@everyone/i.test(n), '@everyone neutralizado');
assert.equal(core.renderPlaceholders('{user1}', { ...ctx, winnerIds: [], preview: true }), '@Ganhador1');

// --- normalização / segurança de mídia ---
assert.equal(core.safeUrl('http://x.com/a.png'), null);
assert.equal(core.safeUrl('javascript:alert(1)'), null);
assert.ok(core.safeUrl('https://x.com/a.png'));
const cfg = core.normalizeConfig({ name: '  Teste  ', allowedRoleIds: ['123', '111111111111111111'], message: { accentColor: null, blocks: [{ type: 'gallery', urls: ['http://a.com/x', 'https://a.com/x'] }, { type: 'bogus' }, { type: 'text', content: '   ' }] } });
assert.equal(cfg.name, 'Teste');
assert.deepEqual(cfg.allowedRoleIds, ['111111111111111111']);
assert.equal(cfg.message.accentColor, null);
assert.equal(cfg.message.blocks.length, 1);
assert.equal(cfg.message.blocks[0].urls.length, 1);
assert.equal(core.defaultConfig().pin, false, 'fixar: padrão não');

// --- validação ---
const ok = core.normalizeConfig({ ...core.defaultConfig(), name: 'A', channelId: '555555555555555555' });
assert.deepEqual(core.validateConfig(ok), []);
assert.ok(core.validateConfig({ ...ok, name: '' }).length);
assert.ok(core.validateConfig({ ...ok, minParticipants: 5, maxParticipants: 3 }).length);
assert.ok(core.validateConfig({ ...ok, allowedRoleIds: ['111111111111111111'], blockedRoleIds: ['111111111111111111'] }).length);
assert.ok(core.validateConfig({ ...ok, cooldown: { giveaways: 2, days: 2 } }).length);
assert.ok(core.validateConfig({ ...ok, channelId: null }).length);
assert.ok(core.validateConfig({ ...ok, schedule: { enabled: true, startsAt: new Date(Date.now() - 1000).toISOString() } }).length);

// --- elegibilidade ---
const base = { config: ok, status: 'active', count: 0, alreadyJoined: false, memberRoleIds: [], cooldowns: [], concludedCount: 10 };
assert.equal(core.checkJoin(base).ok, true);
assert.equal(core.checkJoin({ ...base, status: 'drawn' }).reason, 'closed');
assert.equal(core.checkJoin({ ...base, endsAt: new Date(Date.now() - 1000) }).reason, 'closed');
assert.equal(core.checkJoin({ ...base, alreadyJoined: true }).reason, 'already');
assert.equal(core.checkJoin({ ...base, config: { ...ok, maxParticipants: 2 }, count: 2 }).reason, 'full');
assert.equal(core.checkJoin({ ...base, config: { ...ok, blockedRoleIds: ['r1'] }, memberRoleIds: ['r1'] }).reason, 'blocked_role');
assert.equal(core.checkJoin({ ...base, config: { ...ok, allowedRoleIds: ['r1'] }, memberRoleIds: ['r2'] }).reason, 'not_allowed');
assert.equal(core.checkJoin({ ...base, config: { ...ok, allowedRoleIds: ['r1'] }, memberRoleIds: ['r1'] }).ok, true);
// afastamento por sorteios: venceu o sorteio 8, afastado por 3 → sorteios 9,10 já passaram? count=10 → passaram 2, falta 1
let cd = core.checkJoin({ ...base, cooldowns: [{ mode: 'giveaways', amount: 3, seqAtWin: 8 }] });
assert.equal(cd.reason, 'cooldown'); assert.equal(cd.giveaways, 1);
assert.equal(core.checkJoin({ ...base, cooldowns: [{ mode: 'giveaways', amount: 2, seqAtWin: 8 }] }).ok, true);
// afastamento por dias
const until = new Date(Date.now() + 2.5 * 86400000);
cd = core.checkJoin({ ...base, cooldowns: [{ mode: 'days', amount: 3, until, seqAtWin: 0 }] });
assert.equal(cd.reason, 'cooldown'); assert.equal(cd.days, 3);
assert.equal(core.checkJoin({ ...base, cooldowns: [{ mode: 'days', amount: 3, until: new Date(Date.now() - 1000), seqAtWin: 0 }] }).ok, true);

// --- membros, escopo e regras globais ---
const U1 = '111111111111111111'; const U2 = '222222222222222222'; const RL = '333333333333333333'; const RL2 = '444444444444444444';
const ctxJoin = { ...base, userId: U1, memberRoleIds: [] };
assert.equal(core.checkJoin({ ...ctxJoin, config: { ...ok, blockedUserIds: [U1] } }).reason, 'blocked_user');
assert.equal(core.checkJoin({ ...ctxJoin, config: { ...ok, allowedUserIds: [U2] } }).reason, 'not_allowed');
assert.equal(core.checkJoin({ ...ctxJoin, config: { ...ok, allowedUserIds: [U1] } }).ok, true);
// cargos E membros liberados: vale um OU outro
assert.equal(core.checkJoin({ ...ctxJoin, memberRoleIds: [RL], config: { ...ok, allowedRoleIds: [RL], allowedUserIds: [U2] } }).ok, true);
assert.equal(core.checkJoin({ ...ctxJoin, config: { ...ok, allowedRoleIds: [RL], allowedUserIds: [U1] } }).ok, true);
// bloqueio vence permissão (mesmo membro liberado por cargo)
assert.equal(core.checkJoin({ ...ctxJoin, memberRoleIds: [RL], config: { ...ok, allowedRoleIds: [RL], blockedUserIds: [U1] } }).reason, 'blocked_user');
// regras globais valem para qualquer sorteio e somam-se às locais
const gl = core.normalizeRules({ blockedRoleIds: [RL], allowedUserIds: [], blockedUserIds: [U2] });
assert.equal(core.checkJoin({ ...ctxJoin, globalRules: gl, memberRoleIds: [RL] }).reason, 'blocked_role');
assert.equal(core.checkJoin({ ...ctxJoin, globalRules: gl, userId: U2 }).reason, 'blocked_user');
assert.equal(core.checkJoin({ ...ctxJoin, globalRules: gl }).ok, true);
const glAllow = core.normalizeRules({ allowedRoleIds: [RL2] });
assert.equal(core.checkJoin({ ...ctxJoin, globalRules: glAllow, memberRoleIds: [RL] }).reason, 'not_allowed', 'global exige passar também');
assert.equal(core.checkJoin({ ...ctxJoin, globalRules: glAllow, memberRoleIds: [RL2] }).ok, true);
assert.equal(core.checkJoin({ ...ctxJoin, globalRules: null }).ok, true);
// merge de regras globais: união, sem duplicar, com limite
let mr = core.mergeRules({ blockedRoleIds: [RL] }, { blockedRoleIds: [RL, RL2], blockedUserIds: [U1] });
assert.deepEqual(mr.rules.blockedRoleIds, [RL, RL2]); assert.deepEqual(mr.rules.blockedUserIds, [U1]); assert.equal(mr.truncated, false);
const many = Array.from({ length: 30 }, (_, n) => `5000000000000000${String(n).padStart(2, '0')}`);
mr = core.mergeRules({}, { allowedUserIds: many.slice(0, 25) }); mr = core.mergeRules(mr.rules, { allowedUserIds: many.slice(25) });
assert.equal(mr.rules.allowedUserIds.length, 25); assert.equal(mr.truncated, true);
// config: normalização e validação das novas opções
const c2 = core.normalizeConfig({ ...ok, rulesScope: 'xyz', allowedUserIds: [U1, 'lixo'], winnerRoles: { grantRoleIds: [RL, RL, 'x'], grantDays: -5, removeRoleIds: [RL2], removeDays: 99999 } });
assert.equal(c2.rulesScope, 'local'); assert.deepEqual(c2.allowedUserIds, [U1]);
assert.deepEqual(c2.winnerRoles, { grantRoleIds: [RL], grantDays: 0, removeRoleIds: [RL2], removeDays: 3650 });
assert.equal(core.normalizeConfig({ ...ok, rulesScope: 'global' }).rulesScope, 'global');
assert.ok(core.validateConfig({ ...ok, allowedUserIds: [U1], blockedUserIds: [U1] }).length);
assert.ok(core.validateConfig({ ...ok, winnerRoles: { grantRoleIds: [RL], grantDays: 0, removeRoleIds: [RL], removeDays: 0 } }).length);
assert.deepEqual(core.defaultConfig().winnerRoles, { grantRoleIds: [], grantDays: 0, removeRoleIds: [], removeDays: 0 });

// --- sorteio ---
const pool = Array.from({ length: 50 }, (_, i) => `u${i}`);
const w = core.pickWinners([...pool, 'u1', 'u2'], 5);
assert.equal(w.length, 5); assert.equal(new Set(w).size, 5);
assert.equal(core.pickWinners(['a'], 3).length, 1);
assert.equal(core.pickWinners([], 3).length, 0);
// uniformidade grosseira
const hits = {}; for (let k = 0; k < 6000; k += 1) { const [x] = core.pickWinners(['a', 'b', 'c'], 1); hits[x] = (hits[x] || 0) + 1; }
for (const v of Object.values(hits)) assert.ok(v > 1700 && v < 2300, `distribuição ${JSON.stringify(hits)}`);

// --- componentes V2 ---
assert.ok(core.countComponents(core.defaultBlocks()) <= core.LIMITS.maxComponents);
console.log('giveawayCore.test.js: todos os testes passaram.');
