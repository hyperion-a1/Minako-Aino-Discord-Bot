const assert = require('node:assert/strict');
const { resolveAffectedChannelIds, overlappingImmuneIds } = require('../utils/nightModeScope');

const channels = [
  { id:'cat-a', type:4 },
  { id:'a1', type:0, parentId:'cat-a', isTextBased:()=>true, isThread:()=>false, isVoiceBased:()=>false, permissionOverwrites:{} },
  { id:'a2', type:0, parentId:'cat-a', isTextBased:()=>true, isThread:()=>false, isVoiceBased:()=>false, permissionOverwrites:{} },
  { id:'a3', type:0, parentId:'cat-a', isTextBased:()=>true, isThread:()=>false, isVoiceBased:()=>false, permissionOverwrites:{} },
  { id:'b1', type:0, parentId:null, isTextBased:()=>true, isThread:()=>false, isVoiceBased:()=>false, permissionOverwrites:{} },
  { id:'voice', type:2, parentId:'cat-a', isTextBased:()=>false, isThread:()=>false, isVoiceBased:()=>true },
];
const guild={channels:{cache:{values:()=>channels.values()}}};

const base={nightModeCategoryIds:['cat-a'],nightModeAffectedChannelIds:['b1'],nightModeImmuneChannelIds:['a2','b1']};
const result=resolveAffectedChannelIds(guild,base).sort();
assert.deepEqual(result,['a1','a3','voice']);
assert.deepEqual(overlappingImmuneIds(guild,base).sort(),['a2','b1']);

const directOnly=resolveAffectedChannelIds(guild,{nightModeCategoryIds:[],nightModeAffectedChannelIds:['b1'],nightModeImmuneChannelIds:[]});
assert.deepEqual(directOnly,['b1']);

const allImmune=resolveAffectedChannelIds(guild,{nightModeCategoryIds:['cat-a'],nightModeAffectedChannelIds:[],nightModeImmuneChannelIds:['a1','a2','a3','voice']});
assert.deepEqual(allImmune,[]);

console.log('nightMode.scope.test.js: OK');
