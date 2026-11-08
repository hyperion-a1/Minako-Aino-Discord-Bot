'use strict';
// Lógica pura do módulo de sorteios da Minako: sem Discord e sem banco, para
// poder ser testada isoladamente. Tudo que decide "pode / não pode" vive aqui.
const { randomInt } = require('node:crypto');

const LIMITS = Object.freeze({
  name: 80,
  textBlock: 1500,
  totalText: 3000,          // texto bruto dos blocos (o V2 aceita 4000 já renderizado)
  maxBlocks: 12,
  galleryItems: 10,
  maxComponents: 32,        // sobra espaço para container + última row de botões
  threadMessage: 1800,
  maxWinners: 20,
  maxParticipants: 100000,
  maxRoles: 25,
  maxUsers: 25,             // limite de um menu de seleção do Discord
  maxRewardRoles: 10,
  maxRoleDays: 3650,
  maxDurationMinutes: 90 * 24 * 60,
  urlLength: 500,
});

const DEFAULT_ACCENT = 0xF5A9B8;
const DEFAULT_THREAD_MESSAGE = 'Parabéns {users}! 🎉 Vocês ganharam **{giveaway}**. {host} vai combinar a entrega por aqui.';

// Placeholders do módulo: fixos (o host não cria nem edita placeholders).
const PLACEHOLDER_DOCS = Object.freeze([
  ['{host}', 'Menção ao host do sorteio'],
  ['{giveaway}', 'Nome do sorteio'],
  ['{user1}, {user2}, {user3}…', 'Menção ao 1º, 2º, 3º… ganhador (só existem após o sorteio)'],
  ['{users}', 'Menção a todos os ganhadores'],
  ['{winners}', 'Quantidade de ganhadores'],
  ['{participants}', 'Participantes inscritos agora'],
  ['{min}', 'Mínimo de participantes'],
  ['{max}', 'Máximo de participantes (∞ se não houver)'],
  ['{channel}', 'Canal/tópico do sorteio'],
  ['{start}', 'Data/hora de início'],
  ['{end}', 'Data/hora de conclusão'],
  ['{endrelative}', 'Conclusão em tempo relativo (“em 2 horas”)'],
  ['{link}', 'Link da mensagem do sorteio'],
  ['{date}', 'Data de hoje'],
]);

function defaultBlocks() {
  return [
    { type: 'text', content: '# 🎉 {giveaway}\nHost: {host}' },
    { type: 'separator', divider: true, spacing: 'small' },
    { type: 'text', content: '**Ganhadores:** {winners}\n**Participantes:** {participants}\n**Encerra:** {endrelative}' },
  ];
}

function defaultConfig() {
  return {
    name: '',
    minParticipants: 1,
    maxParticipants: 0,            // 0 = sem limite
    winnerCount: 1,
    end: { mode: 'duration', durationMinutes: 1440, at: null },   // 'duration' | 'date'
    allowedRoleIds: [],
    blockedRoleIds: [],
    allowedUserIds: [],            // membros liberados (se houver cargos liberados também, vale um OU outro)
    blockedUserIds: [],
    rulesScope: 'local',           // 'local' = só este sorteio (e os criados a partir do template) | 'global' = todos (só admin)
    winnerRoles: { grantRoleIds: [], grantDays: 0, removeRoleIds: [], removeDays: 0 },   // dias 0 = permanente
    cooldown: { giveaways: 0, days: 0 },                          // no máximo um dos dois > 0
    schedule: { enabled: false, startsAt: null },
    channelId: null,
    pin: false,                    // padrão: não fixar
    privateThread: { enabled: false, message: DEFAULT_THREAD_MESSAGE },
    message: { accentColor: DEFAULT_ACCENT, blocks: defaultBlocks() },  // accentColor null = sem cor
  };
}

const SNOWFLAKE = /^\d{15,22}$/;
const isSnowflake = (v) => typeof v === 'string' && SNOWFLAKE.test(v);
const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const uniqueIds = (arr, max = LIMITS.maxRoles) => [...new Set((Array.isArray(arr) ? arr : []).filter(isSnowflake))].slice(0, max);

