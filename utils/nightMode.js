const { PermissionFlagsBits, ChannelType } = require('discord.js');
const db = require('./db');
const { renderPhrase } = require('./personality/phraseSelector');
const { resolveAffectedChannelIds, isTargetableChannel, summarizeScope, uniqueIds } = require('./nightModeScope');

const NIGHT_PERMISSIONS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.Connect,
];
const TIMEZONE = 'America/Sao_Paulo';
const { parseTime, eventForNow, isNightMinute, validateNightConfig } = require('./nightModeCore');

function configuredNoticeIds(config) {
  return uniqueIds(config?.nightModeNoticeChannelIds);
}

async function resolveChannelsByIds(guild, ids) {
  const channels = [];
  for (const id of uniqueIds(ids)) {
    const channel = guild.channels.cache?.get?.(id) || await guild.channels.fetch(id).catch(() => null);
    if (!channel || !isTargetableChannel(channel)) {
      throw new Error(`O canal configurado ${id} não é um canal de texto utilizável para o Modo Noturno.`);
    }
    channels.push(channel);
  }
  return channels;
}

async function resolveTargetChannels(guild, config) {
  const ids = resolveAffectedChannelIds(guild, config);
  if (!ids.length) throw new Error('O Modo Noturno não encontrou nenhum canal afetado após aplicar as categorias, canais escolhidos e imunidades.');
  return resolveChannelsByIds(guild, ids);
}

async function ensureBotPermissions(guild, channels) {
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('Não consegui localizar a Minako como membro do servidor.');
  const missingManage = channels.filter(c => {
    const p = c.permissionsFor(me);
    return p && !p.has(PermissionFlagsBits.ManageChannels) && !p.has(PermissionFlagsBits.Administrator);
  });
  if (missingManage.length) {
    throw new Error(`A Minako não tem **Gerenciar Canais** em ${missingManage.length} canal(is) afetado(s). Nenhuma alteração foi aplicada.`);
  }
}

function permissionState(overwrite, permission) {
  if (!overwrite) return null;
  if (overwrite.deny?.has?.(permission)) return false;
  if (overwrite.allow?.has?.(permission)) return true;
  return null;
}

async function applyNightPermissions(guild, originalOverwrites = {}, targetIds = []) {
  const ids = uniqueIds(targetIds);
  if (!ids.length) throw new Error('Nenhum canal foi selecionado para o Modo Noturno.');
  const channels = await resolveChannelsByIds(guild, ids);
  await ensureBotPermissions(guild, channels);
  let changed = 0;
  const originals = { ...originalOverwrites };
  for (const channel of channels) {
    const overwrite = channel.permissionOverwrites.cache?.get?.(guild.roles.everyone.id);
    if (!Object.prototype.hasOwnProperty.call(originals, channel.id)) {
      originals[channel.id] = {
        SendMessages: permissionState(overwrite, PermissionFlagsBits.SendMessages),
        CreatePublicThreads: permissionState(overwrite, PermissionFlagsBits.CreatePublicThreads),
        SendMessagesInThreads: permissionState(overwrite, PermissionFlagsBits.SendMessagesInThreads),
        Connect: permissionState(overwrite, PermissionFlagsBits.Connect),
      };
    }
    const isVoice = channel.isVoiceBased?.() || [2, 13].includes(channel.type);
    const deny = isVoice ? { Connect: false } : {
      SendMessages: false,
      CreatePublicThreads: false,
      SendMessagesInThreads: false,
    };
    const alreadyBlocked = overwrite && Object.keys(deny).every(key => overwrite.deny?.has?.(PermissionFlagsBits[key]));
    if (alreadyBlocked) continue;
    await channel.permissionOverwrites.edit(guild.roles.everyone, deny, { reason: 'Minako: ativação automática do Modo Noturno.' });
    changed++;
  }
  return { changed, originals };
}

async function restoreNightPermissions(guild, originalOverwrites = {}) {
  const ids = Object.keys(originalOverwrites || {});
  if (!ids.length) return 0;
  const channels = await resolveChannelsByIds(guild, ids);
  await ensureBotPermissions(guild, channels);
  let changed = 0;
  for (const channel of channels) {
    const original = originalOverwrites[channel.id] || { SendMessages:null, CreatePublicThreads:null, SendMessagesInThreads:null, Connect:null };
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: original.SendMessages ?? null,
      CreatePublicThreads: original.CreatePublicThreads ?? null,
      SendMessagesInThreads: original.SendMessagesInThreads ?? null,
      Connect: original.Connect ?? null,
    }, { reason: 'Minako: desativação do Modo Noturno; restauração do snapshot original.' });
    changed++;
  }
  return changed;
}

