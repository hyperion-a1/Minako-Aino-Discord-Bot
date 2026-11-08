'use strict';
// Validação e conversão dos campos digitados nos formulários do painel. PURO.
const core = require('./mmCore');

class ConfigError extends Error {}
function num(raw, label) {
  const n = Number(String(raw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n)) throw new ConfigError(`"${label}" precisa ser um número.`);
  return n;
}
function inRange(sec, key, label, unit) {
  const [min, max] = core.BOUNDS[key];
  if (sec < min || sec > max) throw new ConfigError(`"${label}" deve ficar entre ${fmt(min)} e ${fmt(max)} (${unit}).`);
  return Math.round(sec);
}
const fmt = (sec) => (sec >= 86400 ? `${sec / 86400} d` : sec >= 3600 ? `${sec / 3600} h` : sec >= 60 ? `${sec / 60} min` : `${sec} s`);

function parseDeadlines(f) {
  return {
    proposalTtlSec: inRange(num(f.proposta, 'Proposta') * 60, 'proposalTtlSec', 'Proposta', 'minutos'),
    availabilityTtlSec: inRange(num(f.disponibilidade, 'Disponibilidade') * 60, 'availabilityTtlSec', 'Disponibilidade', 'minutos'),
    replacementTtlSec: inRange(num(f.substituto, 'Substituto') * 60, 'replacementTtlSec', 'Substituto', 'minutos'),
    confirmationWindowSec: inRange(num(f.janela, 'Confirmação da partida') * 3600, 'confirmationWindowSec', 'Confirmação da partida', 'horas'),
    archiveAfterSec: inRange(num(f.arquivo, 'Arquivamento') * 86400, 'archiveAfterSec', 'Arquivamento', 'dias'),
  };
}
function parseSearch(f) {
  const a = Math.round(num(f.relax1, '1ª etapa') * 60); const b = Math.round(num(f.relax2, '2ª etapa') * 60);
  if (a < 60 || b <= a || b > 7200) throw new ConfigError('As etapas de relaxamento precisam ser: 1ª a partir de 1 min e 2ª maior que a 1ª (máx. 120 min).');
  return {
    relaxAfterSec: [a, b],
    centralMinRefreshSec: inRange(num(f.refresh, 'Atualização da Central'), 'centralMinRefreshSec', 'Atualização da Central', 'segundos'),
    groupInactivityTtlSec: inRange(num(f.inatividade, 'Inatividade de grupos abertos') * 60, 'groupInactivityTtlSec', 'Inatividade de grupos abertos', 'minutos'),
    teamConfirmTtlSec: inRange(num(f.equipe, 'Confirmação de membros da equipe') * 60, 'teamConfirmTtlSec', 'Confirmação de membros da equipe', 'minutos'),
  };
}
function parseRoleCatalog(text) {
  const list = [...new Set(String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  if (!list.length) throw new ConfigError('Informe pelo menos uma função.');
  if (list.length > 10) throw new ConfigError('Use no máximo 10 funções.');
  if (list.some(s => s.length > 40)) throw new ConfigError('Cada função pode ter no máximo 40 caracteres.');
  return list;
}
const slug = (label) => String(label).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
function yesNo(raw, label) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['sim', 's', 'yes', 'y', '1'].includes(v)) return true;
  if (['nao', 'não', 'n', 'no', '0', ''].includes(v)) return false;
  throw new ConfigError(`"${label}" aceita apenas sim ou não.`);
}
// existing: modo atual (edição) ou null (novo). modes: lista atual (para unicidade do ID).
function parseMode(f, existing, modes) {
  const label = String(f.label || '').trim();
  if (!label || label.length > 40) throw new ConfigError('O nome do modo precisa ter de 1 a 40 caracteres.');
  const ideal = num(f.ideal, 'Jogadores (ideal)'); const min = num(f.min, 'Jogadores (mínimo)');
  if (!Number.isInteger(ideal) || ideal < 2 || ideal > 10) throw new ConfigError('"Jogadores (ideal)" deve ser um inteiro de 2 a 10.');
  if (!Number.isInteger(min) || min < 2 || min > ideal) throw new ConfigError('"Jogadores (mínimo)" deve ser um inteiro entre 2 e o ideal.');
  const allowIncomplete = yesNo(f.incomplete, 'Permite grupo incompleto');
  const eloRaw = String(f.elo ?? '').trim();
  let eloRelevant = false; let eloWindow = 2;
  if (eloRaw) { const w = num(eloRaw, 'Faixas de elo'); if (!Number.isInteger(w) || w < 0 || w > 9) throw new ConfigError('"Faixas de elo" deve ser um inteiro de 0 a 9 (vazio = o modo não usa elo).'); eloRelevant = true; eloWindow = w; }
  let id = existing?.id;
  if (!id) {
    id = slug(label); if (!id) throw new ConfigError('Use letras ou números no nome do modo.');
    if (modes.some(m => m.id === id)) throw new ConfigError('Já existe um modo com esse nome.');
  }
  return core.makeMode({ ...(existing || {}), id, label, idealSize: ideal, minSize: min, allowIncomplete, eloRelevant, eloWindow, slots: existing && existing.idealSize === ideal ? existing.slots : undefined, active: existing ? existing.active : true });
}


