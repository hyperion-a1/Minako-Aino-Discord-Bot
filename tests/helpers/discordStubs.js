'use strict';
// Substitui discord.js e pg por stubs leves para testar a lógica sem rede, Discord ou banco.
const Module = require('node:module');
function builderClass() {
  const C = class {
    constructor() {
      this.calls = [];
      const self = new Proxy(this, {
        get(t, k) {
          if (k in t) return t[k];
          return (...a) => {
            t.calls.push([k, a]);
            if (k === 'setCustomId') t.customId = a[0];
            if (k === 'setContent') t.content = a[0];
            if (k === 'addComponents') (t.children ||= []).push(...a.flat());
            if (k === 'addTextDisplayComponents') (t.texts ||= []).push(...a);
            if (k === 'addActionRowComponents') (t.rows ||= []).push(...a);
            if (k === 'addOptions') (t.options ||= []).push(...a.flat());
            if (k === 'setDisabled') t.disabled = a[0];
            return self;
          };
        },
        set(t, k, v) { t[k] = v; return true; },
      });
      return self;
    }
  };
  return C;
}
function install() {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'discord.js') {
      const mk = builderClass;
      return {
        ContainerBuilder: mk(), TextDisplayBuilder: mk(), SeparatorBuilder: mk(), ActionRowBuilder: mk(), ButtonBuilder: mk(), StringSelectMenuBuilder: mk(),
        ChannelSelectMenuBuilder: mk(), UserSelectMenuBuilder: mk(), RoleSelectMenuBuilder: mk(), ModalBuilder: mk(), TextInputBuilder: mk(), SlashCommandBuilder: mk(), AttachmentBuilder: class { constructor(buf, o) { this.buf = buf; this.name = o?.name; } },
        TextInputStyle: { Short: 1, Paragraph: 2 },
        ButtonStyle: { Success: 3, Primary: 1, Secondary: 2, Danger: 4 }, MessageFlags: { IsComponentsV2: 32768, Ephemeral: 64 },
        ChannelType: { PrivateThread: 12, GuildText: 0 }, PermissionFlagsBits: { Administrator: 8n, ManageGuild: 32n, CreatePrivateThreads: 1n << 36n, SendMessagesInThreads: 1n << 38n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n },
      };
    }
    if (req === 'pg') return { Pool: class { on() {} } };
    return orig.call(this, req, ...rest);
  };
}
const textOf = (payload) => payload.components[0].texts.map(t => t.content).join('\n');
const buttonsOf = (payload) => (payload.components[0].rows || []).flatMap(r => r.children || []);
module.exports = { install, textOf, buttonsOf };
