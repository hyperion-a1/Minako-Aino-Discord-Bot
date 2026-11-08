'use strict';
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const db = require('../utils/db');
const store = require('../utils/matchmaking/store');
const core = require('../utils/matchmaking/mmCore');
const central = require('../utils/matchmaking/central');
const gf = require('../utils/matchmaking/groupFlow');
const { textOf, buttonsOf } = stubs;

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const cfg = (o = {}) => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES, groupsChannelId: 'gc', topicsParentId: 'tp', ...o });
central.requestRefresh = async () => {};
store.sweepInactiveGroups = async () => [];
store.getPrefs = async () => core.normalizePrefs({}); store.recordDeliveryIssue = async () => {};
const E = (code) => Object.assign(new Error(code), { code });

function discord() {
  const w = { sentGroups: [], edits: 0, threads: [], threadMsgs: [], deleted: 0, dms: [], dmFail: new Set() };
  const msg = { edit: async () => { w.edits++; } };
  const thread = (id) => ({ id, send: async (p) => { w.threadMsgs.push(p); }, members: { add: async () => {} }, delete: async () => { w.deleted++; }, setArchived: async () => { w.archived = true; } });
  const parent = { isTextBased: () => true, guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => true }), threads: { create: async () => { const th = thread('th' + (w.threads.length + 1)); w.threads.push(th); return th; } } };
  const groups = { isTextBased: () => true, id: 'gc', send: async () => { w.sentGroups.push(1); return { id: 'ann1' }; }, messages: { fetch: async () => msg } };
  w.client = {
    channels: { fetch: async (id) => (id === 'tp' ? parent : id === 'gc' ? groups : thread(id)) },
    users: { fetch: async (id) => ({ send: async (p) => { if (w.dmFail.has(id)) throw new Error('closed'); w.dms.push([id, p]); return { id: 'x' }; } }) },
  };
  return w;
}
const grp = (o = {}) => ({ id: '5', guildId: 'g', modeId: 'normal', organizerId: 'org', state: 'open', capacity: 3, confirmed: 2, free: 1, joinMethod: 'direct', allowIncomplete: false, members: [{ userId: 'org' }, { userId: 'a' }], pending: [], requiredRoles: [], announceChannelId: 'gc', announceMessageId: 'ann1', threadId: null, ...o });
const inter = (w, id, extra = {}) => ({ guildId: 'g', user: { id: 'u' }, client: w.client, customId: id, isMessageComponent: () => true, message: { flags: { has: () => true } }, update: async (p) => { w.lastUpdate = p; }, reply: async (p) => { w.lastReply = p; }, ...extra });
const shown = (w) => textOf(w.lastUpdate || w.lastReply);

