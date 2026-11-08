// Mantido sem importar discord.js para que este utilitário puro possa ser testado isoladamente.
const CHANNEL_TYPES = Object.freeze({ GuildText:0, GuildVoice:2, GuildCategory:4, GuildAnnouncement:5, GuildStageVoice:13, GuildForum:15, GuildMedia:16 });
const TARGET_TYPES = new Set([CHANNEL_TYPES.GuildText, CHANNEL_TYPES.GuildVoice, CHANNEL_TYPES.GuildAnnouncement, CHANNEL_TYPES.GuildStageVoice, CHANNEL_TYPES.GuildForum, CHANNEL_TYPES.GuildMedia]);

function uniqueIds(values) {
  return [...new Set(Array.isArray(values) ? values.filter(Boolean).map(String) : [])];
}

function isTargetableChannel(channel) {
  if (!channel) return false;
  if (channel.isThread?.()) return false;
  if (channel.type === CHANNEL_TYPES.GuildCategory) return false;
  return TARGET_TYPES.has(channel.type) || (channel.isTextBased?.() && channel.permissionOverwrites);
}

function normalizeScope(config = {}) {
  return {
    categoryIds: uniqueIds(config.nightModeCategoryIds),
    affectedChannelIds: uniqueIds(config.nightModeAffectedChannelIds),
    immuneChannelIds: uniqueIds(config.nightModeImmuneChannelIds),
  };
}

function channelsFromCache(guild) {
  return [...(guild.channels?.cache?.values?.() || [])];
}

function categoryChannelIds(guild, categoryIds) {
  const categories = new Set(uniqueIds(categoryIds));
  return channelsFromCache(guild)
    .filter(channel => isTargetableChannel(channel) && categories.has(String(channel.parentId)))
    .map(channel => channel.id);
}

function resolveAffectedChannelIds(guild, config) {
  const scope = normalizeScope(config);
  const categoryIds = new Set(scope.categoryIds);
  const directIds = new Set(scope.affectedChannelIds);
  const immuneIds = new Set(scope.immuneChannelIds);
  const selected = new Set();

  for (const id of directIds) selected.add(id);
  for (const id of categoryChannelIds(guild, scope.categoryIds)) selected.add(id);
  for (const id of immuneIds) selected.delete(id);

  return [...selected];
}

function overlappingImmuneIds(guild, config) {
  const scope = normalizeScope(config);
  const selectedByCategory = new Set(categoryChannelIds(guild, scope.categoryIds));
  const selectedDirect = new Set(scope.affectedChannelIds);
  return scope.immuneChannelIds.filter(id => selectedDirect.has(id) || selectedByCategory.has(id));
}

function summarizeScope(guild, config) {
  const scope = normalizeScope(config);
  const affected = resolveAffectedChannelIds(guild, config);
  const overlaps = overlappingImmuneIds(guild, config);
  return { ...scope, resolvedChannelIds: affected, overlappingImmuneIds: overlaps };
}

module.exports = {
  TARGET_TYPES,
  uniqueIds,
  isTargetableChannel,
  normalizeScope,
  categoryChannelIds,
  resolveAffectedChannelIds,
  overlappingImmuneIds,
  summarizeScope,
};
