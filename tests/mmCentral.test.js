'use strict';
// Testa a lógica da Central com discord.js/pg SUBSTITUÍDOS por stubs (não toca Discord nem banco).
const Module = require('node:module');
const assert = require('node:assert/strict');
const orig = Module._load;
class Chain { constructor() {} }
const chainProxy = () => new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : chainProxy()), apply: () => chainProxy() });
Module._load = function (req, ...rest) {
  if (req === 'discord.js') {
    const mk = () => class { constructor() { this.d = {}; } setAccentColor() { return this; } addTextDisplayComponents(t) { this.t = t; return this; } addSeparatorComponents() { return this; } addActionRowComponents() { return this; } addComponents() { return this; } setCustomId() { return this; } setLabel() { return this; } setEmoji() { return this; } setStyle() { return this; } setContent(c) { this.content = c; return this; } };
    return { ContainerBuilder: mk(), TextDisplayBuilder: mk(), SeparatorBuilder: mk(), ActionRowBuilder: mk(), ButtonBuilder: mk(), ButtonStyle: { Success: 3, Primary: 1, Secondary: 2 }, MessageFlags: { IsComponentsV2: 32768 } };
  }
  if (req === 'pg') return { Pool: class { on() {} } };
  return orig.call(this, req, ...rest);
};
const store = require('../utils/matchmaking/store');
const central = require('../utils/matchmaking/central');
const core = require('../utils/matchmaking/mmCore');

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
function world({ messageId = null, canSend = true } = {}) {
  const w = { cfgMessageId: messageId, sent: [], edited: 0, deleted: 0, claimWins: true, data: { availableNow: 0 }, messages: new Map() };
  const channel = {
    isTextBased: () => true, guild: { members: { me: {} } },
    permissionsFor: () => ({ has: () => canSend }),
    messages: { fetch: async (arg) => { w.fetches = (w.fetches || 0) + 1; const id = typeof arg === 'string' ? arg : arg.message; const m = w.messages.get(id); if (!m) { const e = new Error('Unknown Message'); e.code = 10008; throw e; } return m; } },
    send: async () => { const m = { id: `m${w.sent.length + 1}`, edit: async () => { w.edited++; }, delete: async () => { w.deleted++; } }; w.sent.push(m); w.messages.set(m.id, m); return m; },
  };
  if (messageId) w.messages.set(messageId, { id: messageId, edit: async () => { w.edited++; } });
  w.client = { channels: { fetch: async () => channel } };
  store.getSettings = async () => ({ settings: core.normalizeSettings({ centralMinRefreshSec: 10 }), modes: core.DEFAULT_MODES, centralChannelId: 'c1', centralMessageId: w.cfgMessageId });
  store.getCentralData = async () => w.data;
  store.claimCentralMessage = async (g, exp, id) => { if (!w.claimWins) return false; w.cfgMessageId = id; return true; };
  return w;
}
(async () => {
  await t('cria a Central uma única vez quando não existe', async () => {
    const w = world(); const r = await central.renderNow(w.client, 'g1');
    assert.equal(r.action, 'created'); assert.equal(w.sent.length, 1); assert.equal(w.cfgMessageId, 'm1');
  });
  await t('sem mudança de conteúdo não edita; com mudança edita a mensagem existente', async () => {
    const w = world(); await central.renderNow(w.client, 'g2');
    assert.equal((await central.renderNow(w.client, 'g2')).action, 'unchanged');
    w.data = { availableNow: 2 };
    assert.equal((await central.renderNow(w.client, 'g2')).action, 'edited'); assert.equal(w.edited, 1); assert.equal(w.sent.length, 1);
  });
  await t('mensagem apagada: recria exatamente uma', async () => {
    const w = world({ messageId: 'old' }); w.messages.delete('old');
    const r = await central.renderNow(w.client, 'g3');
    assert.equal(r.action, 'recreated'); assert.equal(w.sent.length, 1); assert.equal(w.cfgMessageId, 'm1');
  });
  await t('recriação concorrente perdida apaga a cópia e não duplica', async () => {
    const w = world({ messageId: 'old' }); w.messages.delete('old'); w.claimWins = false;
    const r = await central.renderNow(w.client, 'g4');
    assert.equal(r.action, 'already-recreated'); assert.equal(w.deleted, 1);
  });
  await t('permissão ausente é tratada sem exceção', async () => {
    const w = world({ canSend: false });
    assert.deepEqual(await central.renderNow(w.client, 'g5'), { ok: false, reason: 'PERMISSIONS' });
  });
  await t('atualizações em rajada são agrupadas pelo intervalo mínimo', async () => {
    const w = world(); await central.requestRefresh(w.client, 'g6', { force: true });
    w.data = { availableNow: 5 };
    await central.requestRefresh(w.client, 'g6'); await central.requestRefresh(w.client, 'g6');
    assert.equal(w.edited, 0); // dentro do intervalo: nada editado ainda (há um único temporizador pendente)
  });
  const unknown = () => Object.assign(new Error('Unknown Message'), { code: 10008 });
  await t('REGRESSÃO: a API ainda devolve a mensagem mas a edição falha com Unknown Message → recria', async () => {
    const w = world({ messageId: 'old' }); w.messages.get('old').edit = async () => { throw unknown(); }; w.data = { availableNow: 1 };
    const r = await central.renderNow(w.client, 'g7'); assert.equal(r.action, 'recreated'); assert.equal(w.sent.length, 1); assert.equal(w.cfgMessageId, 'm1');
  });
  await t('REGRESSÃO: conteúdo igual mas mensagem apagada é detectada na verificação periódica', async () => {
    const w = world(); const t0 = Date.now();
    assert.equal((await central.renderNow(w.client, 'g8', { now: t0 })).action, 'created');
    const f0 = w.fetches || 0;
    assert.equal((await central.renderNow(w.client, 'g8', { now: t0 + 10_000 })).action, 'unchanged'); assert.equal(w.fetches || 0, f0); // sem custo de API dentro do intervalo
    w.messages.delete('m1');                                                                            // alguém apaga a Central
    assert.equal((await central.renderNow(w.client, 'g8', { now: t0 + 61_000 })).action, 'recreated');
    assert.equal(w.sent.length, 2); assert.equal(w.cfgMessageId, 'm2');
  });
  await t('forçar (comando/painel) recria a Central apagada mesmo sem mudança de conteúdo', async () => {
    const w = world(); await central.renderNow(w.client, 'g9'); w.messages.delete('m1');
    assert.equal((await central.renderNow(w.client, 'g9', { force: true })).action, 'recreated'); assert.equal(w.sent.length, 2);
  });
  await t('requestRefresh({ force }) também recria (caminho usado por /minako-matchmaking central e painel)', async () => {
    const w = world(); await central.requestRefresh(w.client, 'g10', { force: true }); w.messages.delete('m1');
    await central.requestRefresh(w.client, 'g10', { force: true }); assert.equal(w.sent.length, 2);
  });
  await t('erro do Discord reconhecido por rawError.code e por 404', async () => {
    assert.ok(central.isUnknownMessage({ rawError: { code: 10008 } })); assert.ok(central.isUnknownMessage({ status: 404, message: 'Unknown Message' }));
    assert.ok(!central.isUnknownMessage({ code: 50013 }));
  });
  console.log(`\n${n} testes passaram.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
