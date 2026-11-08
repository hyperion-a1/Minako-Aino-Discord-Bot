'use strict';
// Modelo de visão e texto da Central. PURO: recebe dados reais e devolve texto.
// Regras: nunca inventar números; previsão só com dados suficientes; estado vazio explícito;
// nomes só onde a pessoa decidiu participar publicamente (criar/entrar em grupo).

function relativeTime(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'agora há pouco';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

// Janela de 2 h com maior atividade. Só retorna algo com histórico suficiente.
function peakWindow({ hourly, days }, { minDays = 14, minTotal = 50 } = {}) {
  if (!Array.isArray(hourly) || hourly.length !== 24) return null;
  const total = hourly.reduce((a, b) => a + b, 0);
  if (days < minDays || total < minTotal) return null;
  let best = -1, start = 0;
  for (let h = 0; h < 24; h++) {
    const v = hourly[h] + hourly[(h + 1) % 24];
    if (v > best) { best = v; start = h; }
  }
  return { startHour: start, endHour: (start + 2) % 24 };
}

const pad = (h) => String(h).padStart(2, '0');

// Atividade recente (sem expor nomes, salvo criação/entrada em grupo público).
function feedLine(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'group.created': return p.organizerId ? `<@${p.organizerId}> abriu um grupo` : 'Um grupo foi aberto';
    case 'group.joined': return p.userId ? `<@${p.userId}> entrou em um grupo` : 'Alguém entrou em um grupo';
    case 'proposal.confirmed': return 'Uma equipe foi formada pela fila';
    case 'group.completed': return 'Uma partida foi registrada';
    default: return null;
  }
}

function buildView(data, modes, now = Date.now()) {
  const label = (id) => modes.find(m => m.id === id)?.label || id;
  const groups = (data.openGroups || []).map(g => ({ id: g.id, mode: label(g.modeId), free: g.free, capacity: g.capacity, confirmed: g.confirmed }));
  const recent = (data.recentEvents || []).map(ev => ({ text: feedLine(ev), at: ev.at })).filter(x => x.text).slice(0, 5);
  const vm = {
    availableNow: data.availableNow || 0,
    groups,
    freeSlots: groups.reduce((a, g) => a + g.free, 0),
    pendingProposals: data.pendingProposals || 0,
    matchesToday: data.matchesToday || 0,
    weekly: { groupsFormed: data.weekGroups || 0, matchesRegistered: data.weekMatches || 0 },
    recent, peak: peakWindow(data.hourlyActivity || { hourly: [], days: 0 }),
  };
  vm.empty = vm.availableNow === 0 && groups.length === 0 && vm.pendingProposals === 0;
  vm.now = now;
  return vm;
}

function renderText(vm, { emoji = {} } = {}) {
  const lines = [];
  lines.push(`## ${emoji.hok || '🎮'} Central de Matchmaking`);
  lines.push('*Encontre jogadores, entre em grupos ou abra o seu. Tudo por aqui.*');
  lines.push('');
  if (vm.empty) {
    lines.push('Ninguém está procurando partida agora e não há grupos abertos.');
    lines.push('Seja a primeira pessoa: toque em **Quero jogar agora** ou **Criar grupo**.');
  } else {
    lines.push(`🟢 **Disponíveis agora:** ${vm.availableNow}`);
    lines.push(`👥 **Grupos abertos:** ${vm.groups.length} · **${vm.freeSlots}** vaga${vm.freeSlots === 1 ? '' : 's'}`);
    lines.push(`📨 **Propostas em andamento:** ${vm.pendingProposals}`);
    for (const g of vm.groups.slice(0, 5)) lines.push(`• ${g.mode} — ${g.confirmed}/${g.capacity} (${g.free} vaga${g.free === 1 ? '' : 's'})`);
    if (vm.groups.length > 5) lines.push(`• …e mais ${vm.groups.length - 5} grupo(s) no canal de grupos abertos`);
  }
  lines.push('');
  lines.push(`🏁 **Partidas registradas hoje:** ${vm.matchesToday}`);
  lines.push(`📈 **Últimos 7 dias:** ${vm.weekly.groupsFormed} grupo(s) · ${vm.weekly.matchesRegistered} partida(s) registrada(s)`);
  if (vm.peak) lines.push(`⏰ **Costuma ter mais gente:** ${pad(vm.peak.startHour)}h–${pad(vm.peak.endHour)}h`);
  if (vm.recent.length) {
    lines.push('', '**Atividade recente**');
    for (const r of vm.recent) lines.push(`• ${r.text} · ${relativeTime(r.at, vm.now)}`);
  }
  lines.push('', `-# Atualizado <t:${Math.floor(vm.now / 1000)}:R>`);
  return lines.join('\n');
}

module.exports = { relativeTime, peakWindow, buildView, renderText, feedLine };
