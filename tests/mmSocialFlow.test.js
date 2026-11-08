'use strict';
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const store = require('../utils/matchmaking/store');
const sstore = require('../utils/matchmaking/socialStore');
const core = require('../utils/matchmaking/mmCore');
const central = require('../utils/matchmaking/central');
const social = require('../utils/matchmaking/social');
const socialFlow = require('../utils/matchmaking/socialFlow');
const prefsFlow = require('../utils/matchmaking/prefsFlow');
const playFlow = require('../utils/matchmaking/playFlow');
const engine = require('../utils/matchmaking/engine');
const mm = require('../utils/matchmaking');
const schema = require('../utils/matchmaking/schema');
const backup = require('../utils/matchmaking/backupFormat');
const { textOf, buttonsOf } = stubs;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
central.requestRefresh = async () => {};
const E = (code, message) => Object.assign(new Error(message || code), { code });
const P = (notif = {}, extra = {}) => ({ ...core.normalizePrefs({ notif }), deliveryIssue: null, ...extra });
let prefsDb = {}; store.getPrefs = async (g, u) => prefsDb[u] || P(); const issues = []; store.recordDeliveryIssue = async (g, u, c, v) => issues.push([u, c, v]); store.logEvent = async () => {};
store.getSettings = async () => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES });
function world({ dmFail = [] } = {}) {
  const w = { dms: [], edits: [] };
  w.client = { users: { fetch: async (id) => ({ send: async (p) => { if (dmFail.includes(id)) throw new Error('Cannot send messages to this user'); w.dms.push([id, textOf(p), p]); return { id: 'm' + id, channelId: 'c' + id }; },
    createDM: async () => ({ messages: { fetch: async () => ({ edit: async (p) => { w.edits.push(textOf(p)); } }) } }) }) } };
  return w;
}
const part = (o = {}) => ({ id: '9', guildId: 'g', userA: 'a', userB: 'b', inviterId: 'a', status: 'pending', expiresAt: Date.now() + 86400_000, dmMessageId: null, ...o });

