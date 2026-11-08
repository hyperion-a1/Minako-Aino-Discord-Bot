'use strict';
// Núcleo PURO do matchmaking da Minako (sem Discord, sem banco, sem relógio global).
// Tudo que decide vagas, estados, compatibilidade e expiração mora aqui para ser testável.
// A camada de persistência (transações) chama estas funções DENTRO da transação.

const RANKS = Object.freeze([
  ['bronze', 'Bronze'], ['prata', 'Prata'], ['ouro', 'Ouro'], ['platina', 'Platina'],
  ['diamante', 'Diamante'], ['mestre', 'Mestre'], ['grao-mestre', 'Grão-Mestre'],
  ['mitico', 'Mítico'], ['epico', 'Épico'], ['lenda', 'Lenda'],
]);
const rankIndex = (id) => RANKS.findIndex(([k]) => k === id);

const DEFAULT_SETTINGS = Object.freeze({
  proposalTtlSec: 120,
  availabilityTtlSec: 2 * 3600,
  replacementTtlSec: 300,
  archiveAfterSec: 3 * 86400,
  communityAlertMin: 6,               // alerta de atividade da comunidade quando houver ao menos N disponíveis (0 = desligado)
  communityAlertCooldownSec: 7200,    // intervalo mínimo entre alertas de atividade (por servidor)
  teamConfirmTtlSec: 600,             // tempo para cada membro confirmar a sessão da equipe (vaga reservada)
  groupInactivityTtlSec: 2 * 3600,    // grupo ABERTO sem movimento é encerrado (sem penalidade)
  confirmationWindowSec: 24 * 3600,
  relaxAfterSec: [300, 600],          // etapa 1 e etapa 2 de relaxamento (preferências opcionais)
  centralMinRefreshSec: 20,
  reviewChannelId: null,
  reviewRoleId: null,
  roleCatalog: ['Rota Superior', 'Selva', 'Rota do Meio', 'Apoio', 'Rota Inferior'],
});

const BOUNDS = {
  proposalTtlSec: [30, 3600], availabilityTtlSec: [600, 86400], replacementTtlSec: [60, 3600],
  archiveAfterSec: [3600, 30 * 86400], groupInactivityTtlSec: [900, 86400], teamConfirmTtlSec: [120, 3600], communityAlertMin: [0, 50], communityAlertCooldownSec: [1800, 86400], confirmationWindowSec: [3600, 14 * 86400],
  centralMinRefreshSec: [10, 600],
};

function normalizeSettings(raw = {}) {
  const out = { ...DEFAULT_SETTINGS, relaxAfterSec: [...DEFAULT_SETTINGS.relaxAfterSec], roleCatalog: [...DEFAULT_SETTINGS.roleCatalog] };
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) out[key] = Math.min(max, Math.max(min, Math.round(n)));
  }
  if (Array.isArray(raw.relaxAfterSec) && raw.relaxAfterSec.length === 2) {
    const [a, b] = raw.relaxAfterSec.map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && a >= 60 && b > a && b <= 7200) out.relaxAfterSec = [Math.round(a), Math.round(b)];
  }
  if (Array.isArray(raw.roleCatalog)) {
    const list = [...new Set(raw.roleCatalog.map(v => String(v ?? '').trim()).filter(v => v && v.length <= 40))].slice(0, 10);
    if (list.length) out.roleCatalog = list;
  }
  for (const k of ['reviewChannelId', 'reviewRoleId']) {
    const v = String(raw[k] ?? '').trim();
    out[k] = /^\d{15,25}$/.test(v) ? v : out[k];
  }
  return out;
}

// Modo de jogo: tudo configurável. slots = lista de vagas; role null = vaga flexível.
function makeMode(m) {
  const slots = Array.isArray(m.slots) ? m.slots.map(s => ({ role: s?.role || null })) : [];
  const idealSize = Math.max(2, Math.min(10, m.idealSize || slots.length || 5));
  const minSize = Math.max(2, Math.min(idealSize, m.minSize || idealSize));
  return {
    id: String(m.id).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'modo', label: String(m.label || m.id).slice(0, 40),
    idealSize, minSize,
    allowIncomplete: Boolean(m.allowIncomplete) && minSize < idealSize,
    eloRelevant: Boolean(m.eloRelevant),
    eloWindow: Number.isInteger(m.eloWindow) ? m.eloWindow : 2,   // diferença máxima de faixas (obrigatória)
    slots: slots.length === idealSize ? slots : Array.from({ length: idealSize }, () => ({ role: null })),
    active: m.active !== false,
  };
}

