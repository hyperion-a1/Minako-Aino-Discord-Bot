'use strict';
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const store = require('../utils/matchmaking/store');
const core = require('../utils/matchmaking/mmCore');
const central = require('../utils/matchmaking/central');
const groupFlow = require('../utils/matchmaking/groupFlow');
const mf = require('../utils/matchmaking/matchFlow');
const { textOf, buttonsOf } = stubs;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const E = (code) => Object.assign(new Error(code), { code });
central.requestRefresh = async () => {}; groupFlow.refreshAnnouncement = async () => {};
const settings = (o = {}) => core.normalizeSettings({ reviewChannelId: '1557770673819222137', reviewRoleId: '1244300508034760776', ...o });
store.getSettings = async () => ({ settings: settings(), modes: core.DEFAULT_MODES });
const events = []; store.logEvent = async (g, type) => { events.push(type); };
const match = (o = {}) => ({ id: '3', guildId: 'g', groupId: '5', modeId: 'normal', organizerId: 'org', status: 'pending_window', participantIds: ['org', 'a', 'b'], responses: {}, windowEndsAt: Date.now() + 86400_000, ...o });
function world() {
  const w = { posts: [], reviewPosts: [], ch: {} };
  const th = { send: async (p) => { w.posts.push(textOf(p)); } };
  const review = { send: async (p) => { w.reviewPosts.push(p); } };
  w.client = { channels: { fetch: async (id) => (id === '1557770673819222137' ? (w.noReview ? Promise.reject(new Error('x')) : review) : th) } };
  return w;
}
const inter = (w, id, o = {}) => ({ guildId: 'g', user: { id: 'org' }, client: w.client, customId: id, memberPermissions: { has: () => false }, member: { roles: { cache: { has: () => false } } }, reply: async (p) => { w.reply = textOf(p); }, update: async (p) => { w.update = textOf(p); }, ...o });
store.getGroup = async () => ({ id: '5', threadId: 'th1', organizerId: 'org', state: 'confirmed' });