// Aceita só https. Bloqueia espaços, aspas e esquemas que não sejam web.
function safeUrl(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > LIMITS.urlLength || /[\s"'<>]/.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (v) => String(v ?? '').slice(0, LIMITS.textBlock);
  if (raw.type === 'text') return text(raw.content).trim() ? { type: 'text', content: text(raw.content) } : null;
  if (raw.type === 'section') {
    const content = text(raw.content);
    const thumbnail = safeUrl(raw.thumbnail);
    return content.trim() && thumbnail ? { type: 'section', content, thumbnail } : null;
  }
  if (raw.type === 'separator') {
    return { type: 'separator', divider: raw.divider !== false, spacing: raw.spacing === 'large' ? 'large' : 'small' };
  }
  if (raw.type === 'gallery') {
    const urls = (Array.isArray(raw.urls) ? raw.urls : []).map(safeUrl).filter(Boolean).slice(0, LIMITS.galleryItems);
    return urls.length ? { type: 'gallery', urls } : null;
  }
  return null;
}

function normalizeAccent(v) {
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 0xFFFFFF ? n : DEFAULT_ACCENT;
}

// Sempre devolve uma config completa e segura, mesmo vinda de JSON antigo/adulterado.
function normalizeWinnerRoles(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  return {
    grantRoleIds: uniqueIds(w.grantRoleIds, LIMITS.maxRewardRoles),
    grantDays: clampInt(w.grantDays, 0, LIMITS.maxRoleDays, 0),
    removeRoleIds: uniqueIds(w.removeRoleIds, LIMITS.maxRewardRoles),
    removeDays: clampInt(w.removeDays, 0, LIMITS.maxRoleDays, 0),
  };
}

// Regras de cargo/membro que valem para TODOS os sorteios do servidor (guardadas em nível de servidor).
function normalizeRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    allowedRoleIds: uniqueIds(r.allowedRoleIds),
    blockedRoleIds: uniqueIds(r.blockedRoleIds),
    allowedUserIds: uniqueIds(r.allowedUserIds, LIMITS.maxUsers),
    blockedUserIds: uniqueIds(r.blockedUserIds, LIMITS.maxUsers),
  };
}
const emptyRules = () => normalizeRules({});
// União de listas (limitada ao máximo de um menu). `truncated` avisa se algo ficou de fora.
function mergeRules(base, extra) {
  const a = normalizeRules(base); const b = normalizeRules(extra);
  const out = {}; let truncated = false;
  for (const key of Object.keys(a)) {
    const max = key.endsWith('RoleIds') ? LIMITS.maxRoles : LIMITS.maxUsers;
    const all = [...new Set([...a[key], ...b[key]])];
    if (all.length > max) truncated = true;
    out[key] = all.slice(0, max);
  }
  return { rules: out, truncated };
}

// Violação de regras de cargo/membro (bloqueio vence permissão). Serve a config do sorteio e as regras globais.
function ruleViolation(rules, userId, roleSet) {
  if (!rules) return null;
  if ((rules.blockedUserIds || []).includes(userId)) return { reason: 'blocked_user' };
  const hit = (rules.blockedRoleIds || []).filter((r) => roleSet.has(r));
  if (hit.length) return { reason: 'blocked_role', roleIds: hit };
  const ar = rules.allowedRoleIds || []; const au = rules.allowedUserIds || [];
  if ((ar.length || au.length) && !(au.includes(userId) || ar.some((r) => roleSet.has(r)))) {
    return { reason: 'not_allowed', roleIds: ar, members: au.length > 0 };
  }
  return null;
}

