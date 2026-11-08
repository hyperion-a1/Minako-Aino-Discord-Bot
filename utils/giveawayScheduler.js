'use strict';
// Agendador dos sorteios: a cada 15 s publica sorteios agendados, sorteia os que
// chegaram ao prazo e reenvia anúncios que falharam. Todo o estado está no
// PostgreSQL, então reiniciar o bot não perde nada (o que venceu durante a
// queda é processado no primeiro ciclo). É seguro com mais de uma instância:
// reivindicação por UPDATE ... FOR UPDATE SKIP LOCKED e sorteio dentro de transação.
const store = require('./giveawayStore');
const actions = require('./giveawayActions');

let timer = null;
let running = false;

async function notifyHost(client, g, text) {
  try {
    const user = await client.users.fetch(g.hostId);
    await user.send(text);
  } catch { /* DMs fechadas: sem alternativa silenciosa melhor */ }
}

async function tick(client) {
  if (running) return;
  running = true;
  try {
    for (const g of await store.claimDueStarts(5)) {
      try {
        await actions.publishGiveaway(client, g);
      } catch (error) {
        console.error(`[sorteios] Falha ao publicar o sorteio agendado ${g.id}:`, error.message);
        const after = await store.failStart(g.id, 60).catch(() => null);
        if (after?.status === 'cancelled') {
          await notifyHost(client, g, `🚫 Não consegui publicar o sorteio agendado **${g.name}** (${error.message}). Por segurança ele foi cancelado. Confira minhas permissões no canal e crie o sorteio de novo — assim que estiver tudo certo, eu publico.`);
        }
      }
    }
    for (const g of await store.listDueDraws(10)) {
      try { await actions.drawGiveaway(client, g.guildId, g.id); } catch (error) { console.error(`[sorteios] Falha ao sortear ${g.id}:`, error.message); }
    }
    try { await actions.processDueRoleOps(client); } catch (error) { console.error('[sorteios] Cargos temporários:', error.message); }
    for (const g of await store.listUnannounced(5)) {
      try { await actions.drawGiveaway(client, g.guildId, g.id); } catch (error) { console.error(`[sorteios] Falha ao reenviar anúncio ${g.id}:`, error.message); }
    }
  } catch (error) {
    console.error('[sorteios] Erro no agendador:', error.message);
  } finally {
    running = false;
  }
}

function start(client, { intervalMs = 15_000 } = {}) {
  if (timer) return;
  timer = setInterval(() => { void tick(client); }, intervalMs);
  timer.unref?.();
  void tick(client);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
