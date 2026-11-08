'use strict';
const assert = require('node:assert/strict');
const p = require('../utils/matchmaking/notifyPolicy');
const core = require('../utils/matchmaking/mmCore');
const social = require('../utils/matchmaking/social');
let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
const at = (d, h, m = 0) => Date.UTC(2026, 9, d, h + 3, m);        // horário local de São Paulo (UTC-3) em outubro/2026
const FRI = 23, THU = 22, SAT = 24;
const pref = (o = {}) => core.normalizePrefs({ notif: { digest: 'daily', community: 'dm', partners: 'dm' }, ...o });
t('fuso: hora, dia da semana e data local de São Paulo', () => {
  assert.deepEqual(p.localParts(at(FRI, 19)), { hour: 19, weekday: 5, dateKey: '2026-10-23' });
  assert.deepEqual(p.localParts(Date.UTC(2026, 9, 24, 2, 30)), { hour: 23, weekday: 5, dateKey: '2026-10-23' });   // 02:30Z ainda é sexta à noite no Brasil
});
t('horário silencioso: normal e atravessando a meia-noite; sem configuração nunca silencia', () => {
  assert.ok(p.inQuiet({ from: 22, to: 8 }, 23)); assert.ok(p.inQuiet({ from: 22, to: 8 }, 3)); assert.ok(!p.inQuiet({ from: 22, to: 8 }, 8)); assert.ok(!p.inQuiet({ from: 22, to: 8 }, 15));
  assert.ok(p.inQuiet({ from: 1, to: 6 }, 1)); assert.ok(!p.inQuiet({ from: 1, to: 6 }, 6)); assert.ok(!p.inQuiet(null, 3));
});
t('engajamento: pausa geral e horário silencioso bloqueiam; fora deles libera', () => {
  const now = at(FRI, 15);
  assert.deepEqual(p.engagementAllowed(pref(), now), { ok: true });
  assert.deepEqual(p.engagementAllowed(pref({ pausedUntil: now + 1000 }), now), { ok: false, reason: 'paused' }); assert.ok(p.engagementAllowed(pref({ pausedUntil: now - 1 }), now).ok);   // pausa vencida volta sozinha
  assert.deepEqual(p.engagementAllowed(pref({ quiet: { from: 14, to: 16 } }), now), { ok: false, reason: 'quiet' }); assert.ok(p.engagementAllowed(pref({ quiet: { from: 22, to: 8 } }), now).ok);
});
t('operacionais ≠ engajamento: só engajamento é filtrado por pausa/silêncio/limites', () => {
  for (const c of ['actions', 'groups', 'expiry']) assert.ok(!p.isEngagement(c), c);
  for (const c of ['partners', 'favorites', 'community', 'digest']) assert.ok(p.isEngagement(c), c);
});
t('preferências novas: horário silencioso e pausa validados; categorias de engajamento são opt-in', () => {
  const d = core.normalizePrefs({}); assert.equal(d.notif.community, 'off'); assert.equal(d.notif.digest, 'off'); assert.equal(d.quiet, null); assert.equal(d.pausedUntil, null);
  assert.deepEqual(core.normalizePrefs({ quiet: { from: 22, to: 8 } }).quiet, { from: 22, to: 8 }); assert.equal(core.normalizePrefs({ quiet: { from: 5, to: 5 } }).quiet, null); assert.equal(core.normalizePrefs({ quiet: { from: 25, to: 1 } }).quiet, null);
  assert.equal(core.normalizePrefs({ notif: { digest: 'hourly' } }).notif.digest, 'off'); assert.equal(core.normalizePrefs({ notif: { digest: 'weekly' } }).notif.digest, 'weekly');
});
t('resumo diário: só depois das 19h, uma vez por dia, e nunca em pausa/silêncio', () => {
  assert.equal(p.digestDue(pref(), null, at(THU, 18, 59)), false); assert.equal(p.digestDue(pref(), null, at(THU, 19)), true);
  assert.equal(p.digestDue(pref(), at(THU, 19, 5), at(THU, 21)), false);              // já enviado hoje
  assert.equal(p.digestDue(pref(), at(THU, 19, 5), at(FRI, 19, 1)), true);            // no dia seguinte envia de novo
  assert.equal(p.digestDue(pref({ pausedUntil: at(FRI, 23) }), null, at(FRI, 19)), false); assert.equal(p.digestDue(pref({ quiet: { from: 18, to: 22 } }), null, at(FRI, 19)), false);
  assert.equal(p.digestDue(core.normalizePrefs({}), null, at(FRI, 19)), false);       // desligado por padrão
});
t('resumo semanal: só às sextas depois das 19h', () => {
  const w = core.normalizePrefs({ notif: { digest: 'weekly' } });
  assert.equal(p.digestDue(w, null, at(THU, 20)), false); assert.equal(p.digestDue(w, null, at(FRI, 19)), true); assert.equal(p.digestDue(w, null, at(SAT, 20)), false); assert.equal(p.digestDue(w, at(FRI, 19, 1), at(FRI, 21)), false);
});
t('resumo nunca é vazio e lista só o que existe', () => {
  assert.equal(p.buildDigest({ availableNow: 0, groups: [] }), null); assert.equal(p.buildDigest({ availableNow: 1, groups: [] }), null);
  assert.match(p.buildDigest({ availableNow: 3, groups: [] }), /Disponíveis agora:\*\* 3 · \*\*Grupos com vaga:\*\* 0/);
  const txt = p.buildDigest({ availableNow: 4, groups: [1, 2, 3, 4].map(i => ({ mode: `M${i}`, confirmed: 2, capacity: 5, free: 3 })) }); assert.match(txt, /M1 — 2\/5 \(3 vagas\)/); assert.match(txt, /e mais 1 grupo/); assert.doesNotMatch(txt, /M4 —/);
});
t('alerta de atividade: só com o limite atingido, ligado e fora do intervalo mínimo', () => {
  const base = { availableNow: 8, min: 6, lastAlertAt: null, cooldownSec: 7200, now: 10_000_000 };
  assert.equal(p.communityAlertDue(base), true); assert.equal(p.communityAlertDue({ ...base, min: 0 }), false); assert.equal(p.communityAlertDue({ ...base, availableNow: 5 }), false);
  assert.equal(p.communityAlertDue({ ...base, lastAlertAt: base.now - 3600_000 }), false); assert.equal(p.communityAlertDue({ ...base, lastAlertAt: base.now - 7300_000 }), true);
});
t('alerta de atividade: só opt-in, não incomoda quem já joga, respeita pausa/silêncio, intervalo, teto diário e máximo por rodada', () => {
  const now = at(FRI, 15); const cand = (id, o = {}) => ({ userId: id, prefs: pref(o) });
  const r = p.selectCommunityRecipients({ now, busy: new Set(['busy']), log: [{ recipient: 'cd', category: 'community', at: now - 3600_000 }, ...Array.from({ length: 5 }, (_, i) => ({ recipient: 'cap', category: 'partners', at: now - 1000 * (i + 1) }))],
    candidates: [cand('ok'), cand('busy'), cand('off', { notif: { community: 'off' } }), cand('paused', { pausedUntil: now + 9999 }), cand('quiet', { quiet: { from: 14, to: 16 } }), cand('cd'), cand('cap')] });
  assert.deepEqual(r, ['ok']);
  assert.equal(p.selectCommunityRecipients({ now, busy: new Set(), log: [], max: 2, candidates: ['a', 'b', 'c'].map(i => cand(i)) }).length, 2);
});
t('agrupamento: avisos parecidos viram um só; velhos são descartados; texto no singular/plural', () => {
  const now = 1_000_000_000; const g = p.groupItems([{ category: 'partners', subjectId: 'a', at: now - 1000 }, { category: 'partners', subjectId: 'a', at: now - 500 }, { category: 'partners', subjectId: 'b', at: now - 2000 },
    { category: 'favorites', subjectId: 'c', at: now - 1000 }, { category: 'partners', subjectId: 'old', at: now - 16 * 60_000 }], now);
  assert.deepEqual(g, [{ category: 'partners', subjects: ['a', 'b'] }, { category: 'favorites', subjects: ['c'] }]);
  assert.match(p.groupedText('partners', ['a']), /Seu parceiro <@a> ficou disponível/); assert.match(p.groupedText('partners', ['a', 'b']), /\*\*2 parceiros\*\*/); assert.match(p.groupedText('favorites', ['a', 'b', 'c']), /\*\*3 favoritos\*\*/);
  assert.match(p.groupedText('partners', ['1', '2', '3', '4', '5', '6', '7']), /e mais 2/);
});
t('quem favoritou/é parceiro em pausa ou horário silencioso não é selecionado para o aviso de disponibilidade', () => {
  const now = at(FRI, 15); const mk = (o) => ({ p1: core.normalizePrefs({ notif: { partners: 'dm' }, ...o }) });
  const sel = (prefsBy) => social.selectWatchRecipients({ subjectId: 's', visibility: 'partners', partners: ['p1'], favoriters: [], prefsBy, log: [], now });
  assert.equal(sel(mk({})).length, 1); assert.equal(sel(mk({ pausedUntil: now + 1000 })).length, 0); assert.equal(sel(mk({ quiet: { from: 14, to: 16 } })).length, 0);
});
t('configuração do administrador: limites do alerta de atividade', () => {
  assert.equal(core.normalizeSettings({}).communityAlertMin, 6); assert.equal(core.normalizeSettings({ communityAlertMin: 0 }).communityAlertMin, 0); assert.equal(core.normalizeSettings({ communityAlertMin: 99 }).communityAlertMin, 50);
  assert.equal(core.normalizeSettings({ communityAlertCooldownSec: 60 }).communityAlertCooldownSec, 1800);
});
console.log(`\n${n} testes passaram.`);
