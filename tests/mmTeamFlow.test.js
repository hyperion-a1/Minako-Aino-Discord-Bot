'use strict';
const stubs = require('./helpers/discordStubs'); stubs.install();
const assert = require('node:assert/strict');
const store = require('../utils/matchmaking/store');
const tstore = require('../utils/matchmaking/teamStore');
const core = require('../utils/matchmaking/mmCore');
const central = require('../utils/matchmaking/central');
const teams = require('../utils/matchmaking/teams');
const groupFlow = require('../utils/matchmaking/groupFlow');
const view = require('../utils/matchmaking/groupView');
const tf = require('../utils/matchmaking/teamFlow');
const mm = require('../utils/matchmaking');
const schema = require('../utils/matchmaking/schema');
const backup = require('../utils/matchmaking/backupFormat');
const { textOf, buttonsOf } = stubs;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const E = (code, message) => Object.assign(new Error(message || teams.TEAM_ERRORS[code] || code), { code });
central.requestRefresh = async () => {};
const P = () => ({ ...core.normalizePrefs({}), deliveryIssue: null }); store.getPrefs = async () => P(); const issues = []; store.recordDeliveryIssue = async (g, u, c, v) => issues.push([u, c, v]);
const events = []; store.logEvent = async (g, type) => events.push(type);
const cfg = (o = {}) => ({ settings: core.normalizeSettings({}), modes: core.DEFAULT_MODES, groupsChannelId: 'gc', topicsParentId: 'tp', ...o }); store.getSettings = async () => cfg();
function world({ dmFail = [] } = {}) {
  const w = { dms: [], edits: [] };
  w.client = { users: { fetch: async (id) => ({ send: async (p) => { if (dmFail.includes(id)) throw new Error('Cannot send messages to this user'); w.dms.push([id, textOf(p), p]); return { id: 'm' + id, channelId: 'c' + id }; },
    createDM: async () => ({ messages: { fetch: async () => ({ edit: async (p) => { w.edits.push(textOf(p)); } }) } }) }) } };
  return w;
}
const inter = (w, id, o = {}) => ({ guildId: 'g', user: { id: 'me' }, client: w.client, customId: id, values: [], users: new Map([['bot1', { bot: true }]]), guild: { members: { fetch: async (i) => ({ displayName: `N${i}` }) } },
  isMessageComponent: () => true, update: async (p) => { w.shown = textOf(p); w.payload = p; }, reply: async (p) => { w.shown = p.content ?? textOf(p); w.payload = p; }, showModal: async (m) => { w.modal = m; }, ...o });
const detail = (o = {}) => ({ id: '3', guildId: 'g', name: 'Os Lendários', ownerId: 'me', status: 'active', liveGroupId: null, members: [{ userId: 'me', status: 'active' }, { userId: 'a', status: 'active' }, { userId: 'i', status: 'invited', expiresAt: Date.now() + 1000 }], ...o });
const ids = (payload) => (payload.components[0].rows || []).flatMap(r => r.children || []).map(c => c.customId);

