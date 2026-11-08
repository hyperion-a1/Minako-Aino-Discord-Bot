'use strict';
// Release 1.1: preferências/destino de notificações, avisos operacionais, reconciliação, composição por vaga, migração 2.
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const store = require('../utils/matchmaking/store');
const core = require('../utils/matchmaking/mmCore');
const central = require('../utils/matchmaking/central');
const notify = require('../utils/matchmaking/notify');
const prefsFlow = require('../utils/matchmaking/prefsFlow');
const engine = require('../utils/matchmaking/engine');
const gf = require('../utils/matchmaking/groupFlow');
const playFlow = require('../utils/matchmaking/playFlow');
const parse = require('../utils/matchmaking/configParse');
const panel = require('../utils/matchmaking/configPanel');
const schema = require('../utils/matchmaking/schema');
const backup = require('../utils/matchmaking/backupFormat');
const { textOf, buttonsOf } = stubs;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
central.requestRefresh = async () => {};
require('../utils/matchmaking/socialStore').sweepExpiredInvites = async () => [];
const P = (notif = {}, extra = {}) => ({ ...core.normalizePrefs({ notif }), deliveryIssue: null, ...extra });
let prefsDb = {}; store.getPrefs = async (g, u) => prefsDb[u] || P();
const issues = []; store.recordDeliveryIssue = async (g, u, c, via) => issues.push([u, c, via]); const events = []; store.logEvent = async (g, type, p) => events.push(type);
function world({ dmFail = [] } = {}) {
  const w = { dms: [], thread: [], channelFetches: 0 };
  w.client = {
    users: { fetch: async (id) => ({ send: async (p) => { if (dmFail.includes(id)) throw new Error('Cannot send messages to this user'); w.dms.push([id, textOf(p), p]); return { id: 'm', channelId: 'c' }; } }) },
    channels: { fetch: async (id) => { w.channelFetches++; return { send: async (p) => { w.thread.push(textOf(p)); return { id: 't' }; } }; } },
  };
  return w;
}
const pay = (text) => ({ components: [{ texts: [{ content: text }] }] });