function normalizeConfig(raw) {
  const d = defaultConfig();
  const c = raw && typeof raw === 'object' ? raw : {};
  const end = c.end && typeof c.end === 'object' ? c.end : {};
  const cd = c.cooldown && typeof c.cooldown === 'object' ? c.cooldown : {};
  const sc = c.schedule && typeof c.schedule === 'object' ? c.schedule : {};
  const pt = c.privateThread && typeof c.privateThread === 'object' ? c.privateThread : {};
  const msg = c.message && typeof c.message === 'object' ? c.message : {};
  const blocks = (Array.isArray(msg.blocks) ? msg.blocks : d.message.blocks).map(normalizeBlock).filter(Boolean).slice(0, LIMITS.maxBlocks);
  return {
    name: String(c.name ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name),
    minParticipants: clampInt(c.minParticipants, 1, LIMITS.maxParticipants, 1),
    maxParticipants: clampInt(c.maxParticipants, 0, LIMITS.maxParticipants, 0),
    winnerCount: clampInt(c.winnerCount, 1, LIMITS.maxWinners, 1),
    end: {
      mode: end.mode === 'date' ? 'date' : 'duration',
      durationMinutes: clampInt(end.durationMinutes, 1, LIMITS.maxDurationMinutes, 1440),
      at: typeof end.at === 'string' && !Number.isNaN(Date.parse(end.at)) ? new Date(end.at).toISOString() : null,
    },
    allowedRoleIds: uniqueIds(c.allowedRoleIds),
    blockedRoleIds: uniqueIds(c.blockedRoleIds),
    allowedUserIds: uniqueIds(c.allowedUserIds, LIMITS.maxUsers),
    blockedUserIds: uniqueIds(c.blockedUserIds, LIMITS.maxUsers),
    rulesScope: c.rulesScope === 'global' ? 'global' : 'local',
    winnerRoles: normalizeWinnerRoles(c.winnerRoles),
    cooldown: { giveaways: clampInt(cd.giveaways, 0, 1000, 0), days: clampInt(cd.days, 0, 3650, 0) },
    schedule: {
      enabled: sc.enabled === true,
      startsAt: typeof sc.startsAt === 'string' && !Number.isNaN(Date.parse(sc.startsAt)) ? new Date(sc.startsAt).toISOString() : null,
    },
    channelId: isSnowflake(c.channelId) ? c.channelId : null,
    pin: c.pin === true,
    privateThread: {
      enabled: pt.enabled === true,
      message: String(pt.message ?? d.privateThread.message).slice(0, LIMITS.threadMessage),
    },
    message: { accentColor: msg.accentColor === undefined ? d.message.accentColor : normalizeAccent(msg.accentColor), blocks },
  };
}

// ---------------------------------------------------------------------------
// Contagem de componentes V2 (limite do Discord: 40 por mensagem, tudo incluso)
// ---------------------------------------------------------------------------
function blockComponentCount(b) {
  if (b.type === 'text' || b.type === 'separator') return 1;
  if (b.type === 'section') return 3;                 // section + texto + thumbnail
  if (b.type === 'gallery') return 1;                 // itens da galeria não contam como componentes
  return 1;
}
function countComponents(blocks) { return blocks.reduce((n, b) => n + blockComponentCount(b), 0); }
function totalText(blocks) {
  return blocks.reduce((n, b) => n + ((b.type === 'text' || b.type === 'section') ? b.content.length : 0), 0);
}

// ---------------------------------------------------------------------------
// Validação (usada no painel e novamente no servidor ao criar)
// ---------------------------------------------------------------------------
function validateConfig(cfg, { now = new Date() } = {}) {
  const errors = [];
  if (!cfg.name) errors.push('Defina o **nome** do sorteio.');
  if (cfg.maxParticipants > 0 && cfg.maxParticipants < cfg.minParticipants) errors.push('O **máximo** de participantes não pode ser menor que o mínimo.');
  if (cfg.maxParticipants > 0 && cfg.maxParticipants < cfg.winnerCount) errors.push('O **máximo** de participantes não pode ser menor que o número de ganhadores.');

  const startsAt = cfg.schedule.enabled ? (cfg.schedule.startsAt ? new Date(cfg.schedule.startsAt) : null) : null;
  if (cfg.schedule.enabled) {
    if (!startsAt) errors.push('O agendamento está ativo, mas falta a **data de início**.');
    else if (startsAt.getTime() < now.getTime() + 30_000) errors.push('A **data de início** precisa estar no futuro.');
  }
  if (cfg.end.mode === 'date') {
    const at = cfg.end.at ? new Date(cfg.end.at) : null;
    if (!at) errors.push('Defina a **data de conclusão**.');
    else if (at.getTime() < Math.max(now.getTime(), startsAt?.getTime() ?? 0) + 60_000) errors.push('A **data de conclusão** precisa ser pelo menos 1 minuto depois do início.');
  }
  if (!cfg.channelId) errors.push('Escolha o **canal/tópico** do sorteio.');
  if (cfg.allowedRoleIds.some((r) => cfg.blockedRoleIds.includes(r))) errors.push('Um cargo não pode ser **permitido e bloqueado** ao mesmo tempo.');
  if (cfg.allowedUserIds.some((u) => cfg.blockedUserIds.includes(u))) errors.push('Um membro não pode ser **permitido e bloqueado** ao mesmo tempo.');
  const wr = cfg.winnerRoles;
  if (wr.grantRoleIds.some((r) => wr.removeRoleIds.includes(r))) errors.push('Um cargo não pode ser **conferido e removido** do ganhador ao mesmo tempo.');
  if (cfg.cooldown.giveaways > 0 && cfg.cooldown.days > 0) errors.push('No afastamento do ganhador, use **sorteios ou dias**, não os dois.');
  if (!cfg.message.blocks.length) errors.push('A mensagem precisa ter pelo menos um bloco.');
  if (countComponents(cfg.message.blocks) > LIMITS.maxComponents) errors.push('A mensagem tem componentes demais para o Discord. Remova alguns blocos.');
  if (totalText(cfg.message.blocks) > LIMITS.totalText) errors.push(`O texto da mensagem passa de ${LIMITS.totalText} caracteres.`);
  return errors;
}

