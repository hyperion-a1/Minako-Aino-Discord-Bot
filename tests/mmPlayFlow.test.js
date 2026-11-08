'use strict';
// Fluxo "Quero jogar agora", motor da fila e respostas a propostas, com discord.js/pg/banco SUBSTITUÍDOS por stubs.
const Module = require('node:module');
const assert = require('node:assert/strict');
const orig = Module._load;
const Builder = class { constructor() { return new Proxy(this, { get: (t, k) => (k in t ? t[k] : (...a) => { (t.calls ||= []).push([k, a]); if (k === 'setCustomId') t.customId = a[0]; if (k === 'setContent') t.content = a[0]; if (k === 'addComponents') (t.children ||= []).push(...a.flat()); if (k === 'addTextDisplayComponents') (t.texts ||= []).push(...a); if (k === 'addActionRowComponents') (t.rows ||= []).push(...a); if (k === 'setDisabled') t.disabled = a[0]; return t.proxy; }), set: (t, k, v) => { t[k] = v; return true; } }); } };
Module._load = function (req, ...rest) {
  if (req === 'discord.js') {
    const mk = () => class extends Builder { constructor() { super(); const p = super.constructor; } };
    const cls = () => { const C = class { constructor() { const self = this; this.calls = []; return new Proxy(this, { get(t, k) { if (k in t) return t[k]; return (...a) => { t.calls.push([k, a]); if (k === 'setCustomId') t.customId = a[0]; if (k === 'setContent') t.content = a[0]; if (k === 'addComponents') (t.children ||= []).push(...a.flat()); if (k === 'addTextDisplayComponents') (t.texts ||= []).push(...a); if (k === 'addActionRowComponents') (t.rows ||= []).push(...a); if (k === 'setDisabled') t.disabled = a[0]; return t.__self; }; }, set(t, k, v) { t[k] = v; return true; } }); } }; return class extends C { constructor() { const p = super(); p.__self = p; return p; } }; };
    return { ContainerBuilder: cls(), TextDisplayBuilder: cls(), SeparatorBuilder: cls(), ActionRowBuilder: cls(), ButtonBuilder: cls(), StringSelectMenuBuilder: cls(), ButtonStyle: { Success: 3, Primary: 1, Secondary: 2, Danger: 4 }, MessageFlags: { IsComponentsV2: 32768, Ephemeral: 64 } };
  }
  if (req === 'pg') return { Pool: class { on() {} } };
  return orig.call(this, req, ...rest);
};
const db = require('../utils/db');
const store = require('../utils/matchmaking/store');
const core = require('../utils/matchmaking/mmCore');
const engine = require('../utils/matchmaking/engine');
const central = require('../utils/matchmaking/central');
const flow = require('../utils/matchmaking/playFlow');
const realRunMatching = engine.runMatching;
const realNotifyOutcome = engine.notifyOutcome;

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
store.getPrefs = async () => core.normalizePrefs({}); store.recordDeliveryIssue = async () => {};
const cfg = () => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES, centralChannelId: 'c', centralMessageId: 'm' });

