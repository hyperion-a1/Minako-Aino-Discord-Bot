const assert = require('node:assert/strict');
const Module = require('node:module');
const dbPath = require.resolve('../utils/db');
const savedDb = require.cache[dbPath];
const originalLoad = Module._load;
const state = new Map();
require.cache[dbPath] = { id:dbPath, filename:dbPath, loaded:true, exports:{
  async loadNightModeState(id){ return state.get(id)||null; },
  async saveNightModeState(id,v){ state.set(id,JSON.parse(JSON.stringify(v))); },
  async loadPersonalityState(){ return null; }, async savePersonalityState(){},
} };
const fakeDiscord={PermissionFlagsBits:{SendMessages:'SendMessages',CreatePublicThreads:'CreatePublicThreads',SendMessagesInThreads:'SendMessagesInThreads',ManageChannels:'ManageChannels',Administrator:'Administrator',ViewChannel:'ViewChannel'},ChannelType:{GuildText:0,GuildAnnouncement:5,GuildForum:15,GuildCategory:4}};
Module._load=function(request,parent,isMain){if(request==='discord.js')return fakeDiscord;return originalLoad.apply(this,arguments);};
const { processNightMode }=require('../utils/nightMode');
function channel(id){const ow={allow:new Set(),deny:new Set()};const cache=new Map([['everyone',ow]]);return{id,type:0,isThread:()=>false,isTextBased:()=>true,isVoiceBased:()=>false,permissionOverwrites:{cache,edit:async(role,perms)=>{for(const[k,v]of Object.entries(perms)){ow.allow.delete(k);ow.deny.delete(k);if(v===true)ow.allow.add(k);if(v===false)ow.deny.add(k);}}},permissionsFor:()=>({has:()=>true}),send:async()=>({id:'m'})};}
const cs=['a','b','c','d'].map(channel);const cache={get:id=>cs.find(c=>c.id===id),values:()=>cs.values()};const guild={id:'reconf',name:'Reconfiguração',roles:{everyone:{id:'everyone'}},members:{me:{},fetchMe:async()=>({})},channels:{cache,fetch:async id=>cache.get(id)}};
const base={timezone:'America/Sao_Paulo',nightModeEnabled:true,nightModeStartTime:'10:00',nightModeEndTime:'10:10',nightModeCategoryIds:[],nightModeImmuneChannelIds:[],nightModeNoticeChannelIds:['a'],nightModeNoticeUrl:'https://discord.com/channels/1/2/3'};
(async()=>{
  await processNightMode(guild,{...base,nightModeAffectedChannelIds:['a','b']},new Date('2026-10-08T13:05:00Z'));
  assert.deepEqual(Object.keys(state.get('reconf').originalOverwrites).sort(),['a','b']);
  await processNightMode(guild,{...base,nightModeAffectedChannelIds:['b','c']},new Date('2026-10-08T13:06:00Z'));
  assert.deepEqual(Object.keys(state.get('reconf').originalOverwrites).sort(),['b','c']);
  // a deixou o escopo: seu snapshot foi restaurado e c entrou no escopo.
  assert.deepEqual(cs.find(c=>c.id==='a').permissionOverwrites.cache.get('everyone').deny.size,0);
  assert.equal(cs.find(c=>c.id==='c').permissionOverwrites.cache.get('everyone').deny.has('SendMessages'),true);
  console.log('nightMode.reconfiguration.test.js: OK');
})().finally(()=>{if(savedDb)require.cache[dbPath]=savedDb;else delete require.cache[dbPath];Module._load=originalLoad;});
