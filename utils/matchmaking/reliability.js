'use strict';
// Histórico de confiabilidade: regras PURAS. Princípios do briefing (2.19):
//  - registra fatos (entrou, concluiu, saiu cedo, saiu tarde); NÃO registra silêncio nem recusa (não são infração);
//  - sem pontuação numérica pública e sem punição automática: o resultado só serve para a própria pessoa, a administração
//    e, no futuro, recomendações internas e discretas;
//  - um cancelamento isolado nunca é "padrão": só há "atenção" com volume e proporção suficientes;
//  - registros em disputa não entram na conta até a revisão.
const KINDS = Object.freeze(['joined', 'completed', 'left_early', 'left_late']);
const LABEL = Object.freeze({ joined: 'Entrou em um grupo', completed: 'Partida concluída', left_early: 'Saiu antes de a equipe fechar', left_late: 'Saiu depois de a equipe fechar' });
const RULES = Object.freeze({
  windowDays: 90, retentionDays: 180,
  minCommitments: 5,        // com menos entradas que isso na janela, não há dados para falar em padrão
  minLateExits: 3,          // e ao menos 3 saídas tardias...
  lateShare: 0.4,           // ...e pelo menos 40% das entradas
  maxOpenDisputes: 5,
});
const DAY = 86400_000;

// records: [{ kind, at (ms), status: 'active'|'disputed'|'removed' }]
function summarize(records, now, { windowDays = RULES.windowDays } = {}) {
  const inWindow = records.filter(r => now - r.at <= windowDays * DAY && KINDS.includes(r.kind));
  const counted = inWindow.filter(r => r.status === 'active');          // disputados e removidos NÃO contam
  const counts = Object.fromEntries(KINDS.map(k => [k, counted.filter(r => r.kind === k).length]));
  const disputed = inWindow.filter(r => r.status === 'disputed').length;
  let pattern = 'insufficient';
  if (counts.joined >= RULES.minCommitments) {
    pattern = counts.left_late >= RULES.minLateExits && counts.left_late / counts.joined >= RULES.lateShare ? 'attention' : 'steady';
  }
  return { windowDays, counts, disputed, pattern };
}

// Texto neutro, nunca acusatório. Um evento isolado jamais aparece como problema.
function describe(summary) {
  const c = summary.counts;
  const base = `Nos últimos ${summary.windowDays} dias: **${c.joined}** entrada${c.joined === 1 ? '' : 's'} em grupos · **${c.completed}** partida${c.completed === 1 ? '' : 's'} concluída${c.completed === 1 ? '' : 's'} · **${c.left_early}** saída${c.left_early === 1 ? '' : 's'} antes de fechar · **${c.left_late}** depois de fechar.`;
  const note = {
    insufficient: 'Ainda há poucos registros para dizer qualquer coisa sobre padrão — e um cancelamento isolado nunca é tratado como padrão.',
    steady: 'Nada fora do comum por aqui. Imprevistos acontecem e tudo bem.',
    attention: 'Notei algumas saídas depois de a equipe fechar. Imprevisto acontece e **não há punição**; se algum registro estiver errado, peça revisão abaixo.',
  }[summary.pattern];
  return `${base}\n${note}${summary.disputed ? `\n(${summary.disputed} registro${summary.disputed === 1 ? '' : 's'} em revisão não ${summary.disputed === 1 ? 'entra' : 'entram'} na conta.)` : ''}`;
}

// Qual registro gerar quando alguém sai de um grupo em que estava confirmado.
const exitKind = (groupState) => (groupState === 'open' ? 'left_early' : 'left_late');

// Pode a pessoa pedir revisão deste registro?
function canDispute(record, userId, openDisputes) {
  if (String(record.userId) !== String(userId)) return { ok: false, code: 'NOT_YOURS' };
  if (record.status === 'removed') return { ok: false, code: 'ALREADY_REMOVED' };
  if (record.status === 'disputed') return { ok: false, code: 'ALREADY_DISPUTED' };
  if (record.disputedAt) return { ok: false, code: 'ALREADY_REVIEWED' };           // um pedido de revisão por registro
  if (openDisputes >= RULES.maxOpenDisputes) return { ok: false, code: 'TOO_MANY' };
  return { ok: true };
}
const DISPUTE_ERRORS = Object.freeze({
  NOT_YOURS: 'Esse registro não é seu.', ALREADY_REMOVED: 'Esse registro já foi removido.', ALREADY_DISPUTED: 'Esse registro já está em revisão.',
  ALREADY_REVIEWED: 'Esse registro já passou por revisão.', TOO_MANY: `Você já tem ${RULES.maxOpenDisputes} pedidos de revisão abertos. Aguarde a análise.`, NOT_FOUND: 'Registro não encontrado.', BAD_STATE: 'Esse registro não está mais aguardando revisão.',
});

module.exports = { KINDS, LABEL, RULES, summarize, describe, exitKind, canDispute, DISPUTE_ERRORS };