(async () => {
  await t('codificação de seleção é reversível e cabe no limite de 100 caracteres', () => {
    const s = { mode: 'ranqueada', roles: [0, 2, 4], voice: 'y' };
    const enc = flow.encodeSel(s); assert.deepEqual(flow.decodeSel(enc.split(':')), s);
    assert.ok(`minako-mm:play:ok:${enc}`.length <= 100);
    assert.deepEqual(flow.decodeSel(['normal', '-', 'x']), { mode: 'normal', roles: [], voice: 'a' });
  });
  await t('ID de modo é sanitizado (sem ":" que quebraria o customId)', () => {
    assert.equal(core.makeMode({ id: 'Rank:Solo!', idealSize: 5 }).id, 'ranksolo');
  });
  await t('confirmar disponibilidade usa a validade configurada e o elo do perfil', async () => {
    const calls = []; store.getSettings = async () => cfg(); db.loadMatchProfile = async () => ({ current_rank: 'ouro', routes: [] });
    store.setAvailability = async (...a) => { calls.push(a); }; store.getAvailability = async () => ({ modeId: 'ranqueada', status: 'active', expiresAt: Date.now() + 7200_000, roles: [] });
    central.requestRefresh = async () => {}; engine.runMatching = async () => 0;
    let updated = null; const i = { guildId: 'g', user: { id: 'u1' }, client: {}, customId: 'minako-mm:play:ok:ranqueada:0.2:y', update: async (p) => { updated = p; } };
    assert.equal(await flow.handleInteraction(i), true);
    assert.equal(calls[0][3], 7200); assert.equal(calls[0][2].elo, 'ouro'); assert.deepEqual(calls[0][2].roles, ['Rota Superior', 'Rota do Meio']); assert.equal(calls[0][2].voice, 'yes');
    assert.ok(updated.components && !updated.flags);
  });
  await t('modo com elo sem elo no perfil: não entra na fila', async () => {
    store.getSettings = async () => cfg(); db.loadMatchProfile = async () => null; let called = false; store.setAvailability = async () => { called = true; };
    const i = { guildId: 'g', user: { id: 'u1' }, client: {}, customId: 'minako-mm:play:ok:ranqueada:-:a', update: async () => {} };
    await flow.handleInteraction(i); assert.equal(called, false);
  });
  await t('disponibilidade: pausar/encerrar chamam o store e não mexem em notificações', async () => {
    const acts = []; store.getSettings = async () => cfg(); store.changeAvailability = async (g, u, a) => { acts.push(a); return true; }; store.getAvailability = async () => ({ modeId: 'normal', status: 'paused', expiresAt: Date.now() + 1000 });
    central.requestRefresh = async () => {};
    for (const a of ['pause', 'renew', 'end']) await flow.handleInteraction({ guildId: 'g', user: { id: 'u' }, client: {}, customId: `minako-mm:av:${a}`, update: async () => {} });
    assert.deepEqual(acts, ['pause', 'renew', 'end']);
  });
  engine.runMatching = realRunMatching;
  await t('motor: forma proposta e envia DM; DM fechada é registrada sem trocar de canal', async () => {
    const now = Date.now(); const av = (id) => ({ userId: id, modeId: 'normal', roles: [], elo: null, voice: null, status: 'active', since: now - 1000, waitingSince: now - 1000, expiresAt: now + 3600_000 });
    store.getSettings = async () => ({ ...cfg(), modes: [core.makeMode({ id: 'normal', idealSize: 2, minSize: 2 })] });
    store.listQueue = async () => [av('1'), av('2')]; store.blockedPairs = async () => new Set();
    store.createProposal = async () => '77';
    store.getProposal = async () => ({ id: '77', guildId: 'g', modeId: 'normal', incomplete: false, expiresAt: now + 120_000, members: [{ userId: '1' }, { userId: '2' }] });
    const sent = [], events = [], dms = [];
    store.setProposalDm = async (p, u, c, m) => dms.push(u); store.logEvent = async (g, type, payload) => events.push([type, payload.userId]);
    const client = { users: { fetch: async (id) => ({ send: async (p) => { if (id === '2') throw new Error('Cannot send messages to this user'); sent.push(id); return { id: 'dm' + id, channelId: 'ch' + id }; } }) }, channels: { fetch: async () => { throw new Error('não deve usar canal alternativo'); } } };
    assert.equal(await engine.runMatching(client, 'g', now), 1);
    assert.deepEqual(sent, ['1']); assert.deepEqual(dms, ['1']); assert.deepEqual(events, [['notify.delivery_failed', '2'], ['proposal.dm_failed', '2']]);
  });
  await t('motor: sem ao menos 2 na fila não cria proposta', async () => {
    store.getSettings = async () => cfg(); store.listQueue = async () => [{ userId: '1' }];
    assert.equal(await engine.runMatching({}, 'g'), 0);
  });
  await t('resposta à proposta: aceitar sem os demais mostra "aguardando"; recusar não penaliza', async () => {
    store.getSettings = async () => cfg(); store.proposalGuildId = async () => 'g';
    store.getProposal = async () => ({ id: '9', guildId: 'g', modeId: 'normal', incomplete: false, expiresAt: Date.now() + 60000, members: [{ userId: 'u' }, { userId: 'v' }] });
    store.respondProposal = async (g, p, u, ans) => (ans === 'accepted' ? { outcome: 'pending', final: false } : { outcome: 'declined', final: true, requeue: ['v'], declined: ['u'], proposalId: '9' });
    let shown = null; engine.notifyOutcome = async () => {}; central.requestRefresh = async () => {};
    const mk = (id) => ({ guildId: null, user: { id: 'u' }, client: {}, customId: id, update: async (p) => { shown = p.components[0].texts[0].content; } });
    await flow.handleInteraction(mk('minako-mm:prop:a:9')); assert.match(shown, /Aguardando os demais/);
    await flow.handleInteraction(mk('minako-mm:prop:d:9')); assert.match(shown, /sem penalidade/);
  });
  await t('IDs de outro módulo não são capturados', async () => {
    assert.equal(await flow.handleInteraction({ customId: 'minako-match:rank' }), false);
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
