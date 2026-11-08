'use strict';
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const store = require('../utils/matchmaking/store');
const core = require('../utils/matchmaking/mmCore');
const central = require('../utils/matchmaking/central');
const perms = require('../utils/matchmaking/permissions');
const panel = require('../utils/matchmaking/configPanel');
const mm = require('../utils/matchmaking');
const { textOf, buttonsOf } = stubs;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

let cfg; const saved = [];
const fresh = () => ({ settings: core.normalizeSettings({ reviewChannelId: '1557770673819222137', reviewRoleId: '1244300508034760776' }), modes: core.DEFAULT_MODES.map(m => ({ ...m })), roleIds: {}, centralChannelId: null, groupsChannelId: null, topicsParentId: null });
store.getSettings = async () => cfg; store.saveSettingsPatch = async (g, p) => { saved.push(p); return cfg; };
let refreshes = 0; central.requestRefresh = async () => { refreshes++; };
const fields = (o) => ({ getTextInputValue: (k) => o[k] });
const mk = (id, o = {}) => ({ guildId: 'g', user: { id: 'u1' }, customId: id, client: {}, memberPermissions: { has: (p) => p === 32n || p === 8n }, member: { roles: { cache: { has: () => false } } },
  isMessageComponent: () => true, values: [], update: async (p) => { mk.last = textOf(p); }, reply: async (p) => { mk.last = p.content ?? textOf(p); }, showModal: async (m) => { mk.modal = m; }, ...o });

