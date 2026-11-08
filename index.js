require('dotenv').config();
const fs=require('node:fs'); const path=require('node:path');
const {Client,GatewayIntentBits,Collection}=require('discord.js');
const db=require('./utils/db');
const editorialInteraction=require('./utils/editorialInteraction');
const nightlyScheduler=require('./utils/nightlyScheduler');
const partida=require('./commands/partida');
const minakoConfig=require('./commands/minako-configurar');
const matchStore=require('./utils/matchStore');
const minakoMatch=require('./commands/minako-match');
const sorteios=require('./commands/sorteios');
const giveawayStore=require('./utils/giveawayStore');
const giveawayScheduler=require('./utils/giveawayScheduler');
const matchmaking=require('./utils/matchmaking');
const tiktokStore=require('./utils/tiktok_store');
const tiktokVideoMonitor=require('./utils/tiktok_video_monitor');
const tiktokConfigPanel=require('./utils/tiktok_config_panel');
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers]});
client.commands=new Collection();
const ENABLED_COMMANDS=new Set(['minako-configurar.js','minako-quadro.js','minako-registrar-semana.js','partida.js','minako-match.js','sorteios.js','minako-matchmaking.js','tiktok.js']);
for(const file of fs.readdirSync(path.join(__dirname,'commands')).filter(f=>ENABLED_COMMANDS.has(f))){const cmd=require(path.join(__dirname,'commands',file)); client.commands.set(cmd.data.name,cmd);}
client.once('ready',async()=>{ try{await db.initSchema(); await matchStore.initFromDb(); console.log('[Minako] Schema PostgreSQL pronto.');}catch(e){console.error('[Minako] Falha no schema:',e);return;} console.log(`Minako Aino conectada como ${client.user.tag}.`); nightlyScheduler.start(client); try{await giveawayStore.ensureSchema(); giveawayScheduler.start(client); console.log('[Minako] Sorteios prontos.');}catch(e){console.error('[Minako] Sorteios indisponíveis (schema/agendador):',e);} try{await matchmaking.init(client);}catch(e){console.error('[Minako] Matchmaking indisponível (schema/agendador):',e);} try{await tiktokStore.ensureSchema(); tiktokVideoMonitor.start(client); console.log('[Minako] TikTok Watcher: estrutura PostgreSQL pronta.');}catch(e){console.error('[Minako] TikTok Watcher indisponível (schema/monitor):',e);} });
client.on('interactionCreate',async interaction=>{ try { if((interaction.isMessageComponent()||interaction.isModalSubmit()) && interaction.customId?.startsWith('minako-tiktok:cfg:')) return await tiktokConfigPanel.handleInteraction(interaction); if((interaction.isMessageComponent()||interaction.isModalSubmit()) && matchmaking.isMatchmakingId(interaction.customId)) return await matchmaking.handleInteraction(interaction,{openProfile:minakoMatch.openProfile}); if((interaction.isButton()||interaction.isStringSelectMenu()||interaction.isChannelSelectMenu?.()||interaction.isRoleSelectMenu?.()||interaction.isModalSubmit()) && interaction.customId?.startsWith('minako-config:')) return await minakoConfig.handleInteraction(interaction); if((interaction.isMessageComponent()||interaction.isModalSubmit()) && interaction.customId?.startsWith('minako-giveaway:')) return await sorteios.handleInteraction(interaction); if((interaction.isButton()||interaction.isStringSelectMenu()||interaction.isModalSubmit()) && interaction.customId?.startsWith('minako-match')) return await minakoMatch.handleInteraction(interaction); if(interaction.isButton() && /^(partida:(entrar-btn|desistir-btn|concluir-btn|gerenciar-btn):\d+)$/.test(interaction.customId||'')) return await partida.handleButton(interaction); if((interaction.isButton()||interaction.isStringSelectMenu()||interaction.isModalSubmit()) && interaction.customId?.startsWith('minako:')) return await editorialInteraction.handle(interaction); if(interaction.isAutocomplete()){ const acmd=client.commands.get(interaction.commandName); if(acmd?.autocomplete) return await acmd.autocomplete(interaction); return; } if(!interaction.isChatInputCommand()) return; const cmd=client.commands.get(interaction.commandName); if(!cmd)return; await cmd.execute(interaction); } catch(e){ console.error(`[Minako] interaction:`,e); const msg={content:`❌ ${String(e.message||e).slice(0,1500)}`}; if(interaction.deferred||interaction.replied) await interaction.editReply(msg).catch(()=>{}); else await interaction.reply({...msg,ephemeral:true}).catch(()=>{}); }});
process.on('SIGINT',async()=>{nightlyScheduler.stop();giveawayScheduler.stop();matchmaking.stop();tiktokVideoMonitor.stop();await matchStore.flushPendingWrites().catch(e=>console.error('[Minako] Falha ao aguardar gravações de partidas:',e));await db.closePool();client.destroy();process.exit(0);}); process.on('SIGTERM',async()=>{nightlyScheduler.stop();giveawayScheduler.stop();matchmaking.stop();tiktokVideoMonitor.stop();await matchStore.flushPendingWrites().catch(e=>console.error('[Minako] Falha ao aguardar gravações de partidas:',e));await db.closePool();client.destroy();process.exit(0);});
if(!process.env.MINAKO_TOKEN) throw new Error('MINAKO_TOKEN não configurada.');
// Robustez contra erros de rede transitórios (timeout de handshake do gateway,
// ConnectTimeoutError do REST, etc.): registrar e seguir em vez de derrubar o processo.
// O discord.js reconecta o gateway automaticamente quando a rede volta.
process.on('unhandledRejection',reason=>console.error('[Minako] Rejeição não tratada:',reason));
process.on('uncaughtException',err=>console.error('[Minako] Exceção não capturada:',err));
client.on('error',err=>console.error('[Minako] Erro do client:',err));
client.login(process.env.MINAKO_TOKEN).catch(err=>console.error('[Minako] Falha no login:',err));
