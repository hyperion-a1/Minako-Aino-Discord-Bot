'use strict';
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const store = require('../utils/matchmaking/store');
const estore = require('../utils/matchmaking/engagementStore');
const core = require('../utils/matchmaking/mmCore');
const policy = require('../utils/matchmaking/notifyPolicy');
const notify = require('../utils/matchmaking/notify');
const ef = require('../utils/matchmaking/engagementFlow');
const prefsFlow = require('../utils/matchmaking/prefsFlow');
const panel = require('../utils/matchmaking/configPanel');
const parse = require('../utils/matchmaking/configParse');
const gf = require('../utils/matchmaking/groupFlow');
const tf = require('../utils/matchmaking/teamFlow');
const sf = require('../utils/matchmaking/socialFlow');
const engine = require('../utils/matchmaking/engine');
const playFlow = require('../utils/matchmaking/playFlow');
const tstore = require('../utils/matchmaking/teamStore');
const sstore = require('../utils/matchmaking/socialStore');
const schema = require('../utils/matchmaking/schema');
const mm = require('../utils/matchmaking');
const { textOf, buttonsOf } = stubs;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const PAY = { components: [{ texts: [{ content: 'x' }] }] };
const NOW = Date.UTC(2026, 9, 23, 18, 30);                       // 15:30 de sexta (Brasília)
const FRI19 = Date.UTC(2026, 9, 23, 22, 5);                      // 19:05 de sexta (Brasília)
let prefsDb = {}; const P = (o = {}) => ({ ...core.normalizePrefs(o), deliveryIssue: null });
store.getPrefs = async (g, u) => prefsDb[u] || P(); store.recordDeliveryIssue = async () => {}; const events = []; store.logEvent = async (g, type) => events.push(type);
const saved = []; store.savePrefs = async (g, u, patch) => { saved.push([g, u, patch]); prefsDb[u] = P({ ...(prefsDb[u] || {}), notif: { ...(prefsDb[u]?.notif || {}), ...(patch.notif || {}) }, ...('pausedUntil' in patch ? { pausedUntil: patch.pausedUntil } : {}), ...('quiet' in patch ? { quiet: patch.quiet } : {}) }); return prefsDb[u]; };
const cfg = (o = {}) => ({ settings: core.normalizeSettings(o), modes: core.DEFAULT_MODES }); let settings = cfg(); store.getSettings = async () => settings;
function world(dmFail = []) { const w = { dms: [], edits: [] }; const chan = { messages: { fetch: async (id) => ({ edit: async (p) => { w.edits.push([id, textOf(p), Array.isArray(p.components[0].rows) ? p.components[0].rows.length : 0]); } }) } };
  w.client = { users: { fetch: async (id) => ({ send: async (p) => { if (dmFail.includes(id)) throw new Error('closed'); w.dms.push([id, textOf(p), p]); return { id: 'm' + w.dms.length, channelId: 'c' + id }; }, createDM: async () => chan }) }, channels: { fetch: async () => chan } };
  return w; }
const mkI = (w, id, o = {}) => ({ guildId: null, user: { id: 'u' }, client: w.client, customId: id, values: [], update: async (p) => { w.shown = textOf(p); w.payload = p; }, reply: async (p) => { w.shown = p.content ?? textOf(p); w.payload = p; }, showModal: async (m) => { w.modal = m; }, ...o });

