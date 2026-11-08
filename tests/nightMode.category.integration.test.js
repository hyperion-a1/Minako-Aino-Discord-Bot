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
const fakeDiscord={PermissionFlagsBits:{SendMessages:'SendMessages',CreatePublicThreads:'CreatePublicThreads',SendMessagesInThreads:'SendMessagesInThreads',ManageChannels:'ManageChannels',Administrator:'Administrator',ViewChannel:'ViewChannel'},ChannelType:{GuildText:0,GuildAnnouncement:5,GuildForum:15,GuildCategory:4}};
Module._load=function(request,parent,isMain){ if(request==='discord.js') return fakeDiscord; return originalLoad.apply(this,arguments); };
const { processNightMode } = require('../utils/nightMode');

const calls=[];
function channel(id,parentId=null,type=0){
  const overwrite={allow:new Set(),deny:new Set()};
  const cache=new Map([['everyone',overwrite]]);
  return {id,parentId,type,isThread:()=>false,isTextBased:()=>true,isVoiceBased:()=>false,
    permissionOverwrites:{cache,edit:async(role,perms)=>{calls.push({id,perms:{...perms}});for(const[k,v]of Object.entries(perms)){overwrite.allow.delete(k);overwrite.deny.delete(k);if(v===true)overwrite.allow.add(k);if(v===false)overwrite.deny.add(k);}}},
    permissionsFor:()=>({has:()=>true}),send:async({content})=>{calls.push({id,notice:content});return{id:`m-${id}-${calls.length}`};}};
}
const channels=[channel('cat-a',null,4),channel('a1','cat-a'),channel('a2','cat-a'),channel('a3','cat-a'),channel('outside')];
const cache={values:()=>channels.values(),get:id=>channels.find(c=>c.id===id)};
const guild={id:'g-cat',name:'Categorias',roles:{everyone:{id:'everyone'}},members:{me:{},fetchMe:async()=>({})},channels:{cache,fetch:async id=>channels.find(c=>c.id===id)||null}};
const config={timezone:'America/Sao_Paulo',nightModeEnabled:true,nightModeStartTime:'10:50',nightModeEndTime:'10:55',nightModeCategoryIds:['cat-a'],nightModeAffectedChannelIds:['outside'],nightModeImmuneChannelIds:['a2'],nightModeNoticeChannelIds:['outside'],nightModeNoticeUrl:'https://discord.com/channels/1/2/3'};
(async()=>{
  await processNightMode(guild,config,new Date('2026-10-08T13:50:00Z'));
  assert.deepEqual(calls.filter(x=>x.perms).map(x=>x.id).sort(),['a1','a3','outside']);
  assert.equal(calls.some(x=>x.id==='a2'&&x.perms),false);
  console.log('nightMode.category.integration.test.js: OK');
})().finally(()=>{if(savedDb)require.cache[dbPath]=savedDb;else delete require.cache[dbPath];Module._load=originalLoad;});
