const assert = require('node:assert/strict');
const Module = require('node:module');
const dbPath = require.resolve('../utils/db');
const savedDb = require.cache[dbPath];
const originalLoad = Module._load;
const state = new Map();
require.cache[dbPath] = { id:dbPath, filename:dbPath, loaded:true, exports:{
  async loadNightModeState(id){ return state.get(id)||null; },
  async saveNightModeState(id,v){ state.set(id,JSON.parse(JSON.stringify(v))); },
  async loadPersonalityState(){ return null; },
  async savePersonalityState(){},
} };
const fakeDiscord={PermissionFlagsBits:{SendMessages:'SendMessages',CreatePublicThreads:'CreatePublicThreads',SendMessagesInThreads:'SendMessagesInThreads',Connect:'Connect',ManageChannels:'ManageChannels',Administrator:'Administrator',ViewChannel:'ViewChannel'},ChannelType:{GuildText:0,GuildAnnouncement:5,GuildForum:15}};
Module._load=function(request,parent,isMain){ if(request==='discord.js') return fakeDiscord; return originalLoad.apply(this,arguments); };
const { processNightMode } = require('../utils/nightMode');

const log=[];
function channel(id, initial={SendMessages:null,CreatePublicThreads:null,SendMessagesInThreads:null,Connect:null}){
  const everyone={id:'everyone'};
  const cache=new Map();
  const overwrite={allow:new Set(),deny:new Set()};
  for(const [k,v] of Object.entries(initial)){ if(v===true) overwrite.allow.add(k); if(v===false) overwrite.deny.add(k); }
  cache.set('everyone', overwrite);
  return { id, type:0, isThread:()=>false, isTextBased:()=>true,
    permissionOverwrites:{cache,edit:async(role,perms)=>{ if(role?.id!=='everyone') return; log.push({id,perms:{...perms}}); for(const [k,v] of Object.entries(perms)){ overwrite.allow.delete(k); overwrite.deny.delete(k); if(v===true) overwrite.allow.add(k); if(v===false) overwrite.deny.add(k); } }},
    permissionsFor:()=>({has:()=>true}),
    send:async({content})=>{ log.push({id,notice:content}); return {id:`m-${id}-${log.length}`}; }
  };
}
const channels=[channel('c1',{SendMessages:true,CreatePublicThreads:null,SendMessagesInThreads:false,Connect:null}),channel('c2'),channel('c3')];
const cache={filter(fn){return {values:()=>channels.filter(fn).values()};}};
const guild={id:'g-reg',name:'Regressão',roles:{everyone:{id:'everyone'}},members:{me:{},fetchMe:async()=>({})},channels:{cache,fetch:async(id)=>id?channels.find(c=>c.id===id):cache}};
const config={timezone:'America/Sao_Paulo',nightModeEnabled:true,nightModeStartTime:'01:00',nightModeEndTime:'05:00',nightModeNoticeChannelIds:['c1','c2','c3'],nightModeCategoryIds:[],nightModeAffectedChannelIds:['c1','c2','c3'],nightModeImmuneChannelIds:[],nightModeNoticeUrl:'https://discord.com/channels/1/2/3'};

(async()=>{
  // Ativação manual às 02:00 deve gerar o aviso de início imediatamente.
  let r=await processNightMode(guild,config,new Date('2026-10-08T05:00:00Z'));
  assert.equal(r.changed,true);
  assert.deepEqual(r.notices,['start']);
  assert.equal(log.filter(x=>x.notice).length,3);
  assert.deepEqual(state.get('g-reg').originalOverwrites.c1,{SendMessages:true,CreatePublicThreads:null,SendMessagesInThreads:false,Connect:null});

  // O aviso das 04:30 não pode apagar o snapshot original.
  await processNightMode(guild,config,new Date('2026-10-08T07:30:00Z'));
  assert.equal(state.get('g-reg').endNoticeDate,'2026-10-08');
  assert.deepEqual(state.get('g-reg').originalOverwrites.c1,{SendMessages:true,CreatePublicThreads:null,SendMessagesInThreads:false,Connect:null});

  // Ao desativar manualmente durante a madrugada, as permissões originais devem voltar e um aviso deve ser enviado.
  r=await processNightMode(guild,{...config,nightModeEnabled:false},new Date('2026-10-08T07:40:00Z'));
  assert.equal(r.status,'disabled-restored');
  assert.deepEqual(r.notices,['end']);
  assert.deepEqual(log.filter(x=>x.id==='c1' && x.perms).at(-1).perms,{SendMessages:true,CreatePublicThreads:null,SendMessagesInThreads:false,Connect:null});
  assert.equal(log.filter(x=>x.notice).length,9);
  console.log('nightMode.regression.test.js: OK');
})().finally(()=>{ if(savedDb) require.cache[dbPath]=savedDb; else delete require.cache[dbPath]; Module._load=originalLoad; });
