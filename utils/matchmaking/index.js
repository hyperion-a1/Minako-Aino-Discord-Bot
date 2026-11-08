'use strict';
// Ponto único de integração do matchmaking com o bot. O index.js só chama estas funções.
const db = require('../db');
const schema = require('./schema');
const central = require('./central');
const engine = require('./engine');
const playFlow = require('./playFlow');
const groupFlow = require('./groupFlow');
const matchFlow = require('./matchFlow');
const configPanel = require('./configPanel');
const prefsFlow = require('./prefsFlow');
const socialFlow = require('./socialFlow');
const teamFlow = require('./teamFlow');
const reliabilityFlow = require('./reliabilityFlow');
const engagementFlow = require('./engagementFlow');

const OWN = 'minako-mm:';
const isMatchmakingId = (id) => typeof id === 'string' && id.startsWith(OWN);

async function init(client) {
  if (!db.isEnabled()) throw new Error('DATABASE_URL não configurada.');
  const applied = await schema.migrate();
  if (applied.length) console.log(`[matchmaking] Migrações aplicadas: ${applied.join(', ')}`);
  engine.start(client, { onCentral: async () => { await groupFlow.sweeps(client); await teamFlow.sweeps(client); await groupFlow.reconcile(client); await matchFlow.sweeps(client); await reliabilityFlow.sweeps(); await engagementFlow.sweeps(client); await central.tick(client); } });
  console.log('[matchmaking] Módulo pronto.');
}
function stop() { engine.stop(); }

// Botão "Meu perfil" abre o painel de perfil já existente (/minako-match).
async function handleInteraction(interaction, { openProfile } = {}) {
  const id = interaction.customId || '';
  if (!isMatchmakingId(id)) return false;
  if (id.startsWith('minako-mm:cfg:')) return configPanel.handleInteraction(interaction);
  if (id === 'minako-mm:profile') { if (openProfile) await openProfile(interaction); return true; } // botão antigo (Centrais publicadas antes da 1.1)
  if (id.startsWith('minako-mm:soc:')) return socialFlow.handleInteraction(interaction);
  if (id.startsWith('minako-mm:team')) return teamFlow.handleInteraction(interaction);
  if (id.startsWith('minako-mm:eng:')) return engagementFlow.handleInteraction(interaction);
  if (id.startsWith('minako-mm:rel:')) return reliabilityFlow.handleInteraction(interaction);
  if (id.startsWith('minako-mm:prefs')) return prefsFlow.handleInteraction(interaction, { openProfile });
  if (await playFlow.handleInteraction(interaction)) return true;
  if (await matchFlow.handleInteraction(interaction)) return true;
  return groupFlow.handleInteraction(interaction);
}

module.exports = { init, stop, handleInteraction, isMatchmakingId };
