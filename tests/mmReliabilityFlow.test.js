'use strict';
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const db = require('../utils/db');
const store = require('../utils/matchmaking/store');
const rstore = require('../utils/matchmaking/reliabilityStore');
const core = require('../utils/matchmaking/mmCore');
const central = require('../utils/matchmaking/central');
const rel = require('../utils/matchmaking/reliability');
const rflow = require('../utils/matchmaking/reliabilityFlow');
const prefsFlow = require('../utils/matchmaking/prefsFlow');
const schema = require('../utils/matchmaking/schema');
const backup = require('../utils/matchmaking/backupFormat');
const mm = require('../utils/matchmaking');
const { textOf, buttonsOf } = stubs;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
central.requestRefresh = async () => {};

// ---------- Pool falso (só registra SQL e devolve fixtures): valida a INSTRUMENTAÇÃO do store, não o PostgreSQL ----------
function fakePool(handlers, { failReliability = false } = {}) {
  const calls = [];
  const run = async (sql, params = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (failReliability && /INSERT INTO minako_mm_reliability/.test(sql)) throw new Error('falha simulada no registro');
    for (const [re, rows] of handlers) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows, rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query: run, release() {} };
  return { calls, pool: { connect: async () => client, query: run } };
}
const GROUP = (state, o = {}) => ({ id: 5, guild_id: 'g', mode_id: 'normal', organizer_id: 'org', state, capacity: 3, join_method: 'direct', allow_incomplete: false, elo_min: null, elo_max: null, required_roles: [], team_id: null, thread_id: null, announce_channel_id: null, announce_message_id: null, search_until: null, archive_at: null, ...o });
const MEMBERS = (...pairs) => pairs.map(([u, st]) => ({ user_id: u, status: st, role: null, reserved_until: null }));
const groupHandlers = (state, members, extra = []) => [
  [/FROM minako_mm_groups WHERE id=\$1 AND guild_id=\$2 FOR UPDATE/, [GROUP(state)]], [/FROM minako_mm_group_members WHERE group_id=\$1 ORDER BY joined_at/, members],
  [/SELECT user_id, status, role, reserved_until FROM minako_mm_group_members WHERE group_id=\$1$/, members], [/SELECT \* FROM minako_mm_groups WHERE id=\$1$/, [GROUP(state)]], ...extra];
const relInserts = (calls) => calls.filter(c => /INSERT INTO minako_mm_reliability/.test(c.sql)).map(c => ({ user: c.params[1], kind: c.params[2], group: c.params[3], match: c.params[4] }));

