const assert = require('node:assert/strict');
const dbPath = require.resolve('../utils/db');
const Module = require('node:module');
const savedDb = require.cache[dbPath];
const originalLoad = Module._load;
const state = new Map();
require.cache[dbPath] = { id:dbPath, filename:dbPath, loaded:true, exports:{
  async loadNightModeState(id){ return state.get(id)||null; },
  async saveNightModeState(id,v){ state.set(id,v); },
  async loadPersonalityState(){ return null; },
  async savePersonalityState(){},
} };
const fakeDiscord={PermissionFlagsBits:{SendMessages:'SendMessages',CreatePublicThreads:'CreatePublicThreads',SendMessagesInThreads:'SendMessagesInThreads',Connect:'Connect',ManageChannels:'ManageChannels',Administrator:'Administrator',ViewChannel:'ViewChannel'},ChannelType:{GuildText:0,GuildAnnouncement:5,GuildForum:15}};
Module._load=function(request,parent,isMain){ if(request==='discord.js') return fakeDiscord; return originalLoad.apply(this,arguments); };
const { processNightMode } = require('../utils/nightMode');

const log=[];
function channel(id){
  const overwrites={cache:new Map()};
  return { id, type:0, isThread:()=>false, isTextBased:()=>true,
    permissionOverwrites:{cache:overwrites.cache,edit:async (role, perms)=>{log.push({id,perms}); if(role?.id==='everyone') overwrites.cache.set('everyone',{deny:new Set(Object.entries(perms).filter(([,v])=>v===false).map(([k])=>k))});}},
    permissionsFor:()=>({has:()=>true}),
    send:async ({content})=>{log.push({id,notice:content}); return {id:`m-${id}-${log.length}`};}
  };
}
const channels=[channel('c1'),channel('c2'),channel('c3'),channel('c4')];
const cache={get(id){return channels.find(c=>c.id===id);}};
const guild={id:'g1',name:'Teste',roles:{everyone:{id:'everyone'}},members:{me:{},fetchMe:async()=>({})},channels:{cache,fetch:async(id)=>id?channels.find(c=>c.id===id):null}};
const config={timezone:'America/Sao_Paulo',nightModeEnabled:true,nightModeStartTime:'01:00',nightModeEndTime:'05:00',nightModeNoticeChannelIds:['c1','c2','c3'],nightModeCategoryIds:[],nightModeAffectedChannelIds:['c1','c2','c3'],nightModeImmuneChannelIds:[],nightModeNoticeUrl:'https://discord.com/channels/1/2/3'};

(async()=>{
  // Ativação no meio da janela: somente o escopo configurado é bloqueado e avisado.
  let r=await processNightMode(guild,config,new Date('2026-10-08T04:00:00Z'));
  assert.equal(r.changed,true); assert.deepEqual(state.get('g1').active,true);
  assert.equal(log.filter(x=>x.notice).length,3);
  assert.ok(log.find(x=>x.notice)?.notice.includes('05:00'), 'O comunicado de ativação deve identificar o horário de fim.');
  assert.equal(log.filter(x=>x.perms).length,3);
  assert.deepEqual(log.filter(x=>x.perms).map(x=>x.id).sort(),['c1','c2','c3']);
  assert.equal(log.some(x=>x.id==='c4' && x.perms),false);

  // Ticks seguintes não duplicam o aviso.
  r=await processNightMode(guild,config,new Date('2026-10-08T04:00:20Z'));
  assert.equal(r.notices.length,0); assert.equal(log.filter(x=>x.notice).length,3);

  // Aviso de 30 min antes do fim mantém o snapshot original.
  r=await processNightMode(guild,config,new Date('2026-10-08T07:30:00Z'));
  assert.equal(r.notices.includes('end-warning'),true); assert.equal(log.filter(x=>x.notice).length,6);
  assert.equal(Object.keys(state.get('g1').originalOverwrites).length,3);

  // Ao terminar, restaura exatamente os canais que foram alterados.
  r=await processNightMode(guild,config,new Date('2026-10-08T08:00:00Z'));
  assert.equal(r.notices.includes('end'),true); assert.equal(log.filter(x=>x.notice).length,9);
  assert.equal(log.filter(x=>x.perms).length,6);
  assert.deepEqual(log.filter(x=>x.perms).slice(-3).map(x=>x.id).sort(),['c1','c2','c3']);
  assert.deepEqual(log.filter(x=>x.perms).at(-1).perms,{SendMessages:null,CreatePublicThreads:null,SendMessagesInThreads:null,Connect:null});

  console.log('nightMode.integration.test.js: OK');
})().finally(()=>{ if(savedDb) require.cache[dbPath]=savedDb; else delete require.cache[dbPath]; Module._load=originalLoad; });
