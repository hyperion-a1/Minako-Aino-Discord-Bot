'use strict';
// Motor da fila: forma propostas, envia DMs, trata respostas/expirações e avisa os afetados.
// Nada aqui decide regras (isso é mmCore) nem toca SQL diretamente (isso é store).
const {
  ContainerBuilder, TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const store = require('./store');
const core = require('./mmCore');
const notify = require('./notify');
const socialFlow = require('./socialFlow');

const V2 = MessageFlags.IsComponentsV2;
const box = (text, buttons = []) => {
  const c = new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (buttons.length) c.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  return { components: [c], flags: V2, allowedMentions: { parse: [] } };
};
const btn = (id, label, emoji, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

function proposalPayload(proposal, mode, forUserId, { state = 'pending' } = {}) {
  const others = proposal.members.filter(m => m.userId !== forUserId).map(m => `<@${m.userId}>`);
  const ts = Math.floor(proposal.expiresAt / 1000);
  const header = `## 🎮 Encontrei uma equipe para você\n**Modo:** ${mode?.label || proposal.modeId} · **Jogadores:** ${proposal.members.length}${proposal.incomplete ? ' (grupo incompleto)' : ''}\n**Com você:** ${others.join(', ') || '—'}\n`;
  if (state === 'pending') {
    return box(`${header}\nResponda <t:${ts}:R>. A equipe só se forma se **todos** aceitarem; recusar ou não responder não tem nenhuma penalidade.`, [
      btn(`minako-mm:prop:a:${proposal.id}`, 'Aceitar', '✅', ButtonStyle.Success),
      btn(`minako-mm:prop:d:${proposal.id}`, 'Recusar', '✖️', ButtonStyle.Secondary),
    ]);
  }
  const texts = {
    waiting: `${header}\n✅ Você aceitou. Aguardando os demais jogadores…`,
    confirmed: `${header}\n🎉 **Equipe confirmada!** Todos aceitaram. Vou preparar o espaço do grupo.`,
    declined: `${header}\nVocê recusou. Tudo bem — sem penalidade. Sua disponibilidade segue como estava.`,
    expired: `${header}\n⌛ O prazo acabou e esta proposta foi encerrada.`,
    cancelled: `${header}\nEsta proposta não seguiu adiante (alguém recusou).`,
  };
  return box(texts[state] || texts.expired);
}

async function dmFor(client, userId) { const user = await client.users.fetch(userId); return user.createDM(); }
async function editDm(client, member, payload) {
  if (!member.dmChannelId || !member.dmMessageId) return false;
  try {
    const dm = await dmFor(client, member.userId);
    const msg = await dm.messages.fetch(member.dmMessageId);
    await msg.edit(payload); return true;
  } catch { return false; }
}

async function sendProposalDMs(client, guildId, proposalId, mode) {
  const proposal = await store.getProposal(proposalId);
  for (const m of proposal.members) {
    const r = await notify.send(client, guildId, m.userId, 'actions', proposalPayload(proposal, mode, m.userId));
    if (r.sent && r.message) await store.setProposalDm(proposalId, m.userId, r.message.channelId, r.message.id);
    // Destino indisponível: NUNCA troca de canal sem consentimento. A proposta continua visível em "Quero jogar agora".
    else if (r.reason === 'failed') await store.logEvent(guildId, 'proposal.dm_failed', { proposalId, userId: m.userId });
  }
}

async function runMatching(client, guildId, now = Date.now()) {
  const cfg = await store.getSettings(guildId);
  const queue = await store.listQueue(guildId);
  if (queue.length < 2) return 0;
  const blocked = await store.blockedPairs(guildId);
  let created = 0;
  for (const mode of cfg.modes.filter(m => m.active)) {
    for (const p of core.buildProposals(queue, mode, now, cfg.settings, { blocked })) {
      try {
        const id = await store.createProposal(guildId, p);
        created++;
        await sendProposalDMs(client, guildId, id, mode);
      } catch (e) {
        if (!['NOT_AVAILABLE', 'ALREADY_PROPOSED', 'INCOMPATIBLE_COMMITMENT'].includes(e.code)) console.error('[matchmaking] proposta falhou:', e.message);
      }
    }
  }
  return created;
}

// Atualiza as DMs de todos após um desfecho. Quem continua na fila é avisado de forma clara.
async function notifyOutcome(client, result, mode) {
  const proposal = await store.getProposal(result.proposalId);
  if (!proposal) return;
  const requeue = new Set(result.requeue || []);
  for (const m of proposal.members) {
    const state = result.outcome === 'confirmed' ? 'confirmed'
      : result.declined?.includes(m.userId) ? 'declined'
      : result.outcome === 'expired' ? 'expired' : 'cancelled';
    await editDm(client, m, proposalPayload(proposal, mode, m.userId, { state }));
    if (result.outcome !== 'confirmed' && requeue.has(m.userId)) {
      await notify.send(client, proposal.guildId, m.userId, 'actions', box('🔎 Essa proposta não seguiu adiante, mas **continuo procurando** uma equipe para você. Sua disponibilidade segue ativa.'));
    }
  }
}

async function handleSweeps(client) {
  for (const r of await store.sweepExpiredProposals()) {
    const guildId = await store.proposalGuildId(r.proposalId);
    const cfg = guildId ? await store.getSettings(guildId) : null;
    const p = await store.getProposal(r.proposalId);
    await notifyOutcome(client, r, cfg?.modes.find(m => m.id === p?.modeId));
  }
  // Aviso de expiração: só para quem habilitou em "Minhas preferências". Uma vez por disponibilidade.
  for (const w of await store.claimExpiryWarnings()) {
    await notify.send(client, w.guildId, w.userId, 'expiry', box(`⏳ Sua disponibilidade para jogar expira <t:${Math.floor(w.expiresAt / 1000)}:R>. Quer continuar procurando?`, [
      btn(`minako-mm:av:renew:${w.guildId}`, 'Renovar', '🔄', ButtonStyle.Success)]), { track: { kind: 'expw', ref: w.userId } });
  }
  await socialFlow.sweepInvites(client);
  for (const x of await store.sweepExpiredAvailability()) await notify.closeOps(client, x.guildId, 'expw', x.userId, { text: 'Sua disponibilidade expirou. Use **Quero jogar agora** quando quiser voltar.' });
}

let timer = null; let running = false;
function start(client, { intervalMs = 10_000, onCentral } = {}) {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return; running = true;
    try {
      await handleSweeps(client);
      for (const g of await store.listCentralGuilds()) await runMatching(client, g);
      await onCentral?.();
    } catch (e) { console.error('[matchmaking] ciclo do motor:', e.message); }
    finally { running = false; }
  }, intervalMs);
  timer.unref?.();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { proposalPayload, runMatching, notifyOutcome, handleSweeps, sendProposalDMs, start, stop, box, btn };