// Composição por vaga: uma linha por vaga, "livre" ou o nome de uma função do catálogo. Linhas a menos = vagas livres.
function parseSlots(text, mode, catalog) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length > mode.idealSize) throw new ConfigError(`Este modo tem ${mode.idealSize} vagas; você informou ${lines.length} linhas.`);
  const byLower = new Map(catalog.map(c => [c.toLowerCase(), c]));
  const slots = lines.map((l, i) => {
    if (['livre', 'qualquer', '-'].includes(l.toLowerCase())) return { role: null };
    const role = byLower.get(l.toLowerCase());
    if (!role) throw new ConfigError(`Linha ${i + 1}: "${l}" não está no catálogo de funções (${catalog.join(', ')}). Use "livre" para vaga sem função.`);
    return { role };
  });
  while (slots.length < mode.idealSize) slots.push({ role: null });
  return slots;
}
const slotsText = (mode) => mode.slots.map(sl => sl.role || 'livre').join('\n');
const slotsSummary = (mode) => { const r = mode.slots.filter(sl => sl.role).map(sl => sl.role); return r.length ? `funções fixas: ${r.join(', ')}` : ''; };

// Horário silencioso: hora cheia de início e de fim (0 a 23), diferentes entre si; pode atravessar a meia-noite.
function parseQuiet(fromRaw, toRaw) {
  const from = num(fromRaw, 'Início'); const to = num(toRaw, 'Fim');
  if (![from, to].every(h => Number.isInteger(h) && h >= 0 && h <= 23)) throw new ConfigError('Use horas inteiras de 0 a 23 (ex.: 22 e 8).');
  if (from === to) throw new ConfigError('O início e o fim precisam ser diferentes.');
  return { from, to };
}
// Alerta de atividade da comunidade (administração). min = 0 desliga.
function parseCommunity(f) {
  const min = num(f.min, 'Mínimo de pessoas disponíveis');
  if (!Number.isInteger(min) || min < 0 || min > 50) throw new ConfigError('"Mínimo de pessoas disponíveis" deve ser um inteiro de 0 a 50 (0 desliga o alerta).');
  return { communityAlertMin: min, communityAlertCooldownSec: inRange(num(f.cooldown, 'Intervalo entre alertas') * 60, 'communityAlertCooldownSec', 'Intervalo entre alertas', 'minutos') };
}

module.exports = { parseQuiet, parseCommunity, parseSlots, slotsText, slotsSummary, ConfigError, parseDeadlines, parseSearch, parseRoleCatalog, parseMode, slug, fmt };