(async () => {
  await t('painel principal: explica que ser da equipe não é ficar disponível; lista equipes, convites e permite criar', () => {
    const p = tf.mainPanel({ teams: [{ id: '3', name: 'Os Lendários', ownerId: 'me', activeCount: 2, isOwner: true }], invites: [{ teamId: '9', name: 'Time Beta', invitedBy: 'x' }] });
    const txt = textOf(p); assert.match(txt, /não é ficar disponível/); assert.match(txt, /nunca gera penalidade/); assert.match(txt, /Dupla/); assert.match(txt, /você lidera/); assert.match(txt, /Time Beta\*\* \(de <@x>\)/);
    for (const id of ['minako-mm:team:view', 'minako-mm:team:new', 'minako-mm:team:ia:9', 'minako-mm:team:id:9']) assert.ok(ids(p).includes(id), id);
    assert.match(textOf(tf.mainPanel({ teams: [], invites: [] })), /ainda não está em nenhuma equipe/);
  });
  await t('detalhe: dono vê convidar/remover/dissolver; membro comum só procurar partida e sair; sessão ativa esconde "procurar"', () => {
    const owner = ids(tf.detailPanel(detail(), 'me')); for (const id of ['minako-mm:team:invite:3', 'minako-mm:team:remove:3', 'minako-mm:team:disband:3', 'minako-mm:team:play:3', 'minako-mm:team:leave:3']) assert.ok(owner.includes(id), id);
    const member = ids(tf.detailPanel(detail({ ownerId: 'a' }), 'me')); assert.ok(member.includes('minako-mm:team:play:3') && member.includes('minako-mm:team:leave:3')); assert.ok(!member.includes('minako-mm:team:disband:3') && !member.includes('minako-mm:team:invite:3'));
    assert.ok(!ids(tf.detailPanel(detail({ liveGroupId: '12' }), 'me')).includes('minako-mm:team:play:3')); assert.match(textOf(tf.detailPanel(detail({ liveGroupId: '12' }), 'me')), /grupo \*\*#12\*\*/);
    assert.match(textOf(tf.detailPanel(detail(), 'me')), /Dupla/);
  });
  await t('criar equipe: abre formulário; nome válido cria; nome inválido/repetido mostra o motivo sem criar', async () => {
    const w = world(); await mm.handleInteraction(inter(w, 'minako-mm:team:new')); assert.ok(w.modal);
    tstore.createTeam = async (g, u, name) => { if (name === 'x') throw E('NAME_LENGTH'); return { id: '3', name }; }; tstore.getTeamDetail = async () => detail();
    await mm.handleInteraction(inter(w, 'minako-mm:team:new-modal', { fields: { getTextInputValue: () => 'Os Lendários' } })); assert.match(w.shown, /Equipe \*\*Os Lendários\*\* criada/);
    await mm.handleInteraction(inter(w, 'minako-mm:team:new-modal', { fields: { getTextInputValue: () => 'x' } })); assert.match(w.shown, /3 a 30 caracteres/);
  });
  await t('convite a membro: DM com Aceitar/Recusar sem pressão; DM fechada orienta e não troca de canal', async () => {
    const w = world(); tstore.inviteMember = async () => ({ team: { id: '3', name: 'Os Lendários', ownerId: 'me' } }); tstore.getInvite = async () => ({ expiresAt: Date.now() + 86400_000 }); tstore.setInviteDm = async () => {};
    tstore.getTeamDetail = async () => detail(); await mm.handleInteraction(inter(w, 'minako-mm:team:invite:3', { values: ['u'] }));
    assert.equal(w.dms[0][0], 'u'); assert.match(w.dms[0][1], /não\*\* obriga você a jogar/); assert.match(w.dms[0][1], /sem penalidade/); assert.deepEqual(buttonsOf(w.dms[0][2]).map(b => b.customId), ['minako-mm:team:ia:3', 'minako-mm:team:id:3']); assert.match(w.shown, /Recusas não são comunicadas/);
    const w2 = world({ dmFail: ['u'] }); issues.length = 0; await mm.handleInteraction(inter(w2, 'minako-mm:team:invite:3', { values: ['u'] })); assert.match(w2.shown, /Minhas equipes/); assert.match(w2.shown, /Não uso outro canal/); assert.deepEqual(issues, [['u', 'actions', 'dm']]);
  });
  await t('erros de convite são claros (só o dono, equipe cheia, bot)', async () => {
    const w = world(); tstore.getTeamDetail = async () => detail();
    for (const code of ['NOT_OWNER', 'TEAM_FULL', 'COOLDOWN']) { tstore.inviteMember = async () => { throw E(code); }; await mm.handleInteraction(inter(w, 'minako-mm:team:invite:3', { values: ['u'] })); assert.match(w.shown, new RegExp(teams.TEAM_ERRORS[code].slice(0, 15))); }
    assert.equal(w.dms.length, 0);
  });
  await t('aceitar convite pela DM (sem guildId): avisa o dono; recusar NÃO avisa ninguém', async () => {
    const w = world(); tstore.teamGuildId = async () => 'g'; const team = { id: '3', name: 'Os Lendários', ownerId: 'o', guildId: 'g' };
    tstore.respondInvite = async (id, u, acc) => ({ status: acc ? 'active' : 'declined', team });
    await mm.handleInteraction(inter(w, 'minako-mm:team:ia:3', { guildId: null })); assert.match(w.shown, /faz parte da equipe/); assert.equal(w.dms.filter(d => d[0] === 'o').length, 1); assert.match(w.dms[0][1], /entrou na sua equipe/);
    w.dms.length = 0; await mm.handleInteraction(inter(w, 'minako-mm:team:id:3', { guildId: null })); assert.match(w.shown, /sem problema nenhum/); assert.equal(w.dms.length, 0);
  });
  await t('sair da equipe: dono passa a liderança; último dissolve; sem penalidade', async () => {
    const w = world(); tstore.listMyTeams = async () => ({ teams: [], invites: [] });
    for (const [res, re] of [[{ action: 'transfer', newOwnerId: 'a' }, /liderança passou para <@a>/], [{ action: 'disband' }, /dissolvida/], [{ action: 'leave' }, /Sem penalidade/]]) { tstore.leaveTeam = async () => ({ ...res, team: {} }); await mm.handleInteraction(inter(w, 'minako-mm:team:leave:3')); assert.match(w.shown, re); }
  });
  await t('dissolver exige confirmação; o dono dissolve; outra pessoa é recusada', async () => {
    const w = world(); await mm.handleInteraction(inter(w, 'minako-mm:team:disband:3')); assert.match(w.shown, /Isso encerra a equipe/); assert.ok(ids(w.payload).includes('minako-mm:team:disband-ok:3'));
    tstore.listMyTeams = async () => ({ teams: [], invites: [] }); tstore.disbandTeam = async () => ({}); await mm.handleInteraction(inter(w, 'minako-mm:team:disband-ok:3')); assert.match(w.shown, /Equipe dissolvida/);
    tstore.disbandTeam = async () => { throw E('NOT_OWNER'); }; await mm.handleInteraction(inter(w, 'minako-mm:team:disband-ok:3')); assert.match(w.shown, /Apenas o dono/);
  });
  await t('painel de sessão: só modos que comportam a equipe; escolhas ficam no customId', () => {
    const d = detail({ members: [1, 2, 3, 4, 5, 6].slice(0, 3).map(i => ({ userId: 'u' + i, status: 'active' })) });
    const panel = tf.sessionPanel(d, { modes: [core.makeMode({ id: 'duo', label: 'Dupla', idealSize: 2, minSize: 2 }), core.makeMode({ id: 'norm', label: 'Normal', idealSize: 5, minSize: 2 })] }, { mode: null, jm: 'a' });
    assert.match(textOf(panel), /Modo:\*\* Normal/); assert.ok(ids(panel).includes('minako-mm:team:go:3:norm:a')); assert.doesNotMatch(textOf(panel), /Dupla \(2/);
    assert.match(textOf(tf.sessionPanel(detail({ members: Array.from({ length: 5 }, (_, i) => ({ userId: 'u' + i, status: 'active' })) }), { modes: [core.makeMode({ id: 'duo', label: 'Dupla', idealSize: 2, minSize: 2 })] }, {})), /Nenhum modo ativo comporta 5/);
  });
  const sess = () => ({ groupId: '12', reserveIds: ['a', 'b'], skippedBusy: [], team: { id: '3', name: 'Os Lendários' }, group: { id: '12', modeId: 'normal', organizerId: 'me', state: 'open', capacity: 5, confirmed: 1, reserved: 2, free: 2, members: [{ userId: 'me' }], joinMethod: 'approval', teamId: '3', teamName: 'Os Lendários' } });
  await t('iniciar sessão: anuncia UMA vez, convida só os outros membros (não o iniciador) e informa as vagas realmente abertas', async () => {
    const w = world(); let args = null; let announced = 0; tstore.startSession = async (g, id, uid, o) => { args = [id, uid, o.mode.id, o.joinMethod, o.reserveTtlSec]; return sess(); };
    groupFlow.publishAnnouncement = async (c, g) => { announced++; assert.equal(g.teamName, 'Os Lendários'); };
    await mm.handleInteraction(inter(w, 'minako-mm:team:go:3:normal:a')); assert.deepEqual(args, ['3', 'me', 'normal', 'approval', 600]); assert.equal(announced, 1);
    assert.deepEqual(w.dms.map(d => d[0]).sort(), ['a', 'b']); assert.match(w.dms[0][1], /Você vem nesta sessão/); assert.match(w.dms[0][1], /não tem penalidade/); assert.deepEqual(buttonsOf(w.dms[0][2]).map(b => b.customId), ['minako-mm:team:yes:12', 'minako-mm:team:no:12']);
    assert.match(w.shown, /Vagas abertas ao público agora: \*\*2\*\*/); assert.match(w.shown, /10 min para confirmar/);
  });
  await t('iniciar sessão: avisa membros ocupados e os que a DM não alcançou; sem canal de grupos nada é criado', async () => {
    const w = world({ dmFail: ['b'] }); tstore.startSession = async () => ({ ...sess(), skippedBusy: ['c'] }); groupFlow.publishAnnouncement = async () => {};
    await mm.handleInteraction(inter(w, 'minako-mm:team:go:3:normal:d')); assert.match(w.shown, /<@c> já está\(ão\) em outro grupo/); assert.match(w.shown, /1 membro\(s\) não puderam ser avisados/);
    let called = false; tstore.startSession = async () => { called = true; return sess(); }; store.getSettings = async () => cfg({ groupsChannelId: null });
    await mm.handleInteraction(inter(w, 'minako-mm:team:go:3:normal:a')); assert.equal(called, false); assert.match(w.shown, /não configurou o canal de grupos/); store.getSettings = async () => cfg();
  });
  await t('iniciar sessão: erros amigáveis (equipe maior que o modo, sessão já em andamento)', async () => {
    const w = world();
    for (const code of ['TEAM_TOO_BIG', 'SESSION_LIVE', 'STARTER_BUSY']) { tstore.startSession = async () => { throw E(code); }; await mm.handleInteraction(inter(w, 'minako-mm:team:go:3:normal:a')); assert.match(w.shown, new RegExp(teams.TEAM_ERRORS[code].slice(0, 15))); }
  });
  const grp = (o = {}) => ({ id: '12', modeId: 'normal', organizerId: 'org', state: 'open', teamName: 'Os Lendários', confirmed: 2, reserved: 1, free: 2, capacity: 5, threadId: null, ...o });
  await t('"Eu vou": confirma, atualiza anúncio/tópico e avisa; funciona pela DM (sem guildId)', async () => {
    const w = world(); store.groupGuildId = async () => 'g'; let refreshed = 0; let notices = 0;
    tstore.answerReservation = async () => ({ status: 'confirmed', group: grp() }); groupFlow.refreshAfterChange = async () => { refreshed++; return grp({ confirmed: 3 }); }; groupFlow.afterJoinNotices = async () => { notices++; };
    await mm.handleInteraction(inter(w, 'minako-mm:team:yes:12', { guildId: null })); assert.match(w.shown, /Confirmado/); assert.equal(refreshed, 1); assert.equal(notices, 1);
  });
  await t('"Não posso agora": libera a vaga, avisa o organizador sem culpar e não gera penalidade', async () => {
    const w = world(); store.groupGuildId = async () => 'g'; tstore.answerReservation = async () => ({ status: 'declined', group: grp() }); groupFlow.refreshAfterChange = async () => grp();
    await mm.handleInteraction(inter(w, 'minako-mm:team:no:12', { guildId: null })); assert.match(w.shown, /Sem penalidade/); assert.equal(w.dms[0][0], 'org'); assert.match(w.dms[0][1], /vaga já está aberta ao público/);
  });
  await t('reserva vencida/sessão encerrada/compromisso incompatível: mensagens claras, nada é confirmado', async () => {
    const w = world(); store.groupGuildId = async () => 'g';
    for (const [res, re] of [[{ stale: 'expired', group: grp() }, /vaga já foi preenchida/], [{ stale: 'closed', group: grp() }, /não está mais recebendo/], [{ stale: 'already', group: grp() }, /já confirmou/]]) { tstore.answerReservation = async () => res; await mm.handleInteraction(inter(w, 'minako-mm:team:yes:12', { guildId: null })); assert.match(w.shown, re); }
    tstore.answerReservation = async () => { throw E('INCOMPATIBLE_COMMITMENT', 'Você já está em outro grupo ativo.'); }; await mm.handleInteraction(inter(w, 'minako-mm:team:yes:12', { guildId: null })); assert.match(w.shown, /outro grupo ativo/);
  });
  await t('agendador: reservas vencidas reabrem a vaga (anúncio atualizado) e o organizador é avisado UMA vez por sessão; convites vencidos têm a DM atualizada', async () => {
    const w = world(); const refreshed = []; groupFlow.refreshAnnouncement = async (c, g, id) => { refreshed.push(id); };
    tstore.sweepReservations = async () => [{ groupId: '12', guildId: 'g', userId: 'a', organizerId: 'org' }, { groupId: '12', guildId: 'g', userId: 'b', organizerId: 'org' }];
    tstore.sweepTeamInvites = async () => [{ teamId: '3', userId: 'x', dmMessageId: 'm1', invitedBy: 'o' }, { teamId: '4', userId: 'y', dmMessageId: null, invitedBy: 'o' }];
    await tf.sweeps(w.client); assert.deepEqual(refreshed, ['12']); assert.equal(w.dms.length, 1); assert.match(w.dms[0][1], /<@a>, <@b> não confirmou/); assert.match(w.dms[0][1], /Sem penalidade/); assert.equal(w.edits.length, 1); assert.match(w.edits[0], /expirou/);
  });
  await t('anúncio da sessão da equipe: nome, membros ainda confirmando e só as vagas realmente abertas', () => {
    const txt = view.renderAnnouncement({ id: '12', state: 'open', organizerId: 'o', capacity: 5, confirmed: 1, reserved: 2, free: 2, joinMethod: 'approval', members: [{ userId: 'o' }], pending: [], requiredRoles: [], teamName: 'Os Lendários', teamId: '3' }, 'Normal');
    assert.match(txt, /Equipe:\*\* Os Lendários \(#3\)/); assert.match(txt, /2 membros da equipe ainda confirmando/); assert.match(txt, /1\/5 confirmados · \*\*2\*\* livres/);
    assert.doesNotMatch(view.renderAnnouncement({ id: '1', state: 'open', organizerId: 'o', capacity: 3, confirmed: 1, reserved: 0, free: 2, joinMethod: 'direct', members: [{ userId: 'o' }], pending: [], requiredRoles: [] }, 'N'), /Equipe:/);
  });
  await t('botão Entrar fica ativo enquanto houver reserva (o membro precisa confirmar), mesmo com 0 vagas abertas', () => {
    const g = { id: '12', state: 'open', organizerId: 'o', capacity: 3, confirmed: 1, reserved: 2, free: 0, joinMethod: 'approval', members: [{ userId: 'o' }], pending: [], requiredRoles: [] };
    assert.notEqual(groupFlow.announcementPayload(g, 'N').components[0].rows[0].children[0].disabled, true);
    assert.equal(groupFlow.announcementPayload({ ...g, reserved: 0 }, 'N').components[0].rows[0].children[0].disabled, true);
  });
  await t('Central ganhou "Minhas equipes" (5 botões) e o layout muda para forçar uma edição única', () => {
    assert.deepEqual(central.CENTRAL_BUTTONS.map(b => b[0]), ['minako-mm:play', 'minako-mm:groups', 'minako-mm:create', 'minako-mm:team', 'minako-mm:prefs']);
  });
  await t('migração 4: tabelas, índices únicos (nome ativo e uma sessão ativa por equipe) e reversão só em minako_mm', () => {
    const m4 = schema.MIGRATIONS[3]; assert.equal(m4.version, 4);
    for (const re of [/CREATE TABLE IF NOT EXISTS minako_mm_teams/, /CREATE TABLE IF NOT EXISTS minako_mm_team_members/, /minako_mm_teams_name_uq[^;]*WHERE status = 'active'/, /minako_mm_groups_team_live_uq[^;]*WHERE team_id IS NOT NULL/, /ADD COLUMN IF NOT EXISTS reserved_until/, /'reserved'\)\)/]) assert.match(m4.up, re);
    assert.match(m4.down, /DELETE FROM minako_mm_group_members WHERE status = 'reserved'/); assert.match(m4.down, /DROP TABLE IF EXISTS minako_mm_teams/);
    for (const stmt of m4.down.replace(/DO \$\$[\s\S]*?\$\$;/g, '').split(';').map(x => x.trim()).filter(Boolean)) assert.match(stmt, /minako_mm_/);
  });
  await t('backup/restauração: equipes entram na ordem certa (equipes antes de grupos ao inserir; grupos antes de equipes ao apagar)', () => {
    const base = Object.fromEntries(backup.INSERT_ORDER.filter(x => !['minako_mm_prefs', 'minako_mm_favorites', 'minako_mm_partnerships', 'minako_mm_notice_log', 'minako_mm_teams', 'minako_mm_team_members'].includes(x)).map(x => [x, []]));
    assert.ok(backup.validateBackup({ schema: backup.FORMAT, guildId: 'g', tables: base }, 'g'));   // backups antigos continuam válidos
    const plan = backup.buildRestorePlan({ schema: backup.FORMAT, guildId: 'g', tables: { ...base, minako_mm_teams: [{ id: 3, guild_id: 'g', name: 'X' }], minako_mm_team_members: [{ team_id: 3, user_id: 'u', status: 'active' }], minako_mm_groups: [{ id: 1, guild_id: 'g', team_id: 3 }] } }, 'g');
    const at = (tb, kind) => plan.steps.findIndex(s => s.table === tb && s.sql.startsWith(kind));
    assert.ok(at('minako_mm_teams', 'INSERT') < at('minako_mm_groups', 'INSERT')); assert.ok(at('minako_mm_teams', 'INSERT') < at('minako_mm_team_members', 'INSERT'));
    assert.ok(at('minako_mm_groups', 'DELETE') < at('minako_mm_teams', 'DELETE')); assert.ok(at('minako_mm_team_members', 'DELETE') < at('minako_mm_teams', 'DELETE'));
    assert.ok(plan.steps.some(s => s.sql.includes("pg_get_serial_sequence('minako_mm_teams'")));
  });
  console.log(`\n${n} testes passaram.`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
