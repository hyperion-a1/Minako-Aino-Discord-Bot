'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
class FakeBuilder {
  setName() { return this; } setDescription() { return this; } addSubcommand() { return this; }
  addStringOption() { return this; } addIntegerOption() { return this; } addUserOption() { return this; }
  addChannelOption() { return this; } setRequired() { return this; } setMaxLength() { return this; }
  setMinValue() { return this; } addChannelTypes() { return this; }
}
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return {
    SlashCommandBuilder: FakeBuilder, PermissionFlagsBits: { Administrator: 8 },
    ChannelType: { GuildText: 0 }, MessageFlags: { Ephemeral: 64 }, EmbedBuilder: FakeBuilder
  };
  if (request === '../utils/tiktok_store' || request === '../utils/tiktok_oauth' || request === '../utils/tiktok_config_panel') return {};
  if (request === 'pg') return { Pool: class FakePool {} };
  return originalLoad.call(this, request, parent, isMain);
};
const command = require('../commands/tiktok');
Module._load = originalLoad;
const valid = command.validateLiveUrl;
assert.equal(valid('https://www.tiktok.com/@criador/live', 'criador'), 'https://www.tiktok.com/@criador/live');
assert.equal(valid('https://tiktok.com/@Criador/live/', 'criador'), 'https://www.tiktok.com/@Criador/live');
assert.equal(valid('http://www.tiktok.com/@criador/live', 'criador'), null);
assert.equal(valid('https://evil.example/@criador/live', 'criador'), null);
assert.equal(valid('https://www.tiktok.com/@outro/live', 'criador'), null);
assert.equal(valid('https://www.tiktok.com/@criador/live?redirect=evil', 'criador'), null);
assert.equal(valid('https://www.tiktok.com/@criador/video/123', 'criador'), null);
assert.equal(valid('https://www.tiktok.com.evil.example/@criador/live', 'criador'), null);
console.log('TikTok Live Announcement: testes de validação passaram.');
