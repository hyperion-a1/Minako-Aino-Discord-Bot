'use strict';
// Quatro níveis configuráveis + Administrator sempre autorizado. Nunca confia em dados do customId.
//  gestão     -> gerencia/encerra qualquer grupo, revisa e faz manutenção
//  moderação  -> gerencia/encerra qualquer grupo
//  revisão    -> resolve registros de partida contestados (cargo único em settings.reviewRoleId)
//  manutenção -> diagnóstico, backup e ações operacionais
// Configurar o módulo continua exigindo "Gerenciar Servidor" (igual ao /minako-configurar).
const { PermissionFlagsBits } = require('discord.js');
const store = require('./store');

const ACTIONS = Object.freeze({
  'group.manage': ['management', 'moderation'],
  'match.review': ['reviewer', 'management'],
  maintenance: ['maintenance', 'management'],
});

function roleIdsFor(cfg, action) {
  const out = [];
  for (const level of ACTIONS[action] || []) {
    if (level === 'reviewer') out.push(cfg.settings?.reviewRoleId);
    else out.push(...(cfg.roleIds?.[level] || []));
  }
  return out.filter(Boolean).map(String);
}

async function can(interaction, action, cfg = null) {
  const perms = interaction.memberPermissions;
  if (perms?.has?.(PermissionFlagsBits.Administrator)) return true;
  if (action === 'config') return Boolean(perms?.has?.(PermissionFlagsBits.ManageGuild));
  const config = cfg || await store.getSettings(interaction.guildId);
  const has = interaction.member?.roles?.cache?.has?.bind(interaction.member.roles.cache);
  return Boolean(has) && roleIdsFor(config, action).some(id => has(id));
}

module.exports = { ACTIONS, roleIdsFor, can };
