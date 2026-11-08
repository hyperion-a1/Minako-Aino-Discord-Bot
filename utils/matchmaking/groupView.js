'use strict';
// Texto do anúncio público de um grupo. PURO. Reflete o estado real: confirmados, vagas, pedidos (só contagem).
const core = require('./mmCore');
const rankName = (i) => core.RANKS[i]?.[1] || '?';

function roleLine(group) {
  const taken = new Set(group.members.map(m => m.role).filter(Boolean));
  const open = (group.requiredRoles || []).filter(r => !taken.has(r));
  return open.length ? `**Funções necessárias:** ${open.join(', ')}` : '';
}

function renderAnnouncement(group, modeLabel, { now = Date.now() } = {}) {
  const lines = [`## 🔎 Grupo · ${modeLabel}`];
  const stateLine = {
    open: group.free > 0 ? '🟢 **Aberto**' : '🟡 **Completo — aguardando confirmação**',
    confirmed: '✅ **Equipe confirmada**',
    searching_replacement: `🔄 **Procurando substituto**${group.searchUntil ? ` até <t:${Math.floor(group.searchUntil / 1000)}:R>` : ''}`,
    completed: '🏁 **Partida concluída**',
    closed: '⚪ **Encerrado**',
  }[group.state] || group.state;
  lines.push(stateLine);
  if (group.teamName) lines.push(`**Equipe:** ${group.teamName}${group.teamId ? ` (#${group.teamId})` : ''}`);
  lines.push(`**Organizador:** <@${group.organizerId}>`);
  lines.push(`**Vagas:** ${group.confirmed}/${group.capacity} confirmados · **${group.free}** livre${group.free === 1 ? '' : 's'}`);
  if (group.reserved > 0 && ['open', 'searching_replacement'].includes(group.state)) lines.push(`⏳ ${group.reserved} membro${group.reserved === 1 ? '' : 's'} da equipe ainda confirmando; as vagas abaixo são só as realmente abertas.`);
  lines.push(`**Entrada:** ${group.joinMethod === 'approval' ? 'mediante aprovação do organizador' : 'direta'}`);
  if (group.eloRange) lines.push(`**Elo:** ${rankName(group.eloRange[0])} a ${rankName(group.eloRange[1])}`);
  const rl = roleLine(group); if (rl) lines.push(rl);
  if (group.allowIncomplete && ['open', 'searching_replacement'].includes(group.state)) lines.push('*O organizador pode começar com menos jogadores.*');
  lines.push('', `**Participantes:** ${group.members.map(m => `<@${m.userId}>${m.role ? ` (${m.role})` : ''}`).join(', ') || '—'}`);
  if (group.joinMethod === 'approval' && group.pending?.length && ['open', 'searching_replacement'].includes(group.state)) {
    lines.push(`📨 ${group.pending.length} pedido(s) aguardando aprovação`); // só a contagem; pedidos não ocupam vaga
  }
  return lines.join('\n');
}

const isJoinable = (group) => ['open', 'searching_replacement'].includes(group.state) && group.free > 0;

module.exports = { renderAnnouncement, isJoinable, roleLine, rankName };