async function sendNotice(guild, config, type, channelIds = configuredNoticeIds(config), now = new Date()) {
  const channels = uniqueIds(channelIds);
  const url = config.nightModeNoticeUrl;
  const event = type;
  const phrase = await renderPhrase(guild, config, event, now, channels);
  let content = phrase.text;
  if (type === 'start') content += `\n\n-# Modo Noturno até **${config.nightModeEndTime}**.`;
  content += `\n\n-# [Ver o aviso principal com todos os detalhes](${url})`;

  const sent = [];
  for (const id of channels) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) continue;
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const p = me ? channel.permissionsFor(me) : null;
    if (p && (!p.has(PermissionFlagsBits.ViewChannel) || !p.has(PermissionFlagsBits.SendMessages))) continue;
    try {
      const message = await channel.send({ content, allowedMentions: { parse: [] } });
      sent.push(message.id);
    } catch (e) {
      console.error(`[Minako] Falha no aviso de Modo Noturno em ${guild.name}/${id}:`, e.message);
    }
  }
  return sent;
}

function sameIds(a, b) {
  const aa = uniqueIds(a).sort(); const bb = uniqueIds(b).sort();
  return aa.length === bb.length && aa.every((id, i) => id === bb[i]);
}

async function processNightMode(guild, config, now = new Date()) {
  const state = await db.loadNightModeState(guild.id);
  if (!config.nightModeEnabled) {
    if (state?.active) {
      const restoredIds = Object.keys(state.originalOverwrites || {});
      await restoreNightPermissions(guild, state.originalOverwrites || {});
      await sendNotice(guild, config, 'end', configuredNoticeIds(config), now);
      await db.saveNightModeState(guild.id, { active:false, activeDate:null, startNoticeDate:null, startAppliedDate:null, endNoticeDate:null, originalOverwrites:{} });
      return { status:'disabled-restored', active:false, changed:true, notices:['end'], restoredIds };
    }
    return { status: 'disabled' };
  }

  validateNightConfig(config);
  const targetIds = resolveAffectedChannelIds(guild, config);
  if (!targetIds.length) throw new Error('O Modo Noturno não encontrou canais afetados. Revise as categorias, canais e imunidades.');
  const event = eventForNow(now, config);
  const date = event.localDate;
  const previousActive = Boolean(state?.active);
  const previousTargetIds = Object.keys(state?.originalOverwrites || {});
  const result = { active: event.active, date, notices: [], changed: false };

  if (event.startWarning && state?.startNoticeDate !== date) {
    await sendNotice(guild, config, 'start-warning', configuredNoticeIds(config), now);
    await db.saveNightModeState(guild.id, { ...state, active: previousActive, startNoticeDate: date, activeDate: state?.activeDate || null, startAppliedDate: state?.startAppliedDate || null, endNoticeDate: state?.endNoticeDate || null });
    result.notices.push('start-warning');
  }

  if (event.active && !previousActive) {
    const applied = await applyNightPermissions(guild, {}, targetIds);
    await sendNotice(guild, config, 'start', configuredNoticeIds(config), now);
    result.notices.push('start');
    await db.saveNightModeState(guild.id, { active:true, activeDate:date, startNoticeDate:state?.startNoticeDate || null, startAppliedDate:date, endNoticeDate:state?.endNoticeDate || null, originalOverwrites:applied.originals });
    result.changed = true;
  }

  if (event.active && previousActive) {
    if (!sameIds(previousTargetIds, targetIds)) {
      await restoreNightPermissions(guild, state?.originalOverwrites || {});
      const applied = await applyNightPermissions(guild, {}, targetIds);
      await db.saveNightModeState(guild.id, { ...state, active:true, originalOverwrites:applied.originals, activeDate:state?.activeDate || date });
      result.changed = true;
    } else {
      const applied = await applyNightPermissions(guild, state?.originalOverwrites || {}, targetIds);
      if (!sameIds(Object.keys(applied.originals), previousTargetIds)) {
        await db.saveNightModeState(guild.id, { ...state, active:true, originalOverwrites:applied.originals });
      }
    }
  }

  if (event.active && event.endWarning && state?.endNoticeDate !== date) {
    await sendNotice(guild, config, 'end-warning', configuredNoticeIds(config), now);
    const latest = await db.loadNightModeState(guild.id);
    await db.saveNightModeState(guild.id, { ...latest, active:true, activeDate:latest?.activeDate || date, endNoticeDate:date, originalOverwrites:latest?.originalOverwrites || {} });
    result.notices.push('end-warning');
  }

  if (!event.active && previousActive) {
    await restoreNightPermissions(guild, state?.originalOverwrites || {});
    await sendNotice(guild, config, 'end', configuredNoticeIds(config), now);
    await db.saveNightModeState(guild.id, { active:false, activeDate:null, startNoticeDate:null, startAppliedDate:null, endNoticeDate:date, originalOverwrites:{} });
    result.changed = true; result.notices.push('end');
    return result;
  }

  return result;
}

module.exports = { NIGHT_PERMISSIONS, TIMEZONE, parseTime, eventForNow, isNightMinute, validateNightConfig, applyNightPermissions, restoreNightPermissions, sendNotice, processNightMode, resolveTargetChannels, summarizeScope };
