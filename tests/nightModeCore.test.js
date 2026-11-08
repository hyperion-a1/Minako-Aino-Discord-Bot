const assert = require('node:assert/strict');
const core = require('../utils/nightModeCore');
const cfg = { timezone:'America/Sao_Paulo', nightModeStartTime:'01:00', nightModeEndTime:'05:00' };
assert.equal(core.parseTime('00:00'),0);
assert.equal(core.parseTime('23:59'),1439);
assert.throws(()=>core.parseTime('24:00'));
assert.equal(core.isNightMinute(60,60,300),true);
assert.equal(core.isNightMinute(299,60,300),true);
assert.equal(core.isNightMinute(300,60,300),false);
assert.equal(core.isNightMinute(30,1380,300),true);
assert.equal(core.isNightMinute(300,1380,300),false);
let e=core.eventForNow(new Date('2026-10-08T03:30:00Z'),cfg); // 00:30 BRT
assert.equal(e.active,false); assert.equal(e.startWarning,true);
e=core.eventForNow(new Date('2026-10-08T04:00:00Z'),cfg); // 01:00 BRT
assert.equal(e.active,true); assert.equal(e.startWarning,false);
e=core.eventForNow(new Date('2026-10-08T07:30:00Z'),cfg); // 04:30 BRT
assert.equal(e.active,true); assert.equal(e.endWarning,true);
e=core.eventForNow(new Date('2026-10-08T08:00:00Z'),cfg); // 05:00 BRT
assert.equal(e.active,false); assert.equal(e.endWarning,false);
assert.equal(core.eventForNow(new Date('2026-10-09T02:30:00Z'),{...cfg,nightModeStartTime:'23:00',nightModeEndTime:'05:00'}).active,true);
const daytimeCfg = { ...cfg, nightModeStartTime:'10:50', nightModeEndTime:'10:55' };
e=core.eventForNow(new Date('2026-10-08T13:50:00Z'), daytimeCfg); // 10:50 BRT
assert.equal(e.active,true);
e=core.eventForNow(new Date('2026-10-08T13:55:00Z'), daytimeCfg); // 10:55 BRT
assert.equal(e.active,false);
assert.equal(core.eventForNow(new Date('2026-10-08T13:20:00Z'), daytimeCfg).active,false);

assert.throws(()=>core.validateNightConfig({...cfg,nightModeEnabled:true,nightModeStartTime:'01:00',nightModeEndTime:'01:00',nightModeNoticeChannelIds:['1','2','3'],nightModeNoticeUrl:'https://discord.com/channels/1/2/3'}));
assert.throws(()=>core.validateNightConfig({...cfg,nightModeEnabled:true,nightModeNoticeChannelIds:['1','2','3'],nightModeNoticeUrl:'https://example.com'}));
console.log('nightModeCore.test.js: OK');

assert.throws(()=>core.validateNightConfig({...cfg,nightModeEnabled:true,nightModeNoticeChannelIds:['1','2'],nightModeNoticeUrl:'https://discord.com/channels/1/2/3'}));