(async () => {
  await t('canais: mostra o configurado e o canal/cargo de revisão informados', async () => {
    cfg = fresh(); cfg.centralChannelId = '111111111111111111';
    const txt = textOf(panel.render('canais', cfg, 'u1')); assert.match(txt, /<#111111111111111111>/); assert.match(txt, /Revisão de partidas:\*\* <#1557770673819222137>/);
    assert.match(textOf(panel.render('papeis', cfg, 'u1')), /<@&1244300508034760776>/);
  });
  await t('painel é privado: outra pessoa é bloqueada; sem Gerenciar Servidor é negado', async () => {
    cfg = fresh(); saved.length = 0;
    await panel.handleInteraction(mk('minako-mm:cfg:sec:otheruser', { values: ['prazos'] })); assert.match(mk.last, /pertence a outra pessoa/);
    await panel.handleInteraction(mk('minako-mm:cfg:ch-groups:u1', { values: ['5'], memberPermissions: { has: () => false } })); assert.match(mk.last, /não tem mais permissão/); assert.equal(saved.length, 0);
  });
  await t('canal da Central salvo (e Central atualizada); limpar seleção remove o canal', async () => {
    cfg = fresh(); saved.length = 0; refreshes = 0;
    await panel.handleInteraction(mk('minako-mm:cfg:ch-central:u1', { values: ['222222222222222222'] }));
    assert.deepEqual(saved[0], { centralChannelId: '222222222222222222' }); assert.equal(refreshes, 1);
    await panel.handleInteraction(mk('minako-mm:cfg:ch-groups:u1', { values: [] })); assert.deepEqual(saved[1], { groupsChannelId: null });
  });
  await t('canal e cargo de revisão são configuráveis separadamente', async () => {
    cfg = fresh(); saved.length = 0;
    await panel.handleInteraction(mk('minako-mm:cfg:ch-review:u1', { values: ['333333333333333333'] })); assert.deepEqual(saved[0], { settings: { reviewChannelId: '333333333333333333' } });
    await panel.handleInteraction(mk('minako-mm:cfg:rl-reviewer:u1', { values: ['444444444444444444'] })); assert.deepEqual(saved[1], { settings: { reviewRoleId: '444444444444444444' } });
    await panel.handleInteraction(mk('minako-mm:cfg:rl-moderation:u1', { values: ['5', '5', '6'] })); assert.deepEqual(saved[2], { roleIds: { moderation: ['5', '6'] } });
  });
  await t('prazos: modal valida e salva; valor inválido não grava e explica', async () => {
    cfg = fresh(); saved.length = 0;
    await panel.handleInteraction(mk('minako-mm:cfg:prazos:u1')); assert.ok(mk.modal);
    const ok = { proposta: '3', disponibilidade: '90', substituto: '10', janela: '12', arquivo: '5' };
    await panel.handleInteraction(mk('minako-mm:cfg:prazos-modal:u1', { fields: fields(ok), isMessageComponent: () => false }));
    assert.deepEqual(saved[0].settings, { proposalTtlSec: 180, availabilityTtlSec: 5400, replacementTtlSec: 600, confirmationWindowSec: 43200, archiveAfterSec: 432000 });
    await panel.handleInteraction(mk('minako-mm:cfg:prazos-modal:u1', { fields: fields({ ...ok, janela: '9999' }) })); assert.match(mk.last, /Confirmação da partida/); assert.equal(saved.length, 1);
  });
  await t('modos: novo, editar, e não deixa desativar o último modo ativo', async () => {
    cfg = fresh(); saved.length = 0;
    await panel.handleInteraction(mk('minako-mm:cfg:mode-modal:u1:new', { fields: fields({ label: 'Torneio', ideal: '5', min: '5', incomplete: 'não', elo: '1' }) }));
    assert.equal(saved[0].modes.length, 4); assert.equal(saved[0].modes[3].id, 'torneio'); assert.ok(saved[0].modes[3].eloRelevant);
    cfg.modes = cfg.modes.map(m => ({ ...m, active: m.id === 'casual' })); saved.length = 0;
    await panel.handleInteraction(mk('minako-mm:cfg:mode-toggle:u1:casual')); assert.match(mk.last, /Pelo menos um modo/); assert.equal(saved.length, 0);
  });
  await t('catálogo de funções salvo; entrada vazia é recusada', async () => {
    cfg = fresh(); saved.length = 0;
    await panel.handleInteraction(mk('minako-mm:cfg:roles-modal:u1', { fields: fields({ lista: 'Selva\nApoio' }) })); assert.deepEqual(saved[0].settings.roleCatalog, ['Selva', 'Apoio']);
    await panel.handleInteraction(mk('minako-mm:cfg:roles-modal:u1', { fields: fields({ lista: '' }) })); assert.match(mk.last, /pelo menos uma/); assert.equal(saved.length, 1);
  });
  await t('diagnóstico lista o que falta e as permissões do bot', async () => {
    cfg = fresh(); cfg.centralChannelId = 'c1'; cfg.topicsParentId = 't1';
    store.getDiagnostics = async () => ({ schemaVersion: 1, availableNow: 2, openGroups: 1, confirmedGroups: 0, pendingProposals: 0, matchesInReview: 1, failuresLast24h: 3 });
    const chan = (miss) => ({ permissionsFor: () => ({ has: (p) => !miss.includes(p) }) });
    const guild = { channels: { cache: new Map([['c1', chan([])], ['t1', chan(['CreatePrivateThreads'])]]) }, members: { me: {} } };
    await panel.handleInteraction(mk('minako-mm:cfg:check:u1', { guild }));
    assert.match(mk.last, /Grupos abertos: não configurado/); assert.match(mk.last, /falta CreatePrivateThreads/); assert.match(mk.last, /1 em revisão/); assert.match(mk.last, /Falhas operacionais \(24 h\):\*\* 3/);
  });
  await t('permissões: Administrator tudo; papéis configurados; sem papel, nada', async () => {
    cfg = fresh(); cfg.roleIds = { management: ['m1'], moderation: ['mod1'], maintenance: ['mt1'] };
    const who = (roleIds, admin = false, manageGuild = false) => ({ guildId: 'g', memberPermissions: { has: (p) => (p === 8n ? admin : p === 32n ? manageGuild : false) }, member: { roles: { cache: { has: (id) => roleIds.includes(id) } } } });
    assert.ok(await perms.can(who([], true), 'maintenance')); assert.ok(await perms.can(who(['mod1']), 'group.manage')); assert.ok(!(await perms.can(who(['mod1']), 'maintenance')));
    assert.ok(await perms.can(who(['mt1']), 'maintenance')); assert.ok(!(await perms.can(who(['mt1']), 'group.manage'))); assert.ok(await perms.can(who(['1244300508034760776']), 'match.review'));
    assert.ok(await perms.can(who(['m1']), 'match.review')); assert.ok(!(await perms.can(who([]), 'group.manage'))); assert.ok(await perms.can(who([], false, true), 'config')); assert.ok(!(await perms.can(who(['m1']), 'config')));
  });
  await t('roteador do módulo: cfg, Meu perfil e IDs de outros módulos', async () => {
    cfg = fresh(); let opened = false;
    assert.equal(mm.isMatchmakingId('minako-mm:play'), true); assert.equal(mm.isMatchmakingId('minako-match:rank'), false);
    assert.equal(await mm.handleInteraction(mk('minako-mm:profile'), { openProfile: async () => { opened = true; } }), true); assert.ok(opened);
    assert.equal(await mm.handleInteraction(mk('minako-mm:cfg:sec:u1', { values: ['prazos'] })), true); assert.match(mk.last, /Prazos e busca/);
    assert.equal(await mm.handleInteraction(mk('minako-config:modulo:u1')), false);
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