(async () => {
  await t('convite: DM com Aceitar/Recusar, texto sem pressão e sem revelar nada além do convidante', async () => {
    const w = world(); let dmSet = null;
    sstore.invitePartner = async () => ({ action: 'invited', id: '9' }); sstore.getPartnership = async () => part(); sstore.setPartnershipDm = async (...a) => { dmSet = a; };
    const r = await socialFlow.invite(w.client, 'g', 'a', { id: 'b', bot: false });
    assert.ok(r.ok); assert.match(r.text, /recusas não são comunicadas/); assert.equal(w.dms[0][0], 'b'); assert.match(w.dms[0][1], /os dois\*\* quiserem/); assert.match(w.dms[0][1], /sem penalidade/);
    assert.deepEqual(buttonsOf(w.dms[0][2]).map(b => b.customId), ['minako-mm:soc:pa:9', 'minako-mm:soc:pd:9']); assert.deepEqual(dmSet, ['9', 'cb', 'mb']);
  });
  await t('convite com DM fechada: fica salvo, orienta e não troca de canal', async () => {
    const w = world({ dmFail: ['b'] }); issues.length = 0; sstore.invitePartner = async () => ({ action: 'invited', id: '9' }); sstore.getPartnership = async () => part();
    const r = await socialFlow.invite(w.client, 'g', 'a', { id: 'b' }); assert.match(r.text, /Minhas preferências → Parceiros/); assert.match(r.text, /Não uso outro canal/); assert.deepEqual(issues, [['b', 'actions', 'dm']]);
  });
  await t('convites cruzados viram parceria na hora (interesse mútuo)', async () => {
    const w = world(); sstore.invitePartner = async () => ({ action: 'activated', id: '9' });
    const r = await socialFlow.invite(w.client, 'g', 'a', { id: 'b' }); assert.match(r.text, /já tinha convidado você/); assert.match(w.dms[0][1], /agora são \*\*parceiros recorrentes\*\*/);
  });
  await t('erros de convite viram mensagens claras (limite, repetição, bot, si mesmo)', async () => {
    const w = world();
    for (const code of ['COOLDOWN', 'MY_LIMIT', 'BOT', 'SELF', 'TOO_MANY_PENDING']) { sstore.invitePartner = async () => { throw E(code, social.INVITE_ERRORS[code]); }; const r = await socialFlow.invite(w.client, 'g', 'a', { id: 'b' }); assert.equal(r.ok, false); assert.match(r.text, new RegExp(social.INVITE_ERRORS[code].slice(0, 12))); }
    assert.equal(w.dms.length, 0);
  });
  await t('aceitar pela DM (sem guildId): atualiza a mensagem e avisa o convidante; recusar NÃO avisa ninguém', async () => {
    const w = world(); let shown = ''; sstore.getPartnership = async () => part({ status: 'active' });
    sstore.respondPartnership = async () => ({ status: 'active', partnership: part() });
    const mk = (id, user = 'b') => ({ guildId: null, user: { id: user }, client: w.client, customId: id, update: async (p) => { shown = textOf(p); } });
    assert.equal(await mm.handleInteraction(mk('minako-mm:soc:pa:9')), true); assert.match(shown, /agora são parceiros/); assert.equal(w.dms.filter(d => d[0] === 'a').length, 1);
    w.dms.length = 0; sstore.respondPartnership = async () => ({ status: 'declined', partnership: part() }); sstore.getPartnership = async () => part({ status: 'declined' });
    await mm.handleInteraction(mk('minako-mm:soc:pd:9')); assert.match(shown, /sem nenhum problema/); assert.equal(w.dms.length, 0);
  });
  await t('convite vencido/respondido não é reativado; convite de outra pessoa é recusado', async () => {
    const w = world(); let shown = ''; const mk = (id) => ({ guildId: null, user: { id: 'b' }, client: w.client, customId: id, update: async (p) => { shown = textOf(p); } });
    sstore.getPartnership = async () => part({ status: 'expired' }); sstore.respondPartnership = async () => ({ stale: true, status: 'expired', partnership: part() });
    await socialFlow.handleInteraction(mk('minako-mm:soc:pa:9')); assert.match(shown, /expirou/);
    sstore.respondPartnership = async () => { throw E('NOT_PARTICIPANT', 'Esse convite não é seu.'); }; await socialFlow.handleInteraction(mk('minako-mm:soc:pa:9')); assert.match(shown, /não é seu/);
  });
  await t('aviso de disponibilidade: cada destinatário selecionado entra na FILA (agrupada depois); sem destinatários nada acontece; erros não derrubam', async () => {
    const estore = require('../utils/matchmaking/engagementStore'); const queued = [];
    estore.enqueue = async (g, r, c, s, m) => { queued.push([r, c, s, m]); };
    sstore.watchRecipients = async () => [{ userId: 'p', category: 'partners' }, { userId: 'f', category: 'favorites' }];
    assert.equal(await socialFlow.announceAvailability(null, 'g', 's', 'Ranqueada'), 2); assert.deepEqual(queued, [['p', 'partners', 's', 'Ranqueada'], ['f', 'favorites', 's', 'Ranqueada']]);
    sstore.watchRecipients = async () => []; assert.equal(await socialFlow.announceAvailability(null, 'g', 's'), 0);
    sstore.watchRecipients = async () => { throw new Error('db fora'); }; assert.equal(await socialFlow.announceAvailability(null, 'g', 's'), 0);
    sstore.watchRecipients = async () => [{ userId: 'p', category: 'partners' }]; estore.enqueue = async () => { throw new Error('fila fora'); }; const orig = console.error; console.error = () => {}; assert.equal(await socialFlow.announceAvailability(null, 'g', 's'), 0); console.error = orig;
  });
  await t('o aviso sai SÓ ao criar a disponibilidade; renovar não avisa de novo', async () => {
    let calls = 0; const real = socialFlow.announceAvailability; socialFlow.announceAvailability = async () => { calls++; };
    const db = require('../utils/db'); db.loadMatchProfile = async () => ({ current_rank: 'ouro' }); engine.runMatching = async () => 0;
    store.setAvailability = async () => {}; store.getAvailability = async () => ({ modeId: 'normal', status: 'active', expiresAt: Date.now() + 7200_000 }); store.changeAvailability = async () => true;
    const base = { guildId: 'g', user: { id: 'u' }, client: {}, update: async () => {}, reply: async () => {} };
    await playFlow.handleInteraction({ ...base, customId: 'minako-mm:play:ok:normal:-:a' }); assert.equal(calls, 1);
    await playFlow.handleInteraction({ ...base, customId: 'minako-mm:av:renew' }); assert.equal(calls, 1); socialFlow.announceAvailability = real;
  });
  const ctxP = (extra = {}) => ({ favorites: ['x1', 'x2'], labels: { x1: 'Ana', x2: 'Beto', p1: 'Caio', i1: 'Dani' }, partners: [{ id: '1', partnerId: 'p1' }], incoming: [{ id: '7', from: 'i1' }], outgoing: [{ id: '8', to: 'z' }], available: new Set(['p1']), ...extra });
  const cfg = { settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES };
  await t('painel Favoritos: lista só os do próprio usuário, explica a privacidade e oferece visibilidade', async () => {
    const txt = textOf(prefsFlow.render('fav', cfg, P(), '', ctxP())); assert.match(txt, /privada/); assert.match(txt, /nunca revelo quem favoritou quem/); assert.match(txt, /<@x1>, <@x2>/); assert.match(txt, /Só meus parceiros/);
    const ids = (await Promise.resolve(prefsFlow.render('fav', cfg, P(), '', ctxP()))).components[0].rows.flatMap(r => r.children || []).map(c => c.customId);
    assert.ok(ids.includes('minako-mm:prefs:fav-add') && ids.includes('minako-mm:prefs:fav-del') && ids.includes('minako-mm:prefs:notif:favorites') && ids.includes('minako-mm:prefs:vis'));
  });
  await t('painel Parceiros: 🟢 só para quem está disponível, convites recebidos com botões, encerrar e avisos independentes', async () => {
    const payload = prefsFlow.render('partners', cfg, P(), '', ctxP()); const txt = textOf(payload);
    assert.match(txt, /<@p1> 🟢/); assert.match(txt, /Convites recebidos:\*\* <@i1>/); assert.match(txt, /Convites enviados aguardando:\*\* 1/); assert.match(txt, /sem penalidade/);
    const ids = payload.components[0].rows.flatMap(r => r.children || []).map(c => c.customId);
    for (const id of ['minako-mm:prefs:par-invite', 'minako-mm:prefs:par-yes:7', 'minako-mm:prefs:par-no:7', 'minako-mm:prefs:par-end', 'minako-mm:prefs:notif:partners']) assert.ok(ids.includes(id), id);
    assert.doesNotMatch(textOf(prefsFlow.render('partners', cfg, P(), '', ctxP({ available: new Set() }))), /<@p1> 🟢/);
    assert.doesNotMatch(txt, /\\n/); // regressão: sem "\n" literal no painel
  });
  const inter = (id, values = [], extra = {}) => ({ guildId: 'g', user: { id: 'me' }, client: world().client, customId: id, values, users: new Map([['bot1', { bot: true }]]), guild: { members: { fetch: async (i) => ({ displayName: `N${i}` }) } },
    update: async (p) => { inter.last = textOf(p); }, reply: async (p) => { inter.last = textOf(p); }, ...extra });
  const stubLists = () => { sstore.listFavorites = async () => ['x1']; sstore.listPartnerships = async () => ({ partners: [], incoming: [], outgoing: [] }); sstore.partnersAvailableNow = async () => new Set(); };
  await t('favoritar: salva em silêncio (sem DM a ninguém), recusa bots e mostra limite', async () => {
    stubLists(); const added = []; sstore.addFavorite = async (g, u, t2, o) => { if (o.isBot) throw E('BOT', social.FAVORITE_ERRORS.BOT); added.push([u, t2]); };
    const i = inter('minako-mm:prefs:fav-add', ['x1']); const w = world(); i.client = w.client; await prefsFlow.handleInteraction(i); assert.deepEqual(added, [['me', 'x1']]); assert.match(inter.last, /a pessoa não é avisada/); assert.equal(w.dms.length, 0);
    await prefsFlow.handleInteraction(inter('minako-mm:prefs:fav-add', ['bot1'])); assert.match(inter.last, /Bots não podem/);
    sstore.addFavorite = async () => { throw E('LIMIT', social.FAVORITE_ERRORS.LIMIT); }; await prefsFlow.handleInteraction(inter('minako-mm:prefs:fav-add', ['x9'])); assert.match(inter.last, /limite de 25/);
  });
  await t('visibilidade e avisos de favoritos/parceiros são salvos sem tocar na disponibilidade', async () => {
    stubLists(); const saved = []; store.savePrefs = async (g, u, patch) => { saved.push(patch); return P(); }; let touched = false; store.changeAvailability = async () => { touched = true; };
    await prefsFlow.handleInteraction(inter('minako-mm:prefs:vis', ['favorites'])); await prefsFlow.handleInteraction(inter('minako-mm:prefs:notif:favorites', ['dm'])); await prefsFlow.handleInteraction(inter('minako-mm:prefs:notif:partners', ['dm']));
    assert.deepEqual(saved, [{ visibility: 'favorites' }, { notif: { favorites: 'dm' } }, { notif: { partners: 'dm' } }]); assert.equal(touched, false);
  });
  await t('parceria: convidar e encerrar pelo painel; encerrar não avisa a outra pessoa', async () => {
    stubLists(); const w = world(); let ended = null; sstore.invitePartner = async () => ({ action: 'invited', id: '9' }); sstore.getPartnership = async () => part(); sstore.setPartnershipDm = async () => {}; sstore.endPartnership = async (g, u, o) => { ended = [u, o]; return true; };
    const i = inter('minako-mm:prefs:par-invite', ['b']); i.client = w.client; await prefsFlow.handleInteraction(i); assert.match(inter.last, /Convite enviado/);
    w.dms.length = 0; const j = inter('minako-mm:prefs:par-end', ['b']); j.client = w.client; await prefsFlow.handleInteraction(j); assert.deepEqual(ended, ['me', 'b']); assert.match(inter.last, /Sem penalidade/); assert.equal(w.dms.length, 0);
  });
  await t('aceitar/recusar pelo painel (DM fechada) usa o mesmo fluxo', async () => {
    stubLists(); const w = world(); sstore.getPartnership = async () => part({ status: 'active' }); sstore.respondPartnership = async (id, u, acc) => ({ status: acc ? 'active' : 'declined', partnership: part() });
    const i = inter('minako-mm:prefs:par-yes:7'); i.client = w.client; await prefsFlow.handleInteraction(i); assert.match(inter.last, /Parceria criada/);
    const j = inter('minako-mm:prefs:par-no:7'); j.client = w.client; await prefsFlow.handleInteraction(j); assert.match(inter.last, /Convite recusado/);
  });
  await t('convites vencidos: a DM do convite é atualizada e ninguém é punido', async () => {
    const w = world(); sstore.sweepExpiredInvites = async () => [part({ status: 'expired', dmMessageId: 'mb' }), part({ id: '10', status: 'expired', dmMessageId: null })];
    await socialFlow.sweepInvites(w.client); assert.equal(w.edits.length, 1); assert.match(w.edits[0], /expirou/);
  });
  await t('migração 3 e backup: tabelas novas, reversíveis e opcionais em backups antigos', () => {
    assert.deepEqual(schema.MIGRATIONS.map(m => m.version).slice(0, 3), [1, 2, 3]);
    const m3 = schema.MIGRATIONS[2]; for (const tb of ['minako_mm_favorites', 'minako_mm_partnerships', 'minako_mm_notice_log']) { assert.match(m3.up, new RegExp(`CREATE TABLE IF NOT EXISTS ${tb}`)); assert.match(m3.down, new RegExp(`DROP TABLE IF EXISTS ${tb}`)); }
    assert.match(m3.up, /user_a < user_b/); assert.match(m3.up, /minako_mm_partnerships_live_uq/); assert.match(m3.up, /ADD COLUMN IF NOT EXISTS visibility/);
    for (const stmt of m3.down.replace(/DO \$\$[\s\S]*?\$\$;/g, '').split(';').map(x => x.trim()).filter(Boolean)) assert.match(stmt, /minako_mm_/);
    const tables = Object.fromEntries(backup.INSERT_ORDER.filter(x => !['minako_mm_prefs', 'minako_mm_favorites', 'minako_mm_partnerships', 'minako_mm_notice_log'].includes(x)).map(x => [x, []]));
    assert.ok(backup.validateBackup({ schema: backup.FORMAT, guildId: 'g', tables }, 'g'));
    const plan = backup.buildRestorePlan({ schema: backup.FORMAT, guildId: 'g', tables: { ...tables, minako_mm_favorites: [{ guild_id: 'g', user_id: 'u', target_id: 't' }] } }, 'g');
    assert.ok(plan.steps.some(s => s.sql.startsWith('DELETE FROM minako_mm_favorites'))); assert.ok(plan.steps.some(s => s.sql.startsWith('INSERT INTO minako_mm_favorites')));
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
