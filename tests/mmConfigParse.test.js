'use strict';
const assert = require('node:assert/strict');
const p = require('../utils/matchmaking/configParse');
const core = require('../utils/matchmaking/mmCore');
let n = 0; const t = (a, f) => { f(); n++; console.log('ok -', a); };
const bad = (fn, re) => assert.throws(fn, (e) => e instanceof p.ConfigError && re.test(e.message));
t('prazos: converte unidades e aceita vírgula decimal', () => {
  assert.deepEqual(p.parseDeadlines({ proposta: '2', disponibilidade: '120', substituto: '5', janela: '24', arquivo: '3' }),
    { proposalTtlSec: 120, availabilityTtlSec: 7200, replacementTtlSec: 300, confirmationWindowSec: 86400, archiveAfterSec: 259200 });
  assert.equal(p.parseDeadlines({ proposta: '1,5', disponibilidade: '120', substituto: '5', janela: '24', arquivo: '3' }).proposalTtlSec, 90);
});
t('prazos: rejeita fora dos limites e não numérico, com mensagem clara', () => {
  bad(() => p.parseDeadlines({ proposta: '0.1', disponibilidade: '120', substituto: '5', janela: '24', arquivo: '3' }), /Proposta.*entre/);
  bad(() => p.parseDeadlines({ proposta: 'abc', disponibilidade: '120', substituto: '5', janela: '24', arquivo: '3' }), /número/);
});
t('busca: etapas de relaxamento coerentes e atualização da Central limitada', () => {
  assert.deepEqual(p.parseSearch({ relax1: '5', relax2: '10', refresh: '20', inatividade: '120', equipe: '10' }), { relaxAfterSec: [300, 600], centralMinRefreshSec: 20, groupInactivityTtlSec: 7200, teamConfirmTtlSec: 600 });
  bad(() => p.parseSearch({ relax1: '5', relax2: '10', refresh: '20', inatividade: '120', equipe: '1' }), /equipe/);
  bad(() => p.parseSearch({ relax1: '5', relax2: '10', refresh: '20', inatividade: '5', equipe: '10' }), /Inatividade/);
  bad(() => p.parseSearch({ relax1: '10', relax2: '5', refresh: '20', inatividade: '120', equipe: '10' }), /etapas/); bad(() => p.parseSearch({ relax1: '5', relax2: '10', refresh: '1', inatividade: '120', equipe: '10' }), /Atualização/);
});
t('catálogo de funções: um por linha, sem duplicar, com limites', () => {
  assert.deepEqual(p.parseRoleCatalog('Selva\nApoio\nSelva\n  \nMeio'), ['Selva', 'Apoio', 'Meio']);
  bad(() => p.parseRoleCatalog('  '), /pelo menos/); bad(() => p.parseRoleCatalog(Array.from({ length: 11 }, (_, i) => `F${i}`).join('\n')), /10/);
});
t('modo novo: ID gerado do nome, sem colidir; edição preserva o ID e o estado', () => {
  const modes = [...core.DEFAULT_MODES];
  const m = p.parseMode({ label: 'Modo Épico!', ideal: '5', min: '3', incomplete: 'sim', elo: '1' }, null, modes);
  assert.equal(m.id, 'modo-pico'.replace('pico', 'epico')); assert.ok(m.eloRelevant); assert.equal(m.eloWindow, 1); assert.ok(m.allowIncomplete); assert.equal(m.minSize, 3);
  bad(() => p.parseMode({ label: 'Ranqueada', ideal: '5', min: '2', incomplete: 'não', elo: '' }, null, modes), /Já existe/);
  const edited = p.parseMode({ label: 'Normal 2', ideal: '4', min: '2', incomplete: 'não', elo: '' }, { ...modes[1], active: false }, modes);
  assert.equal(edited.id, 'normal'); assert.equal(edited.active, false); assert.equal(edited.eloRelevant, false);
});
t('modo: valida tamanhos e campos sim/não', () => {
  bad(() => p.parseMode({ label: 'X', ideal: '11', min: '2', incomplete: 'não', elo: '' }, null, []), /2 a 10/);
  bad(() => p.parseMode({ label: 'X', ideal: '5', min: '6', incomplete: 'não', elo: '' }, null, []), /mínimo/);
  bad(() => p.parseMode({ label: 'X', ideal: '5', min: '2', incomplete: 'talvez', elo: '' }, null, []), /sim ou não/);
});
console.log(`\n${n} testes passaram.`);