(async () => {
  await t('notify: engajamento respeita pausa e horário silencioso; operacional NÃO', async () => {
    const w = world(); prefsDb = { p: P({ notif: { partners: 'dm', actions: 'dm' }, pausedUntil: Date.now() + 60_000 }), q: P({ notif: { partners: 'dm', actions: 'dm' }, quiet: { from: 0, to: 23 } }) };
    assert.deepEqual(await notify.send(w.client, 'g', 'p', 'partners', PAY), { sent: false, reason: 'paused' });
    assert.equal((await notify.send(w.client, 'g', 'p', 'actions', PAY)).via, 'dm');          // pedido que exige resposta chega mesmo em pausa
    assert.equal((await notify.send(w.client, 'g', 'q', 'actions', PAY)).via, 'dm');
  });
  await t('notify: resumo ("daily"/"weekly") usa mensagem privada; "não avisar" continua valendo', async () => {
    const w = world(); prefsDb = { u: P({ notif: { digest: 'daily' } }), v: P({ notif: { digest: 'off' } }) };
    assert.equal((await notify.send(w.client, 'g', 'u', 'digest', PAY)).via, 'dm'); assert.equal((await notify.send(w.client, 'g', 'v', 'digest', PAY)).reason, 'off');
  });
  await t('notify: rastreia mensagem operacional quando pedido (e rastrear nunca atrapalha a entrega)', async () => {
    const w = world(); const tracked = []; const real = estore.trackOp; prefsDb = { u: P() };
    estore.trackOp = async (...a) => { tracked.push(a); }; await notify.send(w.client, 'g', 'u', 'actions', PAY, { track: { kind: 'join_req', ref: '5:u' } }); assert.deepEqual(tracked[0].slice(0, 5), ['g', 'u', 'join_req', '5:u', 'cu']);
    estore.trackOp = async () => { throw new Error('banco fora'); }; assert.equal((await notify.send(w.client, 'g', 'u', 'actions', PAY, { track: { kind: 'x', ref: 'y' } })).sent, true); estore.trackOp = real;
  });
  await t('encerrar operacional: tira os botões, explica o desfecho, poupa a mensagem recém-atualizada e ignora falhas', async () => {
    const w = world(); let args = null; estore.takeOps = async (g, k, r, o) => { args = [g, k, r, o]; return [{ userId: 'o', channelId: 'c1', messageId: 'mA' }, { userId: 'o', channelId: 'c2', messageId: 'mB' }]; };
    assert.equal(await notify.closeOps(w.client, 'g', 'join_req', '5:u', { exceptMessageId: 'mX', text: 'Pedido aprovado.' }), 2); assert.deepEqual(args, ['g', 'join_req', '5:u', { prefix: false, exceptMessageId: 'mX' }]);
    assert.deepEqual(w.edits.map(e => [e[1], e[2]]), [['✔️ Pedido aprovado.', 0], ['✔️ Pedido aprovado.', 0]]);
    estore.takeOps = async () => { throw new Error('db'); }; assert.equal(await notify.closeOps(w.client, 'g', 'k', 'r'), 0);
  });
  await t('fila agrupada: 3 parceiros disponíveis viram UMA mensagem, com atalhos que carregam o servidor', async () => {
    const w = world(); prefsDb = { r: P({ notif: { partners: 'dm' } }) }; const at = Date.now();
    estore.claimQueue = async () => [{ guildId: 'g', recipientId: 'r', items: ['a', 'b', 'a', 'c'].map(s => ({ category: 'partners', subjectId: s, modeLabel: 'Normal', at: at - 1000 })) }];
    assert.equal(await ef.flushQueue(w.client, at), 1); assert.equal(w.dms.length, 1); assert.match(w.dms[0][1], /\*\*3 parceiros\*\*/);
    assert.deepEqual(buttonsOf(w.dms[0][2]).map(b => b.customId), ['minako-mm:eng:cfg:partners:g', 'minako-mm:eng:pause:g:24']);
  });
  await t('fila agrupada: uma pessoa vira texto singular com o modo; avisos velhos somem; pausa/silêncio no envio bloqueiam', async () => {
    const w = world(); prefsDb = { r: P({ notif: { favorites: 'dm' } }) }; const at = Date.now();
    estore.claimQueue = async () => [{ guildId: 'g', recipientId: 'r', items: [{ category: 'favorites', subjectId: 'a', modeLabel: 'Ranqueada', at: at - 1000 }, { category: 'favorites', subjectId: 'old', modeLabel: null, at: at - 20 * 60_000 }] }];
    await ef.flushQueue(w.client, at); assert.match(w.dms[0][1], /<@a> ficou disponível para jogar \(Ranqueada\)/); assert.doesNotMatch(w.dms[0][1], /old/);
    const w2 = world(); prefsDb = { r: P({ notif: { favorites: 'dm' }, pausedUntil: at + 60_000 }) }; assert.equal(await ef.flushQueue(w2.client, at), 0); assert.equal(w2.dms.length, 0);
  });
  await t('alerta de atividade: opt-in, fora de jogo, uma vez por intervalo; sem elegíveis não gasta o intervalo', async () => {
    const w = world(); settings = cfg({ communityAlertMin: 4, communityAlertCooldownSec: 7200 }); store.countActiveAvailability = async () => 6; estore.lastCommunityAlert = async () => null; const logged = []; estore.logNotice = async (...a) => { logged.push(a); };
    prefsDb = { a: P({ notif: { community: 'dm' } }), b: P({ notif: { community: 'dm' } }) };
    let claims = 0; estore.claimCommunityAlert = async () => { claims++; return true; };
    estore.communityInputs = async () => ({ candidates: [{ userId: 'a', prefs: prefsDb.a }, { userId: 'b', prefs: prefsDb.b }], busy: new Set(['b']), log: [] });
    assert.equal(await ef.communityTick(w.client, 'g', NOW), 1); assert.deepEqual(w.dms.map(d => d[0]), ['a']); assert.match(w.dms[0][1], /Há \*\*6\*\* pessoas disponíveis/); assert.equal(claims, 1); assert.deepEqual(logged[0].slice(1), ['a', 'community', 'community']);
    estore.communityInputs = async () => ({ candidates: [{ userId: 'b', prefs: prefsDb.b }], busy: new Set(['b']), log: [] }); claims = 0; assert.equal(await ef.communityTick(w.client, 'g', NOW), 0); assert.equal(claims, 0);
    estore.communityInputs = async () => ({ candidates: [{ userId: 'a', prefs: prefsDb.a }], busy: new Set(), log: [] }); estore.claimCommunityAlert = async () => false; w.dms.length = 0; assert.equal(await ef.communityTick(w.client, 'g', NOW), 0); assert.equal(w.dms.length, 0);   // outra instância já alertou
  });
  await t('alerta de atividade: abaixo do limite, desligado ou dentro do intervalo não envia nada', async () => {
    const w = world(); estore.communityInputs = async () => { throw new Error('não deveria consultar'); }; estore.lastCommunityAlert = async () => null;
    settings = cfg({ communityAlertMin: 0 }); store.countActiveAvailability = async () => 20; assert.equal(await ef.communityTick(w.client, 'g', NOW), 0);
    settings = cfg({ communityAlertMin: 6 }); store.countActiveAvailability = async () => 3; assert.equal(await ef.communityTick(w.client, 'g', NOW), 0);
    store.countActiveAvailability = async () => 9; estore.lastCommunityAlert = async () => NOW - 3600_000; assert.equal(await ef.communityTick(w.client, 'g', NOW), 0);
  });
  await t('resumo: só para quem está no horário, sem repetir no dia, e NUNCA vazio (nem marca envio)', async () => {
    const w = world(); settings = cfg(); store.countActiveAvailability = async () => 3; const claims = [];
    store.listOpenGroups = async () => [{ modeId: 'normal', free: 2, confirmed: 3, capacity: 5 }];
    prefsDb = { d: P({ notif: { digest: 'daily' } }), e: P({ notif: { digest: 'daily' } }), z: P({ notif: { digest: 'daily' }, pausedUntil: FRI19 + 60_000 }) };
    estore.digestCandidates = async () => [{ userId: 'd', prefs: prefsDb.d, lastAt: null }, { userId: 'e', prefs: prefsDb.e, lastAt: FRI19 - 60_000 }, { userId: 'z', prefs: prefsDb.z, lastAt: null }];
    estore.claimDigest = async (g, u) => { claims.push(u); return true; };
    assert.equal(await ef.digestTick(w.client, 'g', FRI19), 1); assert.deepEqual(w.dms.map(d => d[0]), ['d']); assert.match(w.dms[0][1], /Resumo de oportunidades/); assert.match(w.dms[0][1], /Normal — 3\/5 \(2 vagas\)/); assert.deepEqual(claims, ['d']);
    w.dms.length = 0; claims.length = 0; store.listOpenGroups = async () => []; store.countActiveAvailability = async () => 1; assert.equal(await ef.digestTick(w.client, 'g', FRI19), 0); assert.deepEqual(claims, []);   // nada útil: nada enviado, nada marcado
    store.listOpenGroups = async () => [{ modeId: 'normal', free: 1, confirmed: 4, capacity: 5 }]; estore.claimDigest = async () => false; assert.equal(await ef.digestTick(w.client, 'g', FRI19), 0);   // outra instância já enviou
    assert.equal(await ef.digestTick(w.client, 'g', Date.UTC(2026, 9, 23, 20, 0)), 0);   // 17h de Brasília: ainda não é hora
  });
  await t('atalhos na DM: ajustar a categoria, pausar e retomar — sem abrir o servidor e sem tocar na busca', async () => {
    const w = world(); prefsDb = { u: P({ notif: { partners: 'dm' } }) }; saved.length = 0; let avail = false; store.changeAvailability = async () => { avail = true; };
    await mm.handleInteraction(mkI(w, 'minako-mm:eng:cfg:partners:g')); assert.match(w.shown, /Parceiros disponíveis/); assert.match(w.shown, /Isto não afeta propostas/); assert.ok(buttonsOf(w.payload).some(b => b.customId === 'minako-mm:eng:pause:g:24'));
    await mm.handleInteraction(mkI(w, 'minako-mm:eng:set:partners:g', { values: ['off'] })); assert.deepEqual(saved.at(-1), ['g', 'u', { notif: { partners: 'off' } }]); assert.match(w.shown, /Salvo/);
    await mm.handleInteraction(mkI(w, 'minako-mm:eng:set:partners:g', { values: ['thread'] })); assert.match(w.shown, /Opção inválida/); assert.equal(saved.length, 1);
    const before = Date.now(); await mm.handleInteraction(mkI(w, 'minako-mm:eng:pause:g:24')); const until = saved.at(-1)[2].pausedUntil; assert.ok(until - before >= 24 * 3600_000 - 2000 && until - before <= 24 * 3600_000 + 2000); assert.match(w.shown, /continuam chegando/);
    await mm.handleInteraction(mkI(w, 'minako-mm:eng:resume:g')); assert.equal(saved.at(-1)[2].pausedUntil, null); assert.equal(avail, false);
    await mm.handleInteraction(mkI(w, 'minako-mm:eng:pause:g:99999')); assert.ok(saved.at(-1)[2].pausedUntil - Date.now() <= 168 * 3600_000 + 2000);   // pausa limitada a 7 dias
  });
  await t('preferências: seção de engajamento mostra pausa/horário/alertas/resumo e explica que operacionais não são afetados', () => {
    const prefs = P({ notif: { community: 'dm', digest: 'weekly' }, quiet: { from: 22, to: 8 }, pausedUntil: Date.now() + 3600_000 });
    const p = prefsFlow.render('engage', settings, prefs, ''); const txt = textOf(p);
    assert.match(txt, /Pausa geral:\*\* até/); assert.match(txt, /das 22h às 8h/); assert.match(txt, /por mensagem privada/); assert.match(txt, /Toda sexta, às 19h/); assert.match(txt, /não são afetados/); assert.match(txt, /nunca encerra sua busca/);
    const ids = p.components[0].rows.flatMap(r => r.children || []).map(c => c.customId); for (const id of ['minako-mm:prefs:pause', 'minako-mm:prefs:quiet', 'minako-mm:prefs:notif:community', 'minako-mm:prefs:notif:digest']) assert.ok(ids.includes(id), id);
  });
  await t('preferências: pausa, horário silencioso (preset e personalizado válido/inválido) e resumo são salvos sem tocar na disponibilidade', async () => {
    const w = world(); saved.length = 0; let avail = false; store.changeAvailability = async () => { avail = true; }; prefsDb = { u: P() };
    const gi = (id, o = {}) => mkI(w, id, { guildId: 'g', guild: {}, ...o });
    await prefsFlow.handleInteraction(gi('minako-mm:prefs:pause', { values: ['8'] })); assert.ok(saved.at(-1)[2].pausedUntil > Date.now()); await prefsFlow.handleInteraction(gi('minako-mm:prefs:pause', { values: ['0'] })); assert.equal(saved.at(-1)[2].pausedUntil, null);
    await prefsFlow.handleInteraction(gi('minako-mm:prefs:quiet', { values: ['22-8'] })); assert.deepEqual(saved.at(-1)[2], { quiet: { from: 22, to: 8 } }); await prefsFlow.handleInteraction(gi('minako-mm:prefs:quiet', { values: ['none'] })); assert.equal(saved.at(-1)[2].quiet, null);
    await prefsFlow.handleInteraction(gi('minako-mm:prefs:quiet', { values: ['custom'] })); assert.ok(w.modal);
    const fields = (f, t2) => ({ getTextInputValue: (k) => (k === 'from' ? f : t2) });
    await prefsFlow.handleInteraction(gi('minako-mm:prefs:quiet-modal', { fields: fields('23', '6') })); assert.deepEqual(saved.at(-1)[2], { quiet: { from: 23, to: 6 } });
    const count = saved.length; await prefsFlow.handleInteraction(gi('minako-mm:prefs:quiet-modal', { fields: fields('7', '7') })); assert.match(w.shown, /diferentes/); await prefsFlow.handleInteraction(gi('minako-mm:prefs:quiet-modal', { fields: fields('25', '3') })); assert.match(w.shown, /0 a 23/); assert.equal(saved.length, count);
    await prefsFlow.handleInteraction(gi('minako-mm:prefs:notif:digest', { values: ['daily'] })); assert.deepEqual(saved.at(-1)[2], { notif: { digest: 'daily' } }); assert.equal(avail, false);
  });
  await t('administração: alerta de atividade validado e salvo; valor inválido recusado', async () => {
    const w = world(); const patches = []; store.saveSettingsPatch = async (g, p) => { patches.push(p); }; settings = cfg();
    const ci = (id, f) => ({ guildId: 'g', user: { id: 'u1' }, client: w.client, customId: id, memberPermissions: { has: () => true }, member: { roles: { cache: { has: () => false } } }, fields: { getTextInputValue: (k) => f[k] }, update: async (p) => { w.shown = textOf(p); }, reply: async (p) => { w.shown = p.content; }, showModal: async (m) => { w.modal = m; } });
    await panel.handleInteraction(ci('minako-mm:cfg:avisos:u1', {})); assert.ok(w.modal);
    await panel.handleInteraction(ci('minako-mm:cfg:avisos-modal:u1', { min: '8', cooldown: '90' })); assert.deepEqual(patches[0].settings, { communityAlertMin: 8, communityAlertCooldownSec: 5400 });
    await panel.handleInteraction(ci('minako-mm:cfg:avisos-modal:u1', { min: '99', cooldown: '90' })); assert.match(w.shown, /0 a 50/); assert.equal(patches.length, 1);
    await panel.handleInteraction(ci('minako-mm:cfg:avisos-modal:u1', { min: '0', cooldown: '90' })); assert.equal(patches[1].settings.communityAlertMin, 0);
    assert.match(textOf(panel.render('prazos', cfg({ communityAlertMin: 0 }), 'u1')), /Alerta de atividade da comunidade:\*\* desligado/); assert.match(textOf(panel.render('prazos', cfg({ communityAlertMin: 6 }), 'u1')), /a partir de 6 disponíveis/);
    assert.throws(() => parse.parseQuiet('a', '3'), /número/);
  });
  await t('operacional encerrado quando resolvido: pedido de entrada, decisão de substituição, reserva da equipe e convites', async () => {
    const calls = []; const realClose = notify.closeOps; const realSend = notify.send; const sends = [];
    notify.closeOps = async (c, g, kind, ref, o) => { calls.push([kind, ref, o?.prefix || false, o?.exceptMessageId || null]); return 0; }; notify.send = async (c, g, u, cat, p, o) => { sends.push([cat, o]); return { sent: true, message: { id: 'mm', channelId: 'cc' } }; };
    const w = world(); const grp = (o = {}) => ({ id: '5', guildId: 'g', modeId: 'normal', organizerId: 'org', state: 'open', capacity: 3, confirmed: 2, free: 1, joinMethod: 'approval', members: [{ userId: 'org' }, { userId: 'a' }], pending: ['u'], requiredRoles: [], threadId: null, announceChannelId: 'gc', announceMessageId: 'ann', ...o });
    const gi = (id, o = {}) => ({ guildId: 'g', user: { id: 'u' }, client: w.client, customId: id, message: { id: 'clicked', flags: { has: () => true } }, isMessageComponent: () => true, memberPermissions: { has: () => false }, update: async () => {}, reply: async () => {}, ...o });
    require('../utils/db').loadMatchProfile = async () => null; store.getGroup = async () => grp(); store.requestJoin = async () => ({ action: 'pending', group: grp() }); store.setAnnouncement = async () => {};
    await gf.handleInteraction(gi('minako-mm:g:join:5')); assert.deepEqual(sends.at(-1), ['actions', { track: { kind: 'join_req', ref: '5:u' } }]);                     // pedido rastreado
    store.groupGuildId = async () => 'g'; store.decideRequest = async () => ({ action: 'confirmed', group: grp() }); await gf.handleInteraction(gi('minako-mm:g:ap:5:u', { guildId: null, user: { id: 'org' } }));
    assert.ok(calls.some(c => c[0] === 'join_req' && c[1] === '5:u' && c[3] === 'clicked'));                                                                                // encerra nas outras mensagens, poupando a clicada
    store.getSettings = async () => settings; store.replacementDecision = async () => grp({ state: 'confirmed' }); calls.length = 0; await gf.handleInteraction(gi('minako-mm:g:rd:5:e', { user: { id: 'org' } })); assert.ok(calls.some(c => c[0] === 'repl' && c[1] === '5' && c[3] === 'clicked'));
    store.closeGroupById = async () => {}; calls.length = 0; await gf.handleInteraction(gi('minako-mm:g:close:5', { user: { id: 'org' } })); assert.ok(calls.some(c => c[0] === 'join_req' && c[1] === '5:' && c[2] === true) && calls.some(c => c[0] === 'repl'));
    store.leaveGroup = async () => ({ state: 'open', searchReplacement: false, group: grp() }); calls.length = 0; await gf.handleInteraction(gi('minako-mm:g:leave:5')); assert.ok(calls.some(c => c[0] === 'join_req' && c[1] === '5:u'));
    tstore.answerReservation = async () => ({ status: 'confirmed', group: grp() }); gf.refreshAfterChange = async () => grp(); gf.afterJoinNotices = async () => {}; calls.length = 0; await tf.handleInteraction(gi('minako-mm:team:yes:5', { guildId: null })); assert.ok(calls.some(c => c[0] === 'resv' && c[1] === '5:u' && c[3] === 'clicked'));
    tstore.sweepReservations = async () => [{ groupId: '5', guildId: 'g', userId: 'a', organizerId: 'org' }]; tstore.sweepTeamInvites = async () => []; gf.refreshAnnouncement = async () => {}; calls.length = 0; await tf.sweeps(w.client); assert.ok(calls.some(c => c[0] === 'resv' && c[1] === '5:a'));
    tstore.teamGuildId = async () => 'g'; tstore.respondInvite = async () => ({ status: 'active', team: { id: '3', name: 'T', ownerId: 'o', guildId: 'g' } }); calls.length = 0; await tf.handleInteraction(gi('minako-mm:team:ia:3', { guildId: null })); assert.ok(calls.some(c => c[0] === 'tinv' && c[1] === '3:u' && c[3] === 'clicked'));
    sstore.respondPartnership = async () => ({ status: 'active', partnership: {} }); sstore.getPartnership = async () => ({ id: '9', guildId: 'g', inviterId: 'a', userA: 'a', userB: 'u', status: 'active', expiresAt: Date.now() + 1000 }); calls.length = 0; await sf.handleInteraction(gi('minako-mm:soc:pa:9', { guildId: null })); assert.ok(calls.some(c => c[0] === 'pinv' && c[1] === '9' && c[3] === 'clicked'));
    notify.closeOps = realClose; notify.send = realSend;
  });
  await t('lembrete de expiração: rastreado ao enviar e encerrado ao renovar, encerrar ou expirar', async () => {
    const calls = []; const realClose = notify.closeOps; const realSend = notify.send; const sends = [];
    notify.closeOps = async (c, g, kind, ref) => { calls.push([kind, ref]); return 0; }; notify.send = async (c, g, u, cat, p, o) => { sends.push([cat, o]); return { sent: true }; };
    const w = world(); store.sweepExpiredProposals = async () => []; store.claimExpiryWarnings = async () => [{ guildId: 'g', userId: 'u', expiresAt: Date.now() + 600_000 }]; store.sweepExpiredAvailability = async () => [{ guildId: 'g', userId: 'x' }]; sstore.sweepExpiredInvites = async () => [];
    await engine.handleSweeps(w.client); assert.deepEqual(sends[0], ['expiry', { track: { kind: 'expw', ref: 'u' } }]); assert.deepEqual(calls.at(-1), ['expw', 'x']);
    store.getSettings = async () => settings; store.changeAvailability = async () => true; store.getAvailability = async () => ({ modeId: 'normal', status: 'active', expiresAt: Date.now() + 7200_000 }); calls.length = 0;
    await playFlow.handleInteraction({ guildId: null, user: { id: 'u' }, client: w.client, customId: 'minako-mm:av:renew:g', update: async () => {}, message: { id: 'clicked' } }); assert.deepEqual(calls[0], ['expw', 'u']);
    notify.closeOps = realClose; notify.send = realSend;
  });
  await t('migração 6: colunas e tabelas transitórias, reversível e só em minako_mm', () => {
    const m6 = schema.MIGRATIONS[5]; assert.equal(m6.version, 6);
    for (const re of [/ADD COLUMN IF NOT EXISTS quiet JSONB/, /ADD COLUMN IF NOT EXISTS paused_until/, /ADD COLUMN IF NOT EXISTS digest_last_at/, /CREATE TABLE IF NOT EXISTS minako_mm_op_messages/, /CREATE TABLE IF NOT EXISTS minako_mm_notice_queue/, /CREATE TABLE IF NOT EXISTS minako_mm_alert_state/]) assert.match(m6.up, re);
    for (const stmt of m6.down.replace(/DO \$\$[\s\S]*?\$\$;/g, '').split(';').map(x => x.trim()).filter(Boolean)) assert.match(stmt, /minako_mm_/);
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