// ---------------------------------------------------------------------------
// Placeholders — substituição em uma única passada (o valor inserido nunca é reprocessado)
// ---------------------------------------------------------------------------
function breakMentions(s) { return String(s).replace(/@(everyone|here)/gi, '@\u200b$1'); }
const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

function placeholderValues(ctx) {
  const winners = Array.isArray(ctx.winnerIds) ? ctx.winnerIds : [];
  const mention = (id) => `<@${id}>`;
  return {
    host: ctx.hostId ? mention(ctx.hostId) : '—',
    giveaway: breakMentions(ctx.name || '—'),
    users: winners.length ? winners.map(mention).join(', ') : (ctx.preview ? '@Ganhador1, @Ganhador2' : '—'),
    winners: String(ctx.winnerCount ?? winners.length ?? 0),
    participants: String(ctx.participants ?? 0),
    min: String(ctx.min ?? 1),
    max: ctx.max > 0 ? String(ctx.max) : '∞',
    channel: ctx.channelId ? `<#${ctx.channelId}>` : '—',
    start: ctx.startsAt ? `<t:${unix(ctx.startsAt)}:f>` : '—',
    end: ctx.endsAt ? `<t:${unix(ctx.endsAt)}:f>` : '—',
    endrelative: ctx.endsAt ? `<t:${unix(ctx.endsAt)}:R>` : '—',
    link: ctx.messageUrl || '—',
    date: `<t:${unix(ctx.now ?? new Date())}:D>`,
  };
}

function renderPlaceholders(text, ctx) {
  const values = placeholderValues(ctx);
  const winners = Array.isArray(ctx.winnerIds) ? ctx.winnerIds : [];
  return String(text ?? '').replace(/\{(user\d{1,2}|[a-z]+)\}/g, (whole, key) => {
    const n = /^user(\d{1,2})$/.exec(key);
    if (n) {
      const idx = Number(n[1]) - 1;
      if (idx < 0) return whole;
      if (winners[idx]) return `<@${winners[idx]}>`;
      return ctx.preview ? `@Ganhador${idx + 1}` : '—';
    }
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole;
  });
}

// ---------------------------------------------------------------------------
// Afastamento de ganhadores recentes
// ---------------------------------------------------------------------------
// rows: { mode:'days'|'giveaways', amount, until:Date|string|null, seqAtWin:number }
function cooldownStatus(rows, concludedCount, now = new Date()) {
  let days = 0; let giveaways = 0; let until = null;
  for (const r of rows || []) {
    if (r.mode === 'days' && r.until) {
      const u = new Date(r.until);
      const remaining = Math.ceil((u.getTime() - now.getTime()) / 86_400_000);
      if (remaining > 0) { days = Math.max(days, remaining); if (!until || u > until) until = u; }
    } else if (r.mode === 'giveaways') {
      const remaining = Number(r.amount) - (Number(concludedCount) - Number(r.seqAtWin));
      if (remaining > 0) giveaways = Math.max(giveaways, remaining);
    }
  }
  return { active: days > 0 || giveaways > 0, days, giveaways, until };
}