const DEFAULT_MODES = Object.freeze([
  { id: 'ranqueada', label: 'Ranqueada', idealSize: 5, minSize: 2, allowIncomplete: true, eloRelevant: true, eloWindow: 2 },
  { id: 'normal', label: 'Normal', idealSize: 5, minSize: 2, allowIncomplete: true, eloRelevant: false },
  { id: 'casual', label: 'Casual', idealSize: 5, minSize: 2, allowIncomplete: true, eloRelevant: false },
].map(makeMode));

// ---------- Disponibilidade ----------
function makeAvailability({ userId, modeId, roles = [], elo = null, voice = null, now, ttlSec, createdAt }) {
  return { userId, modeId, roles, elo, voice, status: 'active', since: createdAt ?? now, expiresAt: now + ttlSec * 1000, pausedAt: null };
}
const isAvailabilityValid = (av, now) => Boolean(av && av.status === 'active' && av.expiresAt > now);
function renewAvailability(av, now, ttlSec) {
  if (!av || av.status === 'ended') return null;
  return { ...av, status: 'active', pausedAt: null, expiresAt: now + ttlSec * 1000 };
}
const pauseAvailability = (av, now) => (av && av.status === 'active' ? { ...av, status: 'paused', pausedAt: now } : av);
const endAvailability = (av) => (av ? { ...av, status: 'ended' } : av);

// ---------- Relaxamento de preferências OPCIONAIS ----------
// 0 = estrito; 1 e 2 = relaxa progressivamente apenas critérios opcionais.
function relaxStage(waitMs, settings) {
  const [a, b] = settings.relaxAfterSec;
  return waitMs >= b * 1000 ? 2 : waitMs >= a * 1000 ? 1 : 0;
}

// Requisitos OBRIGATÓRIOS: nunca relaxados. Retorna true se A e B podem estar juntos.
function meetsRequired(a, b, mode) {
  if (a.modeId !== mode.id || b.modeId !== mode.id) return false;
  if (a.userId === b.userId) return false;
  if (mode.eloRelevant) {
    const ia = rankIndex(a.elo), ib = rankIndex(b.elo);
    if (ia < 0 || ib < 0 || Math.abs(ia - ib) > mode.eloWindow) return false;
  }
  return true;
}
// Preferência opcional de voz: 'yes' | 'no' | null. Conflito só pesa nas etapas 0 e 1.
function voiceConflict(a, b) {
  return (a.voice === 'yes' && b.voice === 'no') || (a.voice === 'no' && b.voice === 'yes');
}
function optionalOk(a, b, stage) { return stage >= 2 || !voiceConflict(a, b); }

// ---------- Atribuição de funções às vagas (backtracking; grupos <= 10) ----------
function assignRoles(players, slots) {
  const n = players.length;
  if (n > slots.length) return null;
  const used = new Array(slots.length).fill(false);
  const result = new Array(n).fill(-1);
  // Vaga com função obrigatória exige jogador que declare a função; vaga flexível aceita qualquer um.
  const test = (p, s) => !s.role || (p.roles || []).includes(s.role);
  function go(i) {
    if (i === n) return true;
    for (let s = 0; s < slots.length; s++) {
      if (used[s] || !test(players[i], slots[s])) continue;
      used[s] = true; result[i] = s;
      if (go(i + 1)) return true;
      used[s] = false; result[i] = -1;
    }
    return false;
  }
  return go(0) ? result : null;
}

// ---------- Formação de propostas ----------
// queue: disponibilidades válidas + { waitingSince }. Retorna propostas sugeridas (não persiste nada).
// `blocked` = Set de "userA|userB" que acabaram de recusar juntos (evita repetir a mesma combinação).
function buildProposals(queue, mode, now, settings, { blocked = new Set(), busy = new Set() } = {}) {
  const pool = queue
    .filter(q => isAvailabilityValid(q, now) && q.modeId === mode.id && !busy.has(q.userId))
    .sort((x, y) => (x.waitingSince ?? x.since) - (y.waitingSince ?? y.since));
  const taken = new Set();
  const proposals = [];
  for (const seed of pool) {
    if (taken.has(seed.userId)) continue;
    const stage = relaxStage(now - (seed.waitingSince ?? seed.since), settings);
    const target = (stage >= 1 && mode.allowIncomplete) ? mode.minSize : mode.idealSize;
    const group = [seed];
    for (const cand of pool) {
      if (group.length >= mode.idealSize) break;
      if (cand === seed || taken.has(cand.userId)) continue;
      const ok = group.every(g => meetsRequired(g, cand, mode) && optionalOk(g, cand, stage)
        && !blocked.has([g.userId, cand.userId].sort().join('|')));
      if (!ok) continue;
      const next = [...group, cand];
      if (assignRoles(next, mode.slots)) group.push(cand);
    }
    if (group.length >= target && group.length >= mode.minSize) {
      const assignment = assignRoles(group, mode.slots);
      group.forEach(g => taken.add(g.userId));
      proposals.push({
        modeId: mode.id,
        userIds: group.map(g => g.userId),
        slotByUser: Object.fromEntries(group.map((g, i) => [g.userId, assignment[i]])),
        incomplete: group.length < mode.idealSize,
        relaxStage: stage,
        expiresAt: now + settings.proposalTtlSec * 1000,
      });
    }
  }
  return proposals;
}