(async () => {
  await t('entrada direta que completa o grupo cria UM tópico e atualiza o anúncio', async () => {
    const w = discord(); let state = 'open'; let threadId = null;
    store.getSettings = async () => cfg(); db.loadMatchProfile = async () => null; store.logEvent = async () => {};
    store.getGroup = async () => grp({ state, threadId, confirmed: state === 'open' ? 2 : 3, free: state === 'open' ? 1 : 0, members: [{ userId: 'org' }, { userId: 'a' }, ...(state === 'confirmed' ? [{ userId: 'u' }] : [])] });
    store.requestJoin = async () => { state = 'confirmed'; return { action: 'confirmed', group: grp({ state: 'confirmed' }) }; };
    store.claimThread = async (id, th) => { if (threadId) return false; threadId = th; return true; };
    await gf.handleInteraction(inter(w, 'minako-mm:g:join:5'));
    assert.match(shown(w), /Você entrou no grupo/); assert.equal(w.threads.length, 1); assert.equal(w.edits, 1);
    await gf.ensureThread(w.client, 'g', '5'); assert.equal(w.threads.length, 1); // idempotente
  });
  await t('tópico concorrente: quem perde o claim apaga o seu e não duplica', async () => {
    const w = discord(); store.getSettings = async () => cfg(); store.logEvent = async () => {};
    store.getGroup = async () => grp({ state: 'confirmed', threadId: null }); store.claimThread = async () => false;
    await gf.ensureThread(w.client, 'g', '5'); assert.equal(w.deleted, 1);
  });
  await t('sem canal de tópicos configurado: registra e não trava', async () => {
    const w = discord(); const ev = []; store.getSettings = async () => cfg({ topicsParentId: null }); store.logEvent = async (g, type) => ev.push(type);
    store.getGroup = async () => grp({ state: 'confirmed' });
    assert.equal(await gf.ensureThread(w.client, 'g', '5'), null); assert.deepEqual(ev, ['group.thread_unavailable']);
  });
  await t('última vaga perdida: mensagem amigável, sem exceção', async () => {
    const w = discord(); store.getSettings = async () => cfg(); store.getGroup = async () => grp(); db.loadMatchProfile = async () => null;
    store.requestJoin = async () => { throw E('NO_SLOT'); };
    await gf.handleInteraction(inter(w, 'minako-mm:g:join:5')); assert.match(shown(w), /última vaga acabou de ser ocupada/);
  });
  await t('entrada com aprovação: pedido pendente avisa o organizador por DM e não ocupa vaga', async () => {
    const w = discord(); store.getSettings = async () => cfg(); db.loadMatchProfile = async () => null; store.logEvent = async () => {};
    store.getGroup = async () => grp({ joinMethod: 'approval' });
    store.requestJoin = async () => ({ action: 'pending', group: grp({ joinMethod: 'approval', pending: ['u'] }) });
    await gf.handleInteraction(inter(w, 'minako-mm:g:join:5'));
    assert.match(shown(w), /Pedido enviado/); assert.equal(w.dms[0][0], 'org');
    assert.deepEqual(buttonsOf(w.dms[0][1]).map(b => b.customId), ['minako-mm:g:ap:5:u', 'minako-mm:g:rj:5:u']);
  });
  await t('DM do organizador fechada: pedido segue registrado e o usuário é orientado', async () => {
    const w = discord(); w.dmFail.add('org'); const ev = []; store.getSettings = async () => cfg(); db.loadMatchProfile = async () => null; store.logEvent = async (g, type) => ev.push(type);
    store.getGroup = async () => grp({ joinMethod: 'approval' }); store.requestJoin = async () => ({ action: 'pending', group: grp({ joinMethod: 'approval' }) });
    await gf.handleInteraction(inter(w, 'minako-mm:g:join:5'));
    assert.match(shown(w), /não consegui avisar o organizador/); assert.ok(ev.includes('group.organizer_dm_failed'));
  });
  await t('aprovação: revalida vaga e, se acabou, informa sem confirmar', async () => {
    const w = discord(); store.groupGuildId = async () => 'g'; store.decideRequest = async () => { throw E('NO_SLOT'); };
    await gf.handleInteraction(inter(w, 'minako-mm:g:ap:5:u', { guildId: null, user: { id: 'org' } }));
    assert.match(shown(w), /última vaga/);
  });
  await t('saída que abre vaga em grupo confirmado avisa o tópico e atualiza o anúncio', async () => {
    const w = discord(); store.getSettings = async () => cfg(); store.logEvent = async () => {};
    store.leaveGroup = async () => ({ state: 'searching_replacement', searchReplacement: true, group: grp({ state: 'searching_replacement', threadId: 'th9' }) });
    store.getGroup = async () => grp({ state: 'searching_replacement' });
    await gf.handleInteraction(inter(w, 'minako-mm:g:leave:5')); assert.match(shown(w), /Sem penalidade/); assert.equal(w.edits, 1);
  });
  await t('REGRESSÃO: anúncio apagado (edição falha com Unknown Message) é republicado', async () => {
    const w = discord(); store.getSettings = async () => cfg(); store.logEvent = async () => {}; store.setAnnouncement = async () => {};
    store.getGroup = async () => grp();
    const ch = await w.client.channels.fetch('gc'); const m = await ch.messages.fetch(); m.edit = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
    await gf.refreshAnnouncement(w.client, 'g', '5'); assert.equal(w.sentGroups.length, 1);
  });
  await t('prazo de substituto vencido: organizador decide e é avisado só uma vez', async () => {
    const w = discord(); let notified = false; store.getSettings = async () => cfg(); store.logEvent = async () => {};
    store.listReplacementDue = async () => [{ groupId: '5', guildId: 'g', organizerId: 'org' }]; store.listArchiveDue = async () => [];
    store.markReplacementNotified = async () => { if (notified) return false; notified = true; return true; };
    store.getGroup = async () => grp({ state: 'searching_replacement', allowIncomplete: true, confirmed: 2 });
    await gf.sweeps(w.client); await gf.sweeps(w.client);
    assert.equal(w.dms.length, 1); assert.deepEqual(buttonsOf(w.dms[0][1]).map(b => b.customId), ['minako-mm:g:rd:5:c', 'minako-mm:g:rd:5:e', 'minako-mm:g:rd:5:x']);
  });
  await t('grupo aberto inativo: anúncio atualizado e organizador avisado, sem penalidade', async () => {
    const w = discord(); store.getSettings = async () => cfg(); store.logEvent = async () => {}; store.listReplacementDue = async () => []; store.listArchiveDue = async () => [];
    store.getGroup = async () => grp({ state: 'closed' });
    store.sweepInactiveGroups = async () => [{ groupId: '5', guildId: 'g', organizerId: 'org' }];
    await gf.sweeps(w.client); store.sweepInactiveGroups = async () => [];
    assert.equal(w.edits, 1); assert.equal(w.dms[0][0], 'org'); assert.match(textOf(w.dms[0][1]), /inatividade/); assert.match(textOf(w.dms[0][1]), /Ninguém foi penalizado/);
  });
  await t('tópicos de grupos encerrados são arquivados (não apagados)', async () => {
    const w = discord(); let marked = null; store.listReplacementDue = async () => []; store.listArchiveDue = async () => [{ groupId: '5', guildId: 'g', threadId: 'th1' }]; store.markArchived = async (id) => { marked = id; };
    await gf.sweeps(w.client); assert.equal(w.archived, true); assert.equal(marked, '5'); assert.equal(w.deleted, 0);
  });
  await t('criar grupo: valida canal, cria e publica; sem canal configurado avisa', async () => {
    const w = discord(); store.getSettings = async () => cfg({ groupsChannelId: null }); db.loadMatchProfile = async () => ({ current_rank: 'ouro' });
    await gf.handleInteraction(inter(w, 'minako-mm:create', { isMessageComponent: () => false }));
    assert.match(shown(w), /não configurou o canal de grupos/);
    store.getSettings = async () => cfg(); let args = null; store.createGroup = async (g, a) => { args = a; return '12'; };
    store.getGroup = async () => grp({ id: '12' }); store.setAnnouncement = async () => {}; store.logEvent = async () => {};
    await gf.handleInteraction(inter(w, `minako-mm:create:ok:${gf.encCreate({ mode: 'ranqueada', size: 4, jm: 'a', inc: '1', roles: [3] })}`));
    assert.equal(args.capacity, 4); assert.equal(args.joinMethod, 'approval'); assert.equal(args.allowIncomplete, true); assert.deepEqual(args.requiredRoles, ['Apoio']);
    assert.deepEqual(args.eloRange, [core.rankIndex('ouro') - 2, core.rankIndex('ouro') + 2]); assert.equal(w.sentGroups.length, 1); assert.match(shown(w), /Grupo \*\*#12\*\* criado/);
  });
  await t('criar grupo em modo com elo sem elo no perfil não cria (botão desativado)', async () => {
    const panel = gf.createPanel(cfg(), { mode: 'ranqueada', size: 5, jm: 'd', inc: '0', roles: [] }, null);
    assert.equal(buttonsOf(panel).find(b => b.customId?.startsWith('minako-mm:create:ok')).disabled, true);
  });
  await t('anúncio: Entrar fica desativado sem vaga e reflete "Solicitar vaga" na aprovação', async () => {
    const full = gf.announcementPayload(grp({ free: 0, confirmed: 3 }), 'Normal'); assert.equal(buttonsOf(full)[0].disabled, true);
    const appr = gf.announcementPayload(grp({ joinMethod: 'approval' }), 'Normal'); assert.ok(buttonsOf(appr)[0].calls.some(c => c[0] === 'setLabel' && c[1][0] === 'Solicitar vaga'));
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
