'use strict';
const assert = require('node:assert/strict');
const s = require('../utils/matchmaking/social');
const core = require('../utils/matchmaking/mmCore');
let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
const NOW = 1_800_000_000_000; const H = 3600_000;
const ctx = (o = {}) => ({ targetIsBot: false, activePartners: [], targetActiveCount: 0, pendingOutCount: 0, existing: null, lastClosed: null, reversePending: false, ...o });
t('padrões: notificações de favoritos/parceiros são opt-in e a disponibilidade só é visível a parceiros', () => {
  const p = core.normalizePrefs({}); assert.equal(p.notif.partners, 'off'); assert.equal(p.notif.favorites, 'off'); assert.equal(p.visibility, 'partners');
  assert.equal(core.normalizePrefs({ visibility: 'todos' }).visibility, 'partners'); assert.equal(core.normalizePrefs({ visibility: 'none' }).visibility, 'none');
  assert.equal(core.normalizePrefs({ notif: { partners: 'thread' } }).notif.partners, 'off');
});
t('convite: regras e limites', () => {
  assert.equal(s.canInvite('a', 'a', ctx(), NOW).code, 'SELF'); assert.equal(s.canInvite('a', 'b', ctx({ targetIsBot: true }), NOW).code, 'BOT');
  assert.equal(s.canInvite('a', 'b', ctx({ existing: { status: 'active' } }), NOW).code, 'ALREADY_PARTNERS'); assert.equal(s.canInvite('a', 'b', ctx({ existing: { status: 'pending' } }), NOW).code, 'ALREADY_INVITED');
  assert.equal(s.canInvite('a', 'b', ctx({ activePartners: Array(10).fill('x') }), NOW).code, 'MY_LIMIT'); assert.equal(s.canInvite('a', 'b', ctx({ targetActiveCount: 10 }), NOW).code, 'TARGET_LIMIT');
  assert.equal(s.canInvite('a', 'b', ctx({ pendingOutCount: 5 }), NOW).code, 'TOO_MANY_PENDING'); assert.deepEqual(s.canInvite('a', 'b', ctx(), NOW), { ok: true, auto: false });
});
t('convite: interesse mútuo (convite inverso aberto) aceita sozinho, mesmo no limite de pendentes', () => {
  assert.deepEqual(s.canInvite('a', 'b', ctx({ reversePending: true, pendingOutCount: 5 }), NOW), { ok: true, auto: true });
});
t('convite recusado/expirado não se repete antes do intervalo; depois disso pode', () => {
  assert.equal(s.canInvite('a', 'b', ctx({ lastClosed: { status: 'declined', at: NOW - 2 * 86400_000 } }), NOW).code, 'COOLDOWN');
  assert.equal(s.canInvite('a', 'b', ctx({ lastClosed: { status: 'expired', at: NOW - 3 * 86400_000 } }), NOW).code, 'COOLDOWN');
  assert.equal(s.canInvite('a', 'b', ctx({ lastClosed: { status: 'declined', at: NOW - 8 * 86400_000 } }), NOW).ok, true);
  assert.equal(s.canInvite('a', 'b', ctx({ lastClosed: { status: 'ended', at: NOW - 1000 } }), NOW).ok, true); // encerrar parceria não bloqueia um novo convite
});
t('favoritar: limite, duplicata, si mesmo e bots', () => {
  assert.equal(s.canFavorite('a', 'a', { count: 0 }).code, 'SELF'); assert.equal(s.canFavorite('a', 'b', { count: 0, isBot: true }).code, 'BOT');
  assert.equal(s.canFavorite('a', 'b', { count: 0, already: true }).code, 'ALREADY'); assert.equal(s.canFavorite('a', 'b', { count: 25 }).code, 'LIMIT'); assert.ok(s.canFavorite('a', 'b', { count: 24 }).ok);
});
const prefs = (partners, favorites) => ({ notif: { partners, favorites } });
const base = (o = {}) => ({ subjectId: 's', visibility: 'partners', partners: ['p1'], favoriters: ['f1'], prefsBy: { p1: prefs('dm', 'off'), f1: prefs('off', 'dm') }, log: [], now: NOW, ...o });
t('privacidade: visibilidade padrão avisa só parceiros; "ninguém" não avisa ninguém; "favoritos" inclui quem favoritou', () => {
  assert.deepEqual(s.selectWatchRecipients(base()), [{ userId: 'p1', category: 'partners' }]);
  assert.deepEqual(s.selectWatchRecipients(base({ visibility: 'none' })), []);
  assert.deepEqual(s.selectWatchRecipients(base({ visibility: 'favorites' })).map(x => x.userId).sort(), ['f1', 'p1']);
});
t('opt-in independente: sem "dm" na categoria ninguém é avisado; ser parceiro e favorito gera um aviso só', () => {
  assert.deepEqual(s.selectWatchRecipients(base({ prefsBy: { p1: prefs('off', 'dm'), f1: prefs('off', 'off') } })), []);
  const both = s.selectWatchRecipients(base({ visibility: 'favorites', partners: ['x'], favoriters: ['x'], prefsBy: { x: prefs('dm', 'dm') } })); assert.deepEqual(both, [{ userId: 'x', category: 'partners' }]);
});
t('frequência: não repete o aviso do mesmo sujeito no intervalo e respeita o teto diário', () => {
  const log = [{ recipient: 'p1', subject: 's', at: NOW - 2 * H }]; assert.deepEqual(s.selectWatchRecipients(base({ log })), []);
  assert.equal(s.selectWatchRecipients(base({ log: [{ recipient: 'p1', subject: 's', at: NOW - 7 * H }] })).length, 1);
  const cap = Array.from({ length: 5 }, (_, i) => ({ recipient: 'p1', subject: `o${i}`, at: NOW - H })); assert.deepEqual(s.selectWatchRecipients(base({ log: cap })), []);
  assert.equal(s.selectWatchRecipients(base({ log: cap.slice(0, 4) })).length, 1);
});
t('o próprio sujeito nunca é avisado de si mesmo; a lista de quem favoritou nunca sai da função', () => {
  const r = s.selectWatchRecipients(base({ partners: ['s', 'p1'], prefsBy: { s: prefs('dm', 'dm'), p1: prefs('dm', 'dm') } })); assert.deepEqual(r.map(x => x.userId), ['p1']);
  assert.ok(!JSON.stringify(s.selectWatchRecipients(base({ visibility: 'favorites' }))).includes('favoriters'));
});
t('mensagens de erro existem para todos os códigos', () => {
  for (const code of ['SELF', 'BOT', 'ALREADY_PARTNERS', 'ALREADY_INVITED', 'MY_LIMIT', 'TARGET_LIMIT', 'TOO_MANY_PENDING', 'COOLDOWN']) assert.ok(s.INVITE_ERRORS[code]);
  for (const code of ['SELF', 'BOT', 'ALREADY', 'LIMIT']) assert.ok(s.FAVORITE_ERRORS[code]);
});
console.log(`\n${n} testes passaram.`);