// ---------- Resolução de proposta ----------
// responses: { userId: 'accepted'|'declined'|undefined }. Nunca reativa proposta expirada.
function resolveProposal(proposal, responses, now, isStillAvailable = () => true) {
  const ids = proposal.userIds;
  const state = (id) => responses[id] || 'pending';
  if (proposal.status && proposal.status !== 'pending') return { outcome: proposal.status, final: true };
  if (ids.every(id => state(id) === 'accepted')) return { outcome: 'confirmed', final: true, confirmed: ids.slice() };
  const declined = ids.filter(id => state(id) === 'declined');
  const expired = proposal.expiresAt <= now;
  if (!declined.length && !expired) return { outcome: 'pending', final: false };
  const outcome = declined.length ? 'declined' : 'expired';
  // Quem não recusou e ainda está disponível continua na fila, sem reiniciar manualmente.
  const requeue = ids.filter(id => state(id) !== 'declined' && isStillAvailable(id));
  const blockedPairs = declined.length
    ? ids.filter(id => id !== declined[0]).map(id => [id, declined[0]].sort().join('|')) : [];
  return { outcome, final: true, requeue, declined, blockedPairs, penalty: null };
}

// Se alguém aceitou a proposta mas, nesse meio-tempo, assumiu outro compromisso, conta como recusa (sem punição).
function applyBusyToResponses(responses, userIds, busyIds) {
  const out = { ...responses };
  for (const id of userIds) if (busyIds.includes(id)) out[id] = 'declined';
  return out;
}

// ---------- Grupos: estados e vagas ----------
const GROUP_STATES = Object.freeze(['open', 'confirmed', 'searching_replacement', 'completed', 'closed']);
const TRANSITIONS = Object.freeze({
  open: ['confirmed', 'closed'],
  confirmed: ['searching_replacement', 'completed', 'closed'],
  searching_replacement: ['open', 'confirmed', 'closed'],
  completed: [],
  closed: [],
});
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// Pedidos pendentes NUNCA contam como confirmados.
const confirmedCount = (group) => group.members.filter(m => m.status === 'confirmed').length;
// Reserva de equipe: vaga segurada para um membro que ainda vai confirmar a SESSÃO. Vale até reservedUntil (ms).
const reservedCount = (group, now = Date.now()) => group.members.filter(m => m.status === 'reserved' && (m.reservedUntil == null || m.reservedUntil > now)).length;
// Vagas realmente abertas = capacidade - confirmados - reservas ativas.
const freeSlots = (group, now = Date.now()) => Math.max(0, group.capacity - confirmedCount(group) - reservedCount(group, now));

// Decisão de entrada: chamada dentro da transação, com o grupo recém-travado e recontado.
function decideJoin(group, user, mode, { organizerApproval = false, approved = false, role = null } = {}) {
  if (!['open', 'searching_replacement'].includes(group.state)) return { ok: false, code: 'GROUP_NOT_OPEN' };
  if (group.members.some(m => m.userId === user.userId && m.status === 'confirmed')) return { ok: false, code: 'ALREADY_MEMBER' };
  if (user.busyElsewhere) return { ok: false, code: 'INCOMPATIBLE_COMMITMENT' };
  if (mode.eloRelevant && group.eloRange && (rankIndex(user.elo) < group.eloRange[0] || rankIndex(user.elo) > group.eloRange[1])) {
    return { ok: false, code: 'ELO_REQUIREMENT' };
  }
  // Funções exigidas ainda abertas: se todas as vagas restantes estão reservadas, a função é obrigatória.
  const openRoles = group.requiredRolesOpen || [];
  if (openRoles.length && openRoles.length >= Math.max(1, freeSlots(group))) {
    if (!role) return { ok: false, code: 'ROLE_REQUIRED' };
    if (!openRoles.includes(role)) return { ok: false, code: 'ROLE_UNAVAILABLE' };
  }
  if (organizerApproval && !approved) return { ok: true, action: 'request_pending' };   // não ocupa vaga
  if (freeSlots(group) <= 0) return { ok: false, code: 'NO_SLOT' };
  return { ok: true, action: 'confirm' };
}