(async () => {
  const realGetPool = db.getPool;
  await t('sair de grupo ABERTO registra "saiu cedo"; de grupo FECHADO registra "saiu tarde"', async () => {
    for (const [state, kind] of [['open', 'left_early'], ['confirmed', 'left_late'], ['searching_replacement', 'left_late']]) {
      const f = fakePool(groupHandlers(state, MEMBERS(['org', 'confirmed'], ['u', 'confirmed'], ['x', 'confirmed']))); db.getPool = () => f.pool;
      await store.leaveGroup('g', '5', 'u', 300); assert.deepEqual(relInserts(f.calls), [{ user: 'u', kind, group: '5', match: null }], state);
    }
  });
  await t('quem só tinha um PEDIDO pendente e desiste não gera registro; silêncio e recusa também não', async () => {
    const f = fakePool(groupHandlers('open', MEMBERS(['org', 'confirmed'], ['u', 'pending']))); db.getPool = () => f.pool;
    await store.leaveGroup('g', '5', 'u', 300); assert.deepEqual(relInserts(f.calls), []);
  });
  await t('registrar conclusão registra "concluiu" para TODOS os participantes (com a partida)', async () => {
    const f = fakePool(groupHandlers('confirmed', MEMBERS(['org', 'confirmed'], ['a', 'confirmed'], ['b', 'confirmed']), [[/INSERT INTO minako_mm_matches/, [{ id: 9, guild_id: 'g', group_id: 5, mode_id: 'normal', organizer_id: 'org', status: 'pending_window', participant_ids: ['org', 'a', 'b'], responses: {}, window_ends_at: new Date() }]]])); db.getPool = () => f.pool;
    await store.registerMatch('g', '5', 'org', 86400, 259200);
    assert.deepEqual(relInserts(f.calls).map(r => [r.user, r.kind, r.match]), [['org', 'completed', 9], ['a', 'completed', 9], ['b', 'completed', 9]]);
  });
  await t('falha ao registrar NUNCA impede a ação principal (SAVEPOINT é desfeito)', async () => {
    const f = fakePool(groupHandlers('confirmed', MEMBERS(['org', 'confirmed'], ['u', 'confirmed'], ['x', 'confirmed'])), { failReliability: true }); db.getPool = () => f.pool;
    const orig = console.error; console.error = () => {}; const r = await store.leaveGroup('g', '5', 'u', 300); console.error = orig;
    assert.ok(r.group); assert.ok(f.calls.some(c => c.sql === 'ROLLBACK TO SAVEPOINT rel')); assert.ok(f.calls.some(c => /UPDATE minako_mm_group_members SET status='left'/.test(c.sql)));
  });
  await t('o registro é idempotente: um por (pessoa, grupo, tipo) — repetir não gera estatística ilimitada', async () => {
    const f = fakePool([]); db.getPool = () => f.pool;
    await store._internals.relRecord(f.pool.connect ? await f.pool.connect() : f.pool, 'g', 'u', 'joined', { groupId: 5 });
    assert.match(f.calls.find(c => /INSERT INTO minako_mm_reliability/.test(c.sql)).sql, /ON CONFLICT \(guild_id,user_id,group_id,kind\) WHERE group_id IS NOT NULL DO NOTHING/);
  });
  await t('revisão que REJEITA uma partida remove os registros "concluiu" dela', async () => {
    const f = fakePool([[/SELECT \* FROM minako_mm_matches WHERE id=\$1 AND guild_id=\$2 FOR UPDATE/, [{ id: 9, guild_id: 'g', group_id: 5, status: 'review', participant_ids: ['a'], responses: {}, window_ends_at: new Date(), organizer_id: 'o', mode_id: 'normal' }]],
      [/UPDATE minako_mm_matches SET status=\$2, reviewed_by/, [{ id: 9, guild_id: 'g', group_id: 5, status: 'resolved_rejected', participant_ids: ['a'], responses: {}, window_ends_at: new Date(), organizer_id: 'o', mode_id: 'normal' }]]]); db.getPool = () => f.pool;
    await store.resolveReview('g', '9', 'rev', 'reject'); const upd = f.calls.find(c => /UPDATE minako_mm_reliability SET status='removed'/.test(c.sql)); assert.ok(upd); assert.deepEqual(upd.params, ['9']);
    const f2 = fakePool([[/SELECT \* FROM minako_mm_matches WHERE id=\$1 AND guild_id=\$2 FOR UPDATE/, [{ id: 9, guild_id: 'g', group_id: 5, status: 'review', participant_ids: ['a'], responses: {}, window_ends_at: new Date(), organizer_id: 'o', mode_id: 'normal' }]], [/UPDATE minako_mm_matches SET status=\$2, reviewed_by/, [{ id: 9, guild_id: 'g', group_id: 5, status: 'validated', participant_ids: ['a'], responses: {}, window_ends_at: new Date(), organizer_id: 'o', mode_id: 'normal' }]]]); db.getPool = () => f2.pool;
    await store.resolveReview('g', '9', 'rev', 'valid'); assert.ok(!f2.calls.some(c => /UPDATE minako_mm_reliability/.test(c.sql)));
  });
  db.getPool = realGetPool;

  const P = () => ({ ...core.normalizePrefs({}), deliveryIssue: null }); store.getPrefs = async () => P(); store.recordDeliveryIssue = async () => {};
  const events = []; store.logEvent = async (g, type) => events.push(type);
  const cfg = () => ({ settings: core.normalizeSettings({ reviewChannelId: '1557770673819222137', reviewRoleId: '1244300508034760776' }), modes: core.DEFAULT_MODES, roleIds: {} }); store.getSettings = async () => cfg();
  const NOW = Date.now(); const R = (id, kind, o = {}) => ({ id, kind, groupId: '5', at: NOW - 3600_000, status: 'active', note: null, disputedAt: null, ...o });
  function world(opts = {}) {
    const w = { reviewPosts: [], dms: [] };
    w.client = { users: { fetch: async (id) => ({ send: async (p) => { w.dms.push([id, textOf(p)]); return { id: 'm', channelId: 'c' }; } }) },
      channels: { fetch: async (id) => (opts.noReview ? Promise.reject(new Error('x')) : { send: async (p) => { w.reviewPosts.push(p); } }) } };
    return w;
  }
  const mk = (w, id, o = {}) => ({ guildId: 'g', user: { id: 'u1' }, client: w.client, customId: id, values: [], memberPermissions: { has: () => false }, member: { roles: { cache: { has: () => false } } },
    update: async (p) => { w.shown = textOf(p); }, reply: async (p) => { w.shown = p.content ?? textOf(p); }, ...o });

  await t('Meu histórico: texto neutro, sem pontuação, só registros recentes; só os revisáveis aparecem no seletor', async () => {
    const ov = { summary: rel.summarize([R('1', 'joined'), R('2', 'left_late')], NOW), recent: [R('2', 'left_late'), R('1', 'joined', { disputedAt: 1 }), R('3', 'completed', { status: 'removed', note: 'Removido pela revisão.' })] };
    const payload = prefsFlow.render('hist', cfg(), P(), '', { overview: ov }); const txt = textOf(payload);
    assert.match(txt, /Só \*\*você\*\* e a \*\*administração\*\*/); assert.match(txt, /nenhum registro gera punição/); assert.match(txt, /Saiu depois de a equipe fechar/); assert.match(txt, /#3 · Partida concluída.*removido — Removido pela revisão/); assert.doesNotMatch(txt, /\d+\s*(pontos|\/\s*100)|score|n[ií]vel de confian|inconfi/i);   // diz que NÃO há pontuação, mas não mostra nenhuma
    const sel = payload.components[0].rows.flatMap(r => r.children || []).find(c => c.customId === 'minako-mm:prefs:hist-dispute'); assert.ok(sel); assert.deepEqual(sel.options.map(o => o.value), ['2']);
    assert.ok(!textOf(prefsFlow.render('hist', cfg(), P(), '', { overview: { summary: rel.summarize([], NOW), recent: [] } })).includes('Pedir revisão'));
  });
  await t('pedido de revisão: vai à equipe (canal e cargo configurados), o registro sai da conta e a pessoa é avisada', async () => {
    const w = world(); rstore.dispute = async () => R('2', 'left_late', { userId: 'u1', status: 'disputed' }); rstore.overview = async () => ({ summary: rel.summarize([], NOW), recent: [] });
    await prefsFlow.handleInteraction(mk(w, 'minako-mm:prefs:hist-dispute', { values: ['2'] }));
    assert.equal(w.reviewPosts.length, 1); const txt = textOf(w.reviewPosts[0]); assert.match(txt, /<@&1244300508034760776>/); assert.match(txt, /<@u1> pediu revisão do registro \*\*#2\*\*/); assert.match(txt, /Nada disso gera punição/);
    assert.deepEqual(buttonsOf(w.reviewPosts[0]).map(b => b.customId), ['minako-mm:rel:r:2', 'minako-mm:rel:k:2']); assert.deepEqual(w.reviewPosts[0].allowedMentions.roles, ['1244300508034760776']);
    assert.match(w.shown, /não entra na conta/);
  });
  await t('pedido de revisão: erros claros e, sem canal de revisão, o pedido fica salvo e a administração é alertada', async () => {
    const w = world(); rstore.overview = async () => ({ summary: rel.summarize([], NOW), recent: [] });
    for (const code of ['TOO_MANY', 'ALREADY_REVIEWED', 'NOT_YOURS']) { rstore.dispute = async () => { throw Object.assign(new Error(rel.DISPUTE_ERRORS[code]), { code }); }; await prefsFlow.handleInteraction(mk(w, 'minako-mm:prefs:hist-dispute', { values: ['2'] })); assert.match(w.shown, new RegExp(rel.DISPUTE_ERRORS[code].slice(0, 14))); }
    const w2 = world({ noReview: true }); events.length = 0; rstore.dispute = async () => R('2', 'left_late', { userId: 'u1', status: 'disputed' });
    await prefsFlow.handleInteraction(mk(w2, 'minako-mm:prefs:hist-dispute', { values: ['2'] })); assert.ok(events.includes('reliability.review_unrouted')); assert.match(w2.shown, /administração será alertada/);
  });
  await t('decisão da revisão: só quem revisa; remover avisa a pessoa com agradecimento; manter não pune e não vira padrão', async () => {
    const w = world(); await mm.handleInteraction(mk(w, 'minako-mm:rel:r:2')); assert.match(w.shown, /Apenas a equipe de revisão/);
    const reviewer = (id) => mk(w, id, { user: { id: 'rev' }, member: { roles: { cache: { has: (r) => r === '1244300508034760776' } } } });
    rstore.resolve = async (g, id, by, dec) => R(id, 'left_late', { userId: 'u1', status: dec === 'remove' ? 'removed' : 'active' });
    await mm.handleInteraction(reviewer('minako-mm:rel:r:2')); assert.match(w.shown, /Removido/); assert.match(w.dms.at(-1)[1], /estava incorreto, e ele foi \*\*removido\*\*/);
    await mm.handleInteraction(reviewer('minako-mm:rel:k:2')); assert.match(w.shown, /Mantido/); assert.match(w.dms.at(-1)[1], /não gera punição/); assert.match(w.dms.at(-1)[1], /isolado nunca é tratado como padrão/);
  });
  await t('revisão já resolvida não é refeita', async () => {
    const w = world(); rstore.resolve = async () => { throw Object.assign(new Error(rel.DISPUTE_ERRORS.BAD_STATE), { code: 'BAD_STATE' }); };
    await mm.handleInteraction(mk(w, 'minako-mm:rel:k:2', { member: { roles: { cache: { has: () => true } } } })); assert.match(w.shown, /não está mais aguardando revisão/);
  });
  await t('visão administrativa identifica a pessoa e é marcada como restrita; usuário comum não a recebe', () => {
    const ov = { summary: rel.summarize([], NOW), recent: [R('1', 'joined')] };
    assert.match(rflow.overviewText(ov, { admin: true, userId: 'x' }), /Histórico de <@x>\*\* \(visível só à administração\)/); assert.match(rflow.overviewText(ov), /Só \*\*você\*\*/); assert.doesNotMatch(rflow.overviewText(ov), /<@x>/);
  });
  await t('comandos de manutenção: histórico exige manutenção; remover registro exige revisão; ambos explicam sem punir', async () => {
    const cmd = require('../commands/minako-matchmaking'); rstore.overview = async () => ({ summary: rel.summarize([], NOW), recent: [R('1', 'joined')] }); let removed = null; rstore.resolve = async (g, id, by, d, note) => { removed = [id, d, note]; return R(id, 'left_late', { status: 'removed' }); };
    const run = (sub, perms, opts) => { const o = { replied: null }; return cmd.execute({ guildId: 'g', user: { id: 'adm' }, client: {}, memberPermissions: { has: (p) => perms.includes(p) }, member: { roles: { cache: { has: () => false } } },
      options: { getSubcommand: () => sub, getUser: () => ({ id: 'alvo' }), getInteger: () => 7, getString: () => 'registro duplicado' }, reply: async (p) => { o.replied = p; } }).then(() => o.replied); };
    assert.match((await run('historico', [])).content, /🚫/); assert.match((await run('historico', [8n])).content, /Histórico de <@alvo>/);
    assert.match((await run('registro-remover', [])).content, /🚫/); const ok = await run('registro-remover', [8n]); assert.match(ok.content, /removido/); assert.deepEqual(removed, ['7', 'remove', 'registro duplicado']);
  });
  await t('retenção: a limpeza roda no máximo uma vez por hora', async () => {
    let purges = 0; rstore.purge = async () => { purges++; return 3; }; rflow._resetPurge();
    const T0 = 10_000_000_000; await rflow.sweeps(T0); await rflow.sweeps(T0 + 600_000); assert.equal(purges, 1); await rflow.sweeps(T0 + 3_700_000); assert.equal(purges, 2);
  });
  await t('migração 5 e backup: tabela com índice único idempotente, reversível; backups antigos seguem válidos', () => {
    const m5 = schema.MIGRATIONS[4]; assert.equal(m5.version, 5); assert.match(m5.up, /CREATE TABLE IF NOT EXISTS minako_mm_reliability/); assert.match(m5.up, /minako_mm_reliability_once_uq[^;]*WHERE group_id IS NOT NULL/); assert.match(m5.up, /status IN \('active','disputed','removed'\)/); assert.match(m5.down, /DROP TABLE IF EXISTS minako_mm_reliability/);
    const optional = ['minako_mm_prefs', 'minako_mm_favorites', 'minako_mm_partnerships', 'minako_mm_notice_log', 'minako_mm_teams', 'minako_mm_team_members', 'minako_mm_reliability'];
    const base = Object.fromEntries(backup.INSERT_ORDER.filter(x => !optional.includes(x)).map(x => [x, []])); assert.ok(backup.validateBackup({ schema: backup.FORMAT, guildId: 'g', tables: base }, 'g'));
    const plan = backup.buildRestorePlan({ schema: backup.FORMAT, guildId: 'g', tables: { ...base, minako_mm_reliability: [{ id: 1, guild_id: 'g', user_id: 'u', kind: 'joined', group_id: 5 }] } }, 'g');
    assert.ok(plan.steps.some(s => s.sql.startsWith('DELETE FROM minako_mm_reliability'))); assert.ok(plan.steps.some(s => s.sql.startsWith('INSERT INTO minako_mm_reliability'))); assert.ok(plan.steps.some(s => s.sql.includes("pg_get_serial_sequence('minako_mm_reliability'")));
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
