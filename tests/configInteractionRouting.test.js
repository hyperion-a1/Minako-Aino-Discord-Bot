const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

assert.match(index, /interaction\.isChannelSelectMenu\?\.\(\)/, 'O dispatcher precisa encaminhar Channel Select Menus.');
assert.match(index, /interaction\.isRoleSelectMenu\?\.\(\)/, 'O dispatcher precisa encaminhar Role Select Menus.');
assert.match(index, /customId\?\.startsWith\('minako-config:'\)/, 'O roteamento precisa continuar restrito ao painel da Minako.');

console.log('configInteractionRouting.test.js: todos os testes passaram.');

const configSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'commands', 'minako-configurar.js'), 'utf8');
if (!configSource.includes("processNightMode(interaction.guild,session.draft)")) throw new Error('Salvar alterações não sincroniza o Modo Noturno imediatamente.');
if (!configSource.includes("nightModeStartTime") || !configSource.includes("nightModeEndTime")) throw new Error('Campos de horário do Modo Noturno ausentes no fluxo de configuração.');
console.log('configInteractionRouting.test.js: sincronização imediata e horários OK.');
if (!configSource.includes("minako-config:pacotes-sazonais:")) throw new Error('O painel precisa permitir configurar os pacotes sazonais.');
if (!configSource.includes("action==='pacotes-sazonais'")) throw new Error('O handler precisa persistir a seleção dos pacotes sazonais.');
console.log('configInteractionRouting.test.js: pacotes sazonais OK.');