(async () => {
  await t('preferências: padrões, valores inválidos ignorados e destino "tópico" só onde faz sentido', () => {
    assert.deepEqual(core.normalizePrefs({}).notif, { actions: 'dm', groups: 'dm', expiry: 'off', partners: 'off', favorites: 'off', community: 'off', digest: 'off' });
    assert.deepEqual(core.normalizePrefs({ notif: { actions: 'thread', groups: 'thread', expiry: 'xx' } }).notif, { actions: 'dm', groups: 'thread', expiry: 'off', partners: 'off', favorites: 'off', community: 'off', digest: 'off' });
    assert.deepEqual(core.normalizePrefs({ play: { mode: 'normal', roles: ['A', 'A', 'B'], voice: 'z' } }).play, { mode: 'normal', roles: ['A', 'B'], voice: 'a' });
  });
  await t('notify: DM por padrão; "não avisar" respeitado', async () => {
    const w = world(); prefsDb = { u1: P(), u2: P({ groups: 'off' }) };
    assert.equal((await notify.send(w.client, 'g', 'u1', 'groups', pay('oi'))).via, 'dm');
    assert.deepEqual(await notify.send(w.client, 'g', 'u2', 'groups', pay('oi')), { sent: false, reason: 'off' }); assert.equal(w.dms.length, 1);
  });
  await t('notify: DM fechada registra o problema e NÃO usa outro canal', async () => {
    const w = world({ dmFail: ['u1'] }); prefsDb = { u1: P() }; issues.length = 0; events.length = 0;
    const r = await notify.send(w.client, 'g', 'u1', 'actions', pay('x'), { threadId: 'th1' });
    assert.deepEqual(r, { sent: false, reason: 'failed' }); assert.deepEqual(issues, [['u1', 'actions', 'dm']]); assert.ok(events.includes('notify.delivery_failed'));
    assert.equal(w.thread.length, 0); assert.equal(w.channelFetches, 0);
  });
  await t('notify: destino "tópico" só usa o tópico; sem tópico não desvia para DM', async () => {
    const w = world(); prefsDb = { u1: P({ groups: 'thread' }) };
    assert.equal((await notify.send(w.client, 'g', 'u1', 'groups', pay('a'), { threadId: 'th1' })).via, 'thread'); assert.equal(w.thread.length, 1); assert.equal(w.dms.length, 0);
    assert.deepEqual(await notify.send(w.client, 'g', 'u1', 'groups', pay('b')), { sent: false, reason: 'no_thread' }); assert.equal(w.dms.length, 0);
  });
  await t('Minhas preferências: só seções implementadas e salvar não toca na disponibilidade', async () => {
    const cfg = { settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES };
    assert.deepEqual(prefsFlow.SECTIONS.map(s => s[0]), ['play', 'avail', 'notif', 'engage', 'fav', 'partners', 'hist']);
    let touched = false; store.changeAvailability = async () => { touched = true; }; store.getSettings = async () => cfg;
    const saved = []; store.savePrefs = async (g, u, patch) => { saved.push(patch); return P(); };
    let shown = ''; const mk = (id, values) => ({ guildId: 'g', user: { id: 'u1' }, customId: id, values, update: async (p) => { shown = textOf(p); }, reply: async (p) => { shown = textOf(p); } });
    prefsDb = { u1: P() };
    await prefsFlow.handleInteraction(mk('minako-mm:prefs:notif:groups', ['thread'])); await prefsFlow.handleInteraction(mk('minako-mm:prefs:expiry', ['dm']));
    assert.deepEqual(saved, [{ notif: { groups: 'thread' } }, { notif: { expiry: 'dm' } }]); assert.equal(touched, false); assert.match(shown, /Salvo/);
    await prefsFlow.handleInteraction(mk('minako-mm:prefs:sec', ['notif'])); assert.match(shown, /Notificações/); assert.match(shown, /não encerra sua busca/);
  });
  await t('Minhas preferências: problema de entrega é mostrado com orientação; limpar funciona', async () => {
    const cfg = { settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES }; store.getSettings = async () => cfg;
    prefsDb = { u1: P({}, { deliveryIssue: { category: 'actions', via: 'dm', at: 1_800_000_000_000 } }) };
    let shown = ''; let cleared = false; store.clearDeliveryIssue = async () => { cleared = true; prefsDb.u1 = P(); };
    const mk = (id) => ({ guildId: 'g', user: { id: 'u1' }, customId: id, values: ['notif'], update: async (p) => { shown = textOf(p); } });
    await prefsFlow.handleInteraction(mk('minako-mm:prefs:sec')); assert.match(shown, /Não consegui te avisar por \*\*mensagem privada\*\*/); assert.match(shown, /nunca troco de canal/);
    await prefsFlow.handleInteraction(mk('minako-mm:prefs:clear-issue')); assert.ok(cleared); assert.doesNotMatch(shown, /Não consegui te avisar/);
  });
  await t('"Quero jogar agora" usa as preferências de jogo salvas como ponto de partida', async () => {
    store.getSettings = async () => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES }); store.pendingProposalForUser = async () => null; store.getAvailability = async () => null;
    store.getPrefs = async () => P({}, { play: { mode: 'casual', roles: ['Apoio'], voice: 'n' } });
    const db = require('../utils/db'); db.loadMatchProfile = async () => ({ current_rank: 'ouro', routes: ['Selva'] });
    let shown = ''; await playFlow.handleInteraction({ guildId: 'g', user: { id: 'u1' }, customId: 'minako-mm:play', reply: async (p) => { shown = textOf(p); } });
    assert.match(shown, /Modo:\*\* Casual/); assert.match(shown, /Funções:\*\* Apoio/); assert.match(shown, /Voz:\*\* Sem voz/); store.getPrefs = async (g, u) => prefsDb[u] || P();
  });
  await t('aviso de expiração: enviado só se habilitado, uma vez, com botão de renovar que carrega o servidor', async () => {
    const w = world(); prefsDb = { u1: P({ expiry: 'dm' }), u2: P({ expiry: 'off' }) };
    store.sweepExpiredProposals = async () => []; store.sweepExpiredAvailability = async () => [];
    store.claimExpiryWarnings = async () => [{ guildId: 'g', userId: 'u1', expiresAt: Date.now() + 600_000 }, { guildId: 'g', userId: 'u2', expiresAt: Date.now() + 600_000 }];
    await engine.handleSweeps(w.client); assert.equal(w.dms.length, 1); assert.equal(w.dms[0][0], 'u1'); assert.match(w.dms[0][1], /expira/);
    assert.deepEqual(buttonsOf(w.dms[0][2]).map(b => b.customId), ['minako-mm:av:renew:g']);
  });
  await t('renovar pelo botão da DM funciona (sem guildId na interação)', async () => {
    const calls = []; store.getSettings = async () => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES });
    store.changeAvailability = async (g, u, a, ttl) => { calls.push([g, u, a, ttl]); return true; }; store.getAvailability = async () => ({ modeId: 'normal', status: 'active', expiresAt: Date.now() + 7200_000 });
    let shown = ''; const handled = await playFlow.handleInteraction({ guildId: null, user: { id: 'u1' }, client: {}, customId: 'minako-mm:av:renew:g', update: async (p) => { shown = textOf(p); }, reply: async () => { throw new Error('não deveria recusar'); } });
    assert.equal(handled, true); assert.deepEqual(calls, [['g', 'u1', 'renew', 7200]]); assert.match(shown, /renovada/);
  });
  const G = (o = {}) => ({ id: '5', guildId: 'g', modeId: 'normal', organizerId: 'org', state: 'open', capacity: 3, confirmed: 2, free: 1, joinMethod: 'direct', allowIncomplete: false, members: [{ userId: 'org' }, { userId: 'a' }], pending: [], requiredRoles: [], threadId: null, ...o });
  const interG = (w, id, user = 'u') => ({ guildId: 'g', user: { id: user }, client: w.client, customId: id, isMessageComponent: () => true, message: { flags: { has: () => true } }, update: async () => {}, reply: async () => {}, memberPermissions: { has: () => false } });
  store.getSettings = async () => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES, groupsChannelId: 'gc', topicsParentId: null });
  await t('entrada direta avisa o organizador; entrada que completa avisa a equipe com o link do tópico', async () => {
    const w = world(); prefsDb = {}; require('../utils/db').loadMatchProfile = async () => null;
    store.getGroup = async () => G(); store.requestJoin = async () => ({ action: 'confirmed', group: G() }); store.setAnnouncement = async () => {};
    await gf.handleInteraction(interG(w, 'minako-mm:g:join:5')); const orgDm = w.dms.find(d => d[0] === 'org'); assert.match(orgDm[1], /<@u> entrou no seu grupo \*\*#5\*\* \(2\/3\)/);
    const w2 = world(); store.getGroup = async () => G({ state: 'confirmed', free: 0, confirmed: 3, threadId: 'th9', members: [{ userId: 'org' }, { userId: 'a' }, { userId: 'u' }] });
    store.requestJoin = async () => ({ action: 'confirmed', group: G({ state: 'confirmed' }) });
    await gf.handleInteraction(interG(w2, 'minako-mm:g:join:5')); const ids = w2.dms.map(d => d[0]).sort(); assert.deepEqual(ids, ['a', 'org']); assert.match(w2.dms[0][1], /Equipe completa/); assert.match(w2.dms[0][1], /<#th9>/);
  });
  await t('avisos respeitam o destino de cada pessoa (off / tópico) sem desviar', async () => {
    const w = world(); prefsDb = { org: P({ groups: 'off' }), a: P({ groups: 'thread' }) };
    store.getGroup = async () => G({ state: 'confirmed', free: 0, confirmed: 3, threadId: 'th9', members: [{ userId: 'org' }, { userId: 'a' }, { userId: 'u' }] });
    store.requestJoin = async () => ({ action: 'confirmed', group: G() });
    await gf.handleInteraction(interG(w, 'minako-mm:g:join:5')); assert.equal(w.dms.length, 0); assert.equal(w.thread.length, 1); // a -> tópico; org -> nada
  });
  await t('saída avisa o organizador; se o organizador sai, o novo organizador é informado', async () => {
    const w = world(); prefsDb = {};
    store.getGroup = async () => G({ organizerId: 'org' }); store.leaveGroup = async () => ({ state: 'searching_replacement', searchReplacement: true, group: G({ organizerId: 'a', confirmed: 1 }) });
    await gf.handleInteraction(interG(w, 'minako-mm:g:leave:5', 'org')); assert.equal(w.dms[0][0], 'a'); assert.match(w.dms[0][1], /Você agora é o organizador/); assert.match(w.dms[0][1], /substituto/);
  });
  await t('reconciliação: cria o tópico que faltou (uma vez) e refaz o anúncio de grupos vivos', async () => {
    const w = { threads: 0, edits: 0, sent: 0 };
    const thread = { id: 'th1', send: async () => {}, members: { add: async () => {} }, delete: async () => {} };
    const parent = { isTextBased: () => true, guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => true }), threads: { create: async () => { w.threads++; return thread; } } };
    const msg = { edit: async () => { w.edits++; } };
    const groups = { isTextBased: () => true, id: 'gc', send: async () => { w.sent++; return { id: 'ann2' }; }, messages: { fetch: async () => msg } };
    const client = { channels: { fetch: async (id) => (id === 'tp' ? parent : groups) }, users: { fetch: async () => ({ send: async () => ({}) }) } };
    let threadId = null;
    store.getSettings = async () => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES, groupsChannelId: 'gc', topicsParentId: 'tp' });
    store.getGroup = async () => G({ state: 'confirmed', free: 0, confirmed: 3, threadId, announceChannelId: 'gc', announceMessageId: 'ann1', members: [{ userId: 'org' }, { userId: 'a' }, { userId: 'b' }] });
    store.claimThread = async (id, th) => { if (threadId) return false; threadId = th; return true; };
    store.claimReconcileBatch = async () => [{ groupId: '5', guildId: 'g', state: 'confirmed', threadId: null, announceMessageId: 'ann1' }, { groupId: '6', guildId: 'g', state: 'open', threadId: null, announceMessageId: null }];
    await gf.reconcile(client);
    assert.equal(w.threads, 1); assert.equal(threadId, 'th1'); assert.equal(w.edits, 1);   // grupo 5: tópico criado e anúncio atualizado; grupo 6 (sem anúncio, aberto): nada a fazer
    store.claimReconcileBatch = async () => [{ groupId: '5', guildId: 'g', state: 'confirmed', threadId: 'th1', announceMessageId: 'ann1' }];
    await gf.reconcile(client); assert.equal(w.threads, 1);                                  // idempotente: não cria outro tópico
  });
  await t('reconciliação: falha em um grupo não derruba o ciclo dos demais', async () => {
    const seen = []; store.claimReconcileBatch = async () => [{ groupId: '7', guildId: 'g', state: 'open', threadId: null, announceMessageId: 'x' }, { groupId: '8', guildId: 'g', state: 'open', threadId: null, announceMessageId: 'y' }];
    store.getGroup = async (g, id) => { seen.push(id); throw new Error('falha simulada'); };
    await gf.reconcile({}); assert.deepEqual(seen, ['7', '8']);
  });
  await t('composição por vaga: linhas viram vagas; função fora do catálogo é recusada', () => {
    const catalog = ['Selva', 'Apoio', 'Rota Superior']; const mode = core.makeMode({ id: 'x', idealSize: 3, minSize: 2 });
    assert.deepEqual(parse.parseSlots('selva\nlivre', mode, catalog), [{ role: 'Selva' }, { role: null }, { role: null }]);
    assert.throws(() => parse.parseSlots('Mago', mode, catalog), /não está no catálogo/); assert.throws(() => parse.parseSlots('a\nb\nc\nd', mode, catalog), /3 vagas/);
    assert.equal(parse.slotsText(core.makeMode({ id: 'x', idealSize: 2, slots: [{ role: 'Selva' }, {}] })), 'Selva\nlivre');
  });
  await t('editar o modo preserva a composição se o tamanho não muda; se muda, volta a vagas livres', () => {
    const existing = core.makeMode({ id: 'x', label: 'X', idealSize: 3, minSize: 2, slots: [{ role: 'Selva' }, { role: 'Apoio' }, {}] });
    const f = { label: 'X', ideal: '3', min: '2', incomplete: 'não', elo: '' };
    assert.deepEqual(parse.parseMode(f, existing, [existing]).slots.map(s => s.role), ['Selva', 'Apoio', null]);
    assert.deepEqual(parse.parseMode({ ...f, ideal: '4' }, existing, [existing]).slots.map(s => s.role), [null, null, null, null]);
  });
  await t('painel: composição é salva e a fila passa a respeitá-la', async () => {
    const cfg = { settings: core.normalizeSettings({}), modes: [core.makeMode({ id: 'duo', label: 'Dupla', idealSize: 2, minSize: 2 })], roleIds: {}, centralChannelId: null };
    store.getSettings = async () => cfg; const saved = []; store.saveSettingsPatch = async (g, p) => { saved.push(p); };
    const inter = { guildId: 'g', user: { id: 'u1' }, customId: 'minako-mm:cfg:slots-modal:u1:duo', client: {}, memberPermissions: { has: () => true }, member: { roles: { cache: { has: () => false } } }, fields: { getTextInputValue: () => 'Selva\nApoio' }, update: async () => {}, reply: async () => {} };
    await panel.handleInteraction(inter); const mode = core.makeMode(saved[0].modes[0]); assert.deepEqual(mode.slots.map(s => s.role), ['Selva', 'Apoio']);
    const av = (id, roles) => ({ userId: id, modeId: 'duo', roles, status: 'active', since: Date.now() - 1000, waitingSince: Date.now() - 1000, expiresAt: Date.now() + 3600_000 });
    assert.equal(core.buildProposals([av('1', ['Selva']), av('2', ['Selva'])], mode, Date.now(), cfg.settings).length, 0);
    assert.equal(core.buildProposals([av('1', ['Selva']), av('2', ['Apoio'])], mode, Date.now(), cfg.settings).length, 1);
  });
  await t('migração 2: sequencial, idempotente e reversão só toca minako_mm', () => {
    assert.deepEqual(schema.MIGRATIONS.map(m => m.version).slice(0, 2), [1, 2]); // a 3 é testada em mmSocialFlow
    const m2 = schema.MIGRATIONS[1]; assert.match(m2.up, /CREATE TABLE IF NOT EXISTS minako_mm_prefs/); assert.match(m2.up, /ADD COLUMN IF NOT EXISTS expiry_warned_at/); assert.match(m2.up, /ADD COLUMN IF NOT EXISTS reconciled_at/);
    for (const m of schema.MIGRATIONS) for (const stmt of m.down.replace(/DO \$\$[\s\S]*?\$\$;/g, '').split(';').map(x => x.trim()).filter(Boolean)) assert.match(stmt, /minako_mm_/);
  });
  await t('backup: backups antigos (sem prefs) continuam restauráveis e o plano trata prefs', () => {
    const tables = Object.fromEntries(backup.INSERT_ORDER.filter(x => x !== 'minako_mm_prefs').map(x => [x, []]));
    const old = { schema: backup.FORMAT, guildId: 'g', tables }; assert.ok(backup.validateBackup(old, 'g'));
    const plan = backup.buildRestorePlan({ ...old, tables: { ...tables, minako_mm_prefs: [{ guild_id: 'g', user_id: 'u', notif: { groups: 'dm' } }] } }, 'g');
    assert.ok(plan.steps.some(s => s.sql.startsWith('DELETE FROM minako_mm_prefs'))); assert.equal(plan.counts.minako_mm_prefs, 1);
    assert.ok(plan.steps.find(s => s.sql.startsWith('INSERT INTO minako_mm_prefs')).params.includes('{"groups":"dm"}'));
  });
  await t('Central: botão de preferências substitui "Meu perfil" e força uma edição única após atualizar', () => {
    assert.ok(central.CENTRAL_BUTTONS.some(b => b[0] === 'minako-mm:prefs')); assert.ok(!central.CENTRAL_BUTTONS.some(b => b[0] === 'minako-mm:profile'));
    assert.notEqual(central.contentHash('x'), require('node:crypto').createHash('sha1').update('x').digest('hex'));
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
