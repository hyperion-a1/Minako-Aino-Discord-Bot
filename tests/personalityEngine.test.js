const assert = require('node:assert/strict');
const Module = require('node:module');
const dbPath = require.resolve('../utils/db');
const savedDb = require.cache[dbPath];
const originalLoad = Module._load;
const state = new Map();
require.cache[dbPath] = { id:dbPath, filename:dbPath, loaded:true, exports:{
  async loadPersonalityState(id){ return state.get(id) || null; },
  async savePersonalityState(id,v){ state.set(id, JSON.parse(JSON.stringify(v))); },
} };
const fakeDiscord={};
Module._load=function(request,parent,isMain){ if(request==='discord.js') return fakeDiscord; return originalLoad.apply(this,arguments); };
const { PHRASES } = require('../utils/personality/phraseBank');
const { normalizeSeasonalPackages, isSeasonalPackageEnabled } = require('../utils/personality/seasonal');
const { availablePhrases, choosePhrase, weekKey } = require('../utils/personality/phraseSelector');

assert.equal(PHRASES.length,40);
for (const event of ['start-warning','start','end-warning','end']) assert.equal(PHRASES.filter(p=>p.event===event).length,10);
assert.equal(PHRASES.filter(p=>p.seasonalPackage==='halloween').length,12);
assert.equal(new Set(PHRASES.map(p=>p.id)).size,40);
assert.deepEqual(normalizeSeasonalPackages({ halloween:false }), { halloween:false, natal:true, ano_novo:true });
assert.equal(isSeasonalPackageEnabled({seasonalPackages:{halloween:false}},'halloween'),false);
assert.equal(isSeasonalPackageEnabled({seasonalPackages:{halloween:false}},'natal'),true);
assert.equal(availablePhrases('start',{seasonalPackages:{halloween:false}}).length,7);
assert.equal(availablePhrases('start',{seasonalPackages:{halloween:true}}).length,10);

(async()=>{
  const config={timezone:'America/Sao_Paulo',seasonalPackages:{halloween:true,natal:true,ano_novo:true}};
  const used=[];
  for(let i=0;i<10;i++) used.push((await choosePhrase('g1','start',config,new Date('2026-10-08T12:00:00Z'))).id);
  assert.equal(new Set(used).size,10,'Não pode repetir falas do mesmo evento durante o ciclo disponível.');
  const next=await choosePhrase('g1','start',config,new Date('2026-10-08T12:00:00Z'));
  assert.notEqual(next.id,used[used.length-1],'Não deve repetir imediatamente após esgotar o conjunto.');
  const nextWeek=await choosePhrase('g1','start',config,new Date('2026-10-15T12:00:00Z'));
  assert.ok(nextWeek.id);
  assert.match(weekKey(new Date('2026-10-08T12:00:00Z')), /^2026-W/);
  console.log('personalityEngine.test.js: OK');
})().finally(()=>{ if(savedDb) require.cache[dbPath]=savedDb; else delete require.cache[dbPath]; Module._load=originalLoad; });
