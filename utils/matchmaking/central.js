'use strict';
// Central de Matchmaking: UMA mensagem permanente, editada (não recriada). Recriada só se sumir,
// com compare-and-set no banco para nunca duplicar. Atualizações são agrupadas por limite de taxa.
const {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const crypto = require('node:crypto');
const store = require('./store');
const view = require('./centralView');
const { EMOJIS } = require('../minakoEmojis');

// Botões da v1 (cada um tem fluxo implementado antes de a Central ser habilitada).
const CENTRAL_BUTTONS = [
  ['minako-mm:play', 'Quero jogar agora', '🎮', ButtonStyle.Success],
  ['minako-mm:groups', 'Grupos abertos', '🔎', ButtonStyle.Primary],
  ['minako-mm:create', 'Criar grupo', '➕', ButtonStyle.Primary],
  ['minako-mm:team', 'Minhas equipes', '👥', ButtonStyle.Secondary],
  ['minako-mm:prefs', 'Minhas preferências', '⚙️', ButtonStyle.Secondary],
];

function buildPayload(vm) {
  const text = view.renderText(vm, { emoji: EMOJIS });
  const row = new ActionRowBuilder().addComponents(CENTRAL_BUTTONS.map(([id, label, emoji, style]) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style)));
  const container = new ContainerBuilder().setAccentColor(0xffb21a)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(row);
  return { payload: { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }, text };
}
// O hash ignora o carimbo "Atualizado", para não editar à toa quando nada mudou.
const LAYOUT = 'layout:3'; // muda quando os botões mudam: força uma edição única após atualizações
const contentHash = (text) => crypto.createHash('sha1').update(LAYOUT + text.replace(/\n-# Atualizado.*$/s, '')).digest('hex');

const VERIFY_EVERY_MS = 60_000; // confere na API (sem cache) se a mensagem ainda existe
const state = new Map(); // guildId -> { lastAt, hash, verifiedAt, timer, running, again }
const st = (g) => { if (!state.has(g)) state.set(g, { lastAt: 0, hash: null, verifiedAt: 0, timer: null, running: false, again: false }); return state.get(g); };
// "Mensagem/canal inexistente": o discord.js expõe o código em e.code (e, por segurança, em rawError.code).
const isUnknownMessage = (e) => [e?.code, e?.rawError?.code].some(c => c === 10008 || c === 10003) || (e?.status === 404 && /unknown (message|channel)/i.test(String(e?.message)));

async function fetchChannel(client, id) {
  try { const ch = await client.channels.fetch(id); return ch?.isTextBased?.() ? ch : null; }
  catch (e) { if (isUnknownMessage(e)) return null; throw e; }
}
// IMPORTANTE: sem a intent de mensagens o bot NÃO recebe "mensagem apagada"; por isso o cache pode devolver
// uma mensagem que já não existe. force:true consulta a API de verdade.
async function fetchCentralMessage(channel, messageId) {
  if (!messageId) return null;
  try { return await channel.messages.fetch({ message: messageId, force: true }); }
  catch (e) { if (isUnknownMessage(e)) return null; throw e; }
}

// Atualiza (ou recria) a Central. Devolve { ok, action } ou { ok:false, reason }.
async function renderNow(client, guildId, { force = false, now = Date.now() } = {}) {
  const cfg = await store.getSettings(guildId);
  if (!cfg.centralChannelId) return { ok: false, reason: 'NO_CHANNEL' };
  const channel = await fetchChannel(client, cfg.centralChannelId);
  if (!channel) return { ok: false, reason: 'CHANNEL_MISSING' };
  const me = channel.guild?.members?.me;
  const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
  if (perms && !(perms.has('ViewChannel') && perms.has('SendMessages'))) return { ok: false, reason: 'PERMISSIONS' };

  const data = await store.getCentralData(guildId);
  const vm = view.buildView(data, cfg.modes);
  const { payload, text } = buildPayload(vm);
  const hash = contentHash(text);
  const s = st(guildId);
  const verifyDue = force || now - s.verifiedAt >= VERIFY_EVERY_MS;
  if (!verifyDue && s.hash === hash) return { ok: true, action: 'unchanged' };

  let message = await fetchCentralMessage(channel, cfg.centralMessageId);
  if (message) {
    s.verifiedAt = now;
    if (!force && s.hash === hash) return { ok: true, action: 'unchanged' };
    try {
      await message.edit(payload);
      s.hash = hash; s.lastAt = now;
      return { ok: true, action: 'edited' };
    } catch (e) {
      if (!isUnknownMessage(e)) throw e;   // a mensagem sumiu entre a consulta e a edição: recria abaixo
      message = null;
    }
  }
  // Mensagem apagada (ou nunca criada): recria UMA vez. O compare-and-set impede duplicatas.
  const created = await channel.send(payload);
  const won = await store.claimCentralMessage(guildId, cfg.centralMessageId, created.id);
  if (!won) { await created.delete().catch(() => {}); s.hash = null; return { ok: true, action: 'already-recreated' }; }
  s.hash = hash; s.lastAt = now; s.verifiedAt = now;
  return { ok: true, action: cfg.centralMessageId ? 'recreated' : 'created', messageId: created.id };
}

// Ponto de entrada para eventos relevantes e para o agendador. Agrupa edições dentro do intervalo mínimo.
async function requestRefresh(client, guildId, { force = false, onProblem } = {}) {
  const s = st(guildId);
  if (s.running) { s.again = true; return; }
  const cfg = await store.getSettings(guildId);
  const wait = force ? 0 : Math.max(0, s.lastAt + cfg.settings.centralMinRefreshSec * 1000 - Date.now());
  if (wait > 0) {
    if (!s.timer) { s.timer = setTimeout(() => { s.timer = null; void requestRefresh(client, guildId, { onProblem }); }, wait); s.timer.unref?.(); }
    return;
  }
  s.running = true;
  try {
    const r = await renderNow(client, guildId, { force });
    if (!r.ok && r.reason !== 'NO_CHANNEL') onProblem?.(guildId, r.reason);
  } catch (e) {
    console.error(`[matchmaking] Falha ao atualizar a Central (${guildId}):`, e.message);
    onProblem?.(guildId, 'ERROR', e);
  } finally {
    s.running = false;
    if (s.again) { s.again = false; void requestRefresh(client, guildId, { onProblem }); }
  }
}

// Verificação periódica (reconciliação): detecta Central apagada mesmo sem evento.
async function tick(client, opts = {}) {
  for (const guildId of await store.listCentralGuilds()) await requestRefresh(client, guildId, opts);
}

module.exports = { CENTRAL_BUTTONS, buildPayload, contentHash, renderNow, requestRefresh, tick, isUnknownMessage };
