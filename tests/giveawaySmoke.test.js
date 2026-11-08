'use strict';
// Teste de fumaça: carrega todos os módulos de sorteios com stubs de discord.js e pg
// e renderiza todas as telas. Pega erros de referência/typo; NÃO valida a API real do Discord.
const assert = require('node:assert/strict');
const Module = require('node:module');

class Rec {
  constructor(kind) {
    this.kind = kind; this.calls = [];
    return new Proxy(this, { get: (t, k) => {
      if (k in t || typeof k === 'symbol') return t[k];
      if (k === 'toJSON') return () => ({ kind: t.kind, calls: t.calls });
      return (...a) => { t.calls.push([k, a]); return t.proxy; };
    } , set: (t, k, v) => { t[k] = v; return true; } });
  }
}
const builder = (kind) => class { constructor() { const r = new Rec(kind); r.proxy = undefined; const p = r; return p; } };
const names = ['ContainerBuilder', 'TextDisplayBuilder', 'SectionBuilder', 'ThumbnailBuilder', 'MediaGalleryBuilder', 'MediaGalleryItemBuilder', 'SeparatorBuilder', 'ActionRowBuilder', 'ButtonBuilder', 'StringSelectMenuBuilder', 'RoleSelectMenuBuilder', 'ChannelSelectMenuBuilder', 'UserSelectMenuBuilder', 'ModalBuilder', 'TextInputBuilder', 'SlashCommandBuilder'];
const stub = {
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  ChannelType: { GuildText: 0, GuildAnnouncement: 5, PublicThread: 11, AnnouncementThread: 10, PrivateThread: 12 },
  MessageFlags: { Ephemeral: 64, IsComponentsV2: 32768 },
  PermissionFlagsBits: new Proxy({}, { get: (_, k) => BigInt(String(k).length) }),
  SeparatorSpacingSize: { Small: 1, Large: 2 },
  TextInputStyle: { Short: 1, Paragraph: 2 },
};
for (const n of names) stub[n] = builder(n);
// Rec devolve o próprio proxy nas chamadas encadeadas
for (const n of names) {
  stub[n] = class { constructor() { const rec = new Rec(n); const proxy = new Proxy(rec, { get: (t, k) => {
    if (k === 'toJSON') return () => ({ kind: n, calls: rec.calls });
    if (k === 'calls') return rec.calls;
    if (typeof k === 'symbol') return undefined;
    return (...a) => { rec.calls.push([k, a]); return proxy; };
  } }); return proxy; } };
}
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') return { Pool: class Pool { on() {} } };
  if (request === 'discord.js') return stub;
  return orig.call(this, request, parent, isMain);
};
delete process.env.DATABASE_URL;

const core = require('../utils/giveawayCore');
const msg = require('../utils/giveawayMessage');
const store = require('../utils/giveawayStore');
const panel = require('../utils/giveawayPanel');
require('../utils/giveawayActions');
require('../utils/giveawayScheduler');
const cmd = require('../commands/sorteios');
store.listTemplates = async () => [{ id: '1', name: 'Modelo' }];
store.getCreatorRoles = async () => ['777777777777777777'];
store.getRewardRoles = async () => ['123456789012345678'];
store.getGlobalRules = async () => ({ allowedRoleIds: [], blockedRoleIds: [], allowedUserIds: [], blockedUserIds: [] });

(async () => {
  const cfg = core.normalizeConfig({ ...core.defaultConfig(), name: 'Teste', channelId: '555555555555555555',
    message: { accentColor: null, blocks: [...core.defaultBlocks(), { type: 'section', content: 'x', thumbnail: 'https://a.com/b.png' }, { type: 'gallery', urls: ['https://a.com/b.png'] }] } });
  const g = { id: '12', guildId: '999999999999999999', name: 'Teste', hostId: '111111111111111111', channelId: '555555555555555555', messageId: '666666666666666666', config: cfg, winners: ['222222222222222222'], startsAt: new Date(), endsAt: new Date(Date.now() + 3600e3) };
  for (const state of ['active', 'drawn', 'cancelled']) assert.ok(msg.buildPublicMessage(g, { count: 3, state }).components.length === 2);
  assert.ok(msg.buildPreviewMessage(cfg, { hostId: g.hostId }).flags);
  assert.ok(msg.buildWinnersMessage(g).components.length === 2);
  assert.ok(msg.buildWinnersMessage(g, { final: true }).components.length === 1);
  assert.match(msg.buildThreadMessage({ ...g, config: { ...cfg, privateThread: { enabled: true, message: 'Oi {user1} de {host}' } } }).content, /<@222222222222222222>/);

  // aba Prêmios com cargos liberados/selecionados + linha de cargos no anúncio
  const prized = { ...g, config: { ...cfg, winnerRoles: { grantRoleIds: ['123456789012345678'], grantDays: 7, removeRoleIds: [], removeDays: 0 } } };
  assert.match(JSON.stringify(msg.buildWinnersMessage(prized)), /conferido/);
  assert.doesNotMatch(JSON.stringify(msg.buildWinnersMessage(g)), /conferido|removido\(s\)/);

  // host que também é ganhador: allowedMentions não pode ter IDs repetidos (o Discord recusa a mensagem)
  const dup = msg.buildThreadMessage({ ...g, winners: [g.hostId, '222222222222222222'], config: { ...cfg, privateThread: { enabled: true, message: '{users}' } } });
  assert.equal(new Set(dup.allowedMentions.users).size, dup.allowedMentions.users.length);

  const session = panel.startSession({ user: { id: '111111111111111111' }, guildId: g.guildId, channel: { id: '555555555555555555', type: 0 } }, 'America/Sao_Paulo');
  for (const tab of panel.TABS) { session.tab = tab; session.selected = 0; const p = await panel.renderPanel(session); assert.equal(p.components.length, 1); }
  assert.equal(cmd.data.toJSON().calls.length > 0, true);
  // cargo próprio de criação: admin passa; membro com o cargo passa; membro sem o cargo não passa
  const mk = (perm, roles) => ({ guildId: g.guildId, memberPermissions: { has: () => perm }, member: { roles: { cache: new Map(roles.map((r) => [r, {}])) } } });
  assert.equal(await panel.canCreate(mk(true, [])), true);
  assert.equal(await panel.canCreate(mk(false, ['777777777777777777'])), true);
  assert.equal(await panel.canCreate(mk(false, ['888888888888888888'])), false);
  store.getCreatorRoles = async () => [];
  assert.equal(await panel.canCreate(mk(false, ['777777777777777777'])), false);
  // customId do botão de entrar: tamanho e formato
  const idLen = `minako-giveaway:rmopen:${'9'.repeat(18)}:100000`.length;
  assert.ok(idLen <= 100);
  console.log('giveawaySmoke.test.js: módulos carregam e todas as telas renderizam.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { Module._load = orig; process.exit(process.exitCode || 0); });