(async () => {
  await t('organizador registra a conclusão: janela aberta no tópico; repetir não duplica', async () => {
    const w = world(); let created = true;
    store.registerMatch = async (g, gid, uid, win, arch) => { assert.equal(win, 86400); assert.equal(arch, 259200); const r = { match: match(), created }; created = false; return r; };
    await mf.handleInteraction(inter(w, 'minako-mm:m:done:5'));
    assert.equal(w.posts.length, 1); assert.match(w.posts[0], /O silêncio não conta como confirmação nem como contestação/); assert.match(w.reply, /Conclusão registrada/);
    await mf.handleInteraction(inter(w, 'minako-mm:m:done:5')); assert.equal(w.posts.length, 1); assert.match(w.reply, /já foi registrada/);
  });
  await t('quem não é organizador não registra', async () => {
    const w = world(); store.registerMatch = async () => { throw E('NOT_ORGANIZER'); };
    await mf.handleInteraction(inter(w, 'minako-mm:m:done:5', { user: { id: 'x' } })); assert.match(w.reply, /Apenas o organizador/);
  });
  await t('"A partida não aconteceu": encerra sem penalidade e avisa o tópico', async () => {
    const w = world(); store.markNotPlayed = async () => ({ match: match({ status: 'not_played' }), created: true });
    await mf.handleInteraction(inter(w, 'minako-mm:m:no:5'));
    assert.match(w.posts[0], /não aconteceu/); assert.match(w.posts[0], /sem penalidade/);
  });
  await t('"Ainda estamos jogando" não altera o estado', async () => {
    const w = world(); let called = false; store.registerMatch = async () => { called = true; };
    await mf.handleInteraction(inter(w, 'minako-mm:m:still:5')); assert.equal(called, false); assert.match(w.reply, /Registrar conclusão/);
  });
  await t('participante confirma; organizador não precisa; janela encerrada é informada', async () => {
    const w = world(); const seq = [() => ({ match: match({ responses: { a: 'confirmed' } }) }), () => { throw E('IS_ORGANIZER'); }, () => ({ match: match(), stale: true })];
    store.respondMatch = async () => seq.shift()();
    await mf.handleInteraction(inter(w, 'minako-mm:m:ok:3', { user: { id: 'a' } })); assert.match(w.reply, /confirmação foi registrada/);
    await mf.handleInteraction(inter(w, 'minako-mm:m:ok:3')); assert.match(w.reply, /não precisa confirmar/);
    await mf.handleInteraction(inter(w, 'minako-mm:m:ok:3', { user: { id: 'b' } })); assert.match(w.reply, /janela.*encerrada/);
  });
  await t('última confirmação valida o registro', async () => {
    const w = world(); store.respondMatch = async () => ({ match: match({ status: 'validated' }) });
    await mf.handleInteraction(inter(w, 'minako-mm:m:ok:3', { user: { id: 'b' } })); assert.match(w.reply, /validado/);
  });
  await t('contestação vai à revisão (canal e cargo configurados) e não pune', async () => {
    const w = world(); store.respondMatch = async () => ({ match: match({ status: 'review' }), newlyContested: true });
    await mf.handleInteraction(inter(w, 'minako-mm:m:ct:3', { user: { id: 'a' } }));
    assert.equal(w.reviewPosts.length, 1); const txt = textOf(w.reviewPosts[0]);
    assert.match(txt, /<@&1244300508034760776>/); assert.match(txt, /<@a>/); assert.match(txt, /não gera punição/);
    assert.deepEqual(w.reviewPosts[0].allowedMentions.roles, ['1244300508034760776']);
    assert.deepEqual(buttonsOf(w.reviewPosts[0]).map(b => b.customId), ['minako-mm:m:rv:3:v', 'minako-mm:m:rv:3:r']);
    assert.match(w.reply, /sem punição/);
  });
  await t('segunda contestação não duplica o aviso à revisão', async () => {
    const w = world(); store.respondMatch = async () => ({ match: match({ status: 'review' }), newlyContested: false });
    await mf.handleInteraction(inter(w, 'minako-mm:m:ct:3', { user: { id: 'b' } })); assert.equal(w.reviewPosts.length, 0);
  });
  await t('sem canal de revisão acessível: registra evento para alertar e informa o usuário', async () => {
    const w = world(); w.noReview = true; events.length = 0; store.respondMatch = async () => ({ match: match({ status: 'review' }), newlyContested: true });
    await mf.handleInteraction(inter(w, 'minako-mm:m:ct:3', { user: { id: 'a' } }));
    assert.ok(events.includes('match.review_unrouted')); assert.match(w.reply, /ficou salva/);
  });
  await t('revisão: só revisor/admin decide; valida ou rejeita e avisa o tópico', async () => {
    const w = world(); store.matchGuildId = async () => 'g';
    await mf.handleInteraction(inter(w, 'minako-mm:m:rv:3:v', { user: { id: 'z' } })); assert.match(w.reply, /Apenas a equipe de revisão/);
    store.resolveReview = async (g, id, rev, dec) => match({ status: dec === 'valid' ? 'validated' : 'resolved_rejected' });
    const rev = (id) => inter(w, id, { user: { id: 'r1' }, member: { roles: { cache: { has: (r) => r === '1244300508034760776' } } } });
    await mf.handleInteraction(rev('minako-mm:m:rv:3:v')); assert.match(w.update, /validado/); assert.match(w.posts.at(-1), /validou/);
    await mf.handleInteraction(rev('minako-mm:m:rv:3:r')); assert.match(w.update, /rejeitado/); assert.match(w.posts.at(-1), /Ninguém foi penalizado/);
  });
  await t('revisão já resolvida não é refeita', async () => {
    const w = world(); store.matchGuildId = async () => 'g'; store.resolveReview = async () => { throw E('BAD_STATE'); };
    await mf.handleInteraction(inter(w, 'minako-mm:m:rv:3:v', { memberPermissions: { has: () => true } })); assert.match(w.reply, /já foi resolvido/);
  });
  await t('janela vencida: valida se todos confirmaram; senão mantém sem punir quem ficou em silêncio', async () => {
    const w = world(); store.sweepMatchWindows = async () => [match({ status: 'validated' }), match({ status: 'recorded' })];
    await mf.sweeps(w.client); assert.match(w.posts[0], /validado/); assert.match(w.posts[1], /Quem não respondeu não foi penalizado/);
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