// Efeito de uma saída sobre o grupo.
function afterLeave(group) {
  if (['completed', 'closed'].includes(group.state)) return { state: group.state, searchReplacement: false };
  if (freeSlots(group) > 0 && group.state === 'confirmed') return { state: 'searching_replacement', searchReplacement: true };
  return { state: group.state, searchReplacement: group.state === 'searching_replacement' };
}

// ---------- Registro de partida ----------
function resolveMatchRecord(record, now) {
  if (record.status === 'review') return { status: 'review', final: false };
  const contested = Object.values(record.responses || {}).includes('contested');
  if (contested) return { status: 'review', final: false, rewards: false };
  if (now >= record.windowEndsAt) {
    // Silêncio não confirma nem invalida: registro segue como "registrado" (sem recompensas finais).
    const allConfirmed = record.participantIds.every(id => record.responses?.[id] === 'confirmed' || id === record.organizerId);
    return { status: allConfirmed ? 'validated' : 'recorded', final: true, rewards: allConfirmed };
  }
  return { status: 'pending_window', final: false };
}

const stagesText = (settings) => {
  const [a, b] = settings.relaxAfterSec;
  return `Após ${Math.round(a / 60)} min de espera relaxo preferências opcionais (como voz) e, após ${Math.round(b / 60)} min, também as demais opcionais. Requisitos obrigatórios (modo, elo e funções exigidas) nunca são relaxados.`;
};

// ---------- Preferências do usuário (notificações operacionais e padrões de jogo) ----------
// Categorias operacionais: actions (propostas e pedidos/decisões que pedem resposta), groups (entradas, saídas e
// mudanças de estado dos seus grupos), expiry (aviso antes de a disponibilidade expirar; opt-in).
const NOTIF_OPTIONS = Object.freeze({ actions: ['dm', 'off'], groups: ['dm', 'thread', 'off'], expiry: ['off', 'dm'], partners: ['off', 'dm'], favorites: ['off', 'dm'], community: ['off', 'dm'], digest: ['off', 'daily', 'weekly'] });
const VISIBILITY_OPTIONS = Object.freeze(['partners', 'none', 'favorites']); // quem pode ser avisado de que EU fiquei disponível (padrão: só parceiros)
const DEFAULT_PREFS = Object.freeze({ notif: Object.freeze({ actions: 'dm', groups: 'dm', expiry: 'off', partners: 'off', favorites: 'off', community: 'off', digest: 'off' }), play: null, visibility: 'partners', quiet: null, pausedUntil: null });
function normalizePrefs(raw = {}) {
  const notif = { ...DEFAULT_PREFS.notif };
  for (const [cat, allowed] of Object.entries(NOTIF_OPTIONS)) { const v = raw?.notif?.[cat]; if (allowed.includes(v)) notif[cat] = v; }
  let play = null;
  if (raw?.play && typeof raw.play === 'object') {
    play = {
      mode: raw.play.mode ? String(raw.play.mode).slice(0, 24) : null,
      roles: Array.isArray(raw.play.roles) ? [...new Set(raw.play.roles.map(r => String(r).slice(0, 40)))].slice(0, 5) : [],
      voice: ['y', 'n', 'a'].includes(raw.play.voice) ? raw.play.voice : 'a',
    };
  }
  const visibility = VISIBILITY_OPTIONS.includes(raw?.visibility) ? raw.visibility : DEFAULT_PREFS.visibility;
  // Horário silencioso (hora cheia, fuso do servidor) e pausa geral (até um instante). Só afetam avisos de ENGAJAMENTO.
  const qf = Number(raw?.quiet?.from); const qt = Number(raw?.quiet?.to);
  const quiet = Number.isInteger(qf) && Number.isInteger(qt) && qf >= 0 && qf <= 23 && qt >= 0 && qt <= 23 && qf !== qt ? { from: qf, to: qt } : null;
  const pu = Number(raw?.pausedUntil);
  const pausedUntil = Number.isFinite(pu) && pu > 0 ? pu : null;
  return { notif, play, visibility, quiet, pausedUntil };
}
const EXPIRY_WARNING_SEC = 600; // aviso (se o usuário habilitou) 10 min antes de expirar

module.exports = {
  NOTIF_OPTIONS, VISIBILITY_OPTIONS, DEFAULT_PREFS, normalizePrefs, EXPIRY_WARNING_SEC,
  BOUNDS,
  RANKS, rankIndex, DEFAULT_SETTINGS, normalizeSettings, makeMode, DEFAULT_MODES,
  makeAvailability, isAvailabilityValid, renewAvailability, pauseAvailability, endAvailability,
  relaxStage, meetsRequired, assignRoles, buildProposals, resolveProposal,
  GROUP_STATES, canTransition, confirmedCount, reservedCount, freeSlots, applyBusyToResponses, decideJoin, afterLeave,
  resolveMatchRecord, stagesText,
};