// Decide se o membro pode entrar. Chamada dentro da transação (com a linha travada).
function checkJoin({ config, status, endsAt, count, alreadyJoined, memberRoleIds, userId, globalRules, cooldowns, concludedCount, now = new Date() }) {
  if (status !== 'active') return { ok: false, reason: 'closed' };
  if (endsAt && new Date(endsAt).getTime() <= now.getTime()) return { ok: false, reason: 'closed' };
  if (alreadyJoined) return { ok: false, reason: 'already' };
  const roles = new Set(memberRoleIds || []);
  // regras globais (todos os sorteios) e depois as do próprio sorteio; bloqueio sempre vence
  const violation = ruleViolation(globalRules, userId, roles) || ruleViolation(config, userId, roles);
  if (violation) return { ok: false, ...violation };
  const cd = cooldownStatus(cooldowns, concludedCount, now);
  if (cd.active) return { ok: false, reason: 'cooldown', ...cd };
  if (config.maxParticipants > 0 && count >= config.maxParticipants) return { ok: false, reason: 'full' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sorteio — crypto.randomInt, Fisher–Yates parcial
// ---------------------------------------------------------------------------
function pickWinners(pool, n, rng = randomInt) {
  const arr = [...new Set(pool)];
  const count = Math.min(Math.max(0, n), arr.length);
  for (let i = 0; i < count; i += 1) {
    const j = i + rng(arr.length - i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

// ---------------------------------------------------------------------------
// Datas e durações (fuso do servidor; padrão America/Sao_Paulo)
// ---------------------------------------------------------------------------
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}

function zonedToUtc(y, mo, d, h, mi, timeZone) {
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wanted);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  let guess = wanted;
  for (let k = 0; k < 3; k += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const diff = wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

// "25/12/2026 20:00" ou "25/12 20:00" (ano atual do fuso). Devolve Date ou null.
function parseDateTime(text, timeZone = 'America/Sao_Paulo', now = new Date()) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2})[:h](\d{2})\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const year = m[3] ? Number(m[3]) : zonedParts(now, timeZone).year;
  return zonedToUtc(year, Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), timeZone);
}

function formatDateTime(date, timeZone = 'America/Sao_Paulo') {
  const p = zonedParts(new Date(date), timeZone);
  const z = (n) => String(n).padStart(2, '0');
  return `${z(p.day)}/${z(p.month)}/${p.year} ${z(p.hour)}:${z(p.minute)}`;
}

// "90m", "2h", "1d 12h", "1h30m" → minutos (ou null)
function parseDuration(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const re = /(\d{1,4})\s*(dias?|d|horas?|h|minutos?|min|m)(?![a-zç])/g;
  let total = 0; let matched = 0; let rest = s; let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    const unit = m[2][0];
    total += unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n;
    matched += 1;
    rest = rest.replace(m[0], '');
  }
  if (!matched || rest.replace(/[\s,]|e/g, '') !== '') return null;
  return total >= 1 && total <= LIMITS.maxDurationMinutes ? total : null;
}

function formatDuration(minutes) {
  const d = Math.floor(minutes / 1440); const h = Math.floor((minutes % 1440) / 60); const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}min`].filter(Boolean).join(' ') || '0min';
}

function parseColor(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s || ['nenhuma', 'nenhum', 'sem', 'sem cor', 'none', 'não', 'nao'].includes(s)) return { ok: true, value: null };
  const m = /^#?([0-9a-f]{6})$/.exec(s);
  return m ? { ok: true, value: parseInt(m[1], 16) } : { ok: false };
}

module.exports = {
  LIMITS, DEFAULT_ACCENT, DEFAULT_THREAD_MESSAGE, PLACEHOLDER_DOCS,
  defaultConfig, defaultBlocks, normalizeConfig, normalizeBlock, normalizeWinnerRoles, normalizeRules, emptyRules, mergeRules, ruleViolation, safeUrl, isSnowflake,
  countComponents, totalText, validateConfig,
  renderPlaceholders, breakMentions,
  cooldownStatus, checkJoin, pickWinners,
  parseDateTime, formatDateTime, parseDuration, formatDuration, parseColor, zonedToUtc,
};
