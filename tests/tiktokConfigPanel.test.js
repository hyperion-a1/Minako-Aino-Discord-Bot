'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
class Builder {
  constructor() { this.components = []; }
  addComponents(...items) { this.components.push(...items); return this; }
  setCustomId(v) { this.customId = v; return this; }
  setLabel(v) { this.label = v; return this; }
  setStyle(v) { this.style = v; return this; }
  setPlaceholder(v) { this.placeholder = v; return this; }
  setChannelTypes(v) { this.channelTypes = v; return this; }
  setMinValues(v) { this.minValues = v; return this; }
  setMaxValues(v) { this.maxValues = v; return this; }
  setColor(v) { this.color = v; return this; }
  setTitle(v) { this.title = v; return this; }
  setDescription(v) { this.description = v; return this; }
}
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return {
    ActionRowBuilder: Builder, ButtonBuilder: Builder, ButtonStyle: { Success: 3, Secondary: 2, Primary: 1 },
    ChannelSelectMenuBuilder: Builder, ChannelType: { GuildText: 0 }, EmbedBuilder: Builder,
    ModalBuilder: Builder, TextInputBuilder: Builder, TextInputStyle: { Short: 1 },
    MessageFlags: { Ephemeral: 64 }, PermissionFlagsBits: { Administrator: 8 }
  };
  if (request === './tiktok_store') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const panel = require('../utils/tiktok_config_panel');
Module._load = originalLoad;
const view = panel.render({
  notificationChannelId: '123', videoNotificationsEnabled: true, liveAnnouncementsEnabled: false,
  liveMentionCreator: false, liveAnnounceAccountCooldownSeconds: 900,
  liveAnnounceGuildCooldownSeconds: 180, pollIntervalMinutes: 5, maxAccounts: 10
}, 'user-1');
assert.equal(view.components.length, 3);
assert.match(view.embeds[0].description, /nunca são detectadas ou anunciadas automaticamente/i);
assert.match(view.embeds[0].description, /@everyone\/@here/);
assert.ok(view.components.flatMap(row => row.components).some(c => c.customId === 'minako-tiktok:cfg:live:user-1'));
console.log('TikTok Config Panel: renderização e controles passaram.');
