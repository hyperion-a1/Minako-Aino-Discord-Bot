const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'..','commands','minako-configurar.js'),'utf8');
const configSource = fs.readFileSync(path.join(__dirname,'..','utils','config.js'),'utf8');
const dbSource = fs.readFileSync(path.join(__dirname,'..','utils','db.js'),'utf8');

for (const token of [
  'minako-config:modulo:',
  'minako-config:categorias-noturno:',
  'minako-config:canais-noturno:',
  'minako-config:imunes-noturno:',
  'minako-config:avisos-noturno:',
  'minako-config:pacotes-sazonais:',
  "action==='salvar'",
]) assert.ok(source.includes(token), `Configuração ausente: ${token}`);
assert.match(source,/Imunidade prevalece/);
assert.match(source,/resolvedChannelIds/);
assert.match(configSource,/nightModeCategoryIds/);
assert.match(configSource,/nightModeAffectedChannelIds/);
assert.match(configSource,/nightModeImmuneChannelIds/);
assert.match(dbSource,/night_mode_category_ids/);
assert.match(dbSource,/night_mode_affected_channel_ids/);
assert.match(dbSource,/night_mode_immune_channel_ids/);
assert.match(dbSource,/UPDATE minako_guilds SET night_mode_affected_channel_ids/);
console.log('nightMode.configScope.test.js: OK');
