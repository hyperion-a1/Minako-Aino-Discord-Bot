const db = require('./db');
const { normalizeSeasonalPackages } = require('./personality/seasonal');
const DEFAULTS = { timezone:'America/Sao_Paulo', weekStartDay:1, weekStartTime:'00:00', criterion:'messages', moderationChannelId:null, publicationChannelId:null, starRoleId:null, partidaAdminRoleIds:[], nightModeEnabled:false, nightModeStartTime:'01:00', nightModeEndTime:'05:00', nightModeNoticeChannelIds:[], nightModeNoticeUrl:null, nightModeCategoryIds:[], nightModeAffectedChannelIds:[], nightModeImmuneChannelIds:[], seasonalPackages:normalizeSeasonalPackages() };

function normalize(row) {
  if (!row) return { ...DEFAULTS };
  return {
    timezone: row.timezone ?? DEFAULTS.timezone,
    weekStartDay: row.week_start_day ?? row.weekStartDay ?? DEFAULTS.weekStartDay,
    weekStartTime: row.week_start_time ?? row.weekStartTime ?? DEFAULTS.weekStartTime,
    criterion: row.criterion ?? DEFAULTS.criterion,
    moderationChannelId: row.moderation_channel_id ?? row.moderationChannelId ?? DEFAULTS.moderationChannelId,
    publicationChannelId: row.publication_channel_id ?? row.publicationChannelId ?? DEFAULTS.publicationChannelId,
    starRoleId: row.star_role_id ?? row.starRoleId ?? DEFAULTS.starRoleId,
    partidaAdminRoleIds: Array.isArray(row.partida_admin_role_ids) ? row.partida_admin_role_ids : (Array.isArray(row.partidaAdminRoleIds) ? row.partidaAdminRoleIds : DEFAULTS.partidaAdminRoleIds),
    nightModeEnabled: row.night_mode_enabled ?? row.nightModeEnabled ?? DEFAULTS.nightModeEnabled,
    nightModeStartTime: row.night_mode_start_time ?? row.nightModeStartTime ?? DEFAULTS.nightModeStartTime,
    nightModeEndTime: row.night_mode_end_time ?? row.nightModeEndTime ?? DEFAULTS.nightModeEndTime,
    nightModeNoticeChannelIds: Array.isArray(row.night_mode_notice_channel_ids) ? row.night_mode_notice_channel_ids : (Array.isArray(row.nightModeNoticeChannelIds) ? row.nightModeNoticeChannelIds : DEFAULTS.nightModeNoticeChannelIds),
    nightModeNoticeUrl: row.night_mode_notice_url ?? row.nightModeNoticeUrl ?? DEFAULTS.nightModeNoticeUrl,
    nightModeCategoryIds: Array.isArray(row.night_mode_category_ids) ? row.night_mode_category_ids : (Array.isArray(row.nightModeCategoryIds) ? row.nightModeCategoryIds : DEFAULTS.nightModeCategoryIds),
    nightModeAffectedChannelIds: Array.isArray(row.night_mode_affected_channel_ids) ? row.night_mode_affected_channel_ids : (Array.isArray(row.nightModeAffectedChannelIds) ? row.nightModeAffectedChannelIds : DEFAULTS.nightModeAffectedChannelIds),
    nightModeImmuneChannelIds: Array.isArray(row.night_mode_immune_channel_ids) ? row.night_mode_immune_channel_ids : (Array.isArray(row.nightModeImmuneChannelIds) ? row.nightModeImmuneChannelIds : DEFAULTS.nightModeImmuneChannelIds),
    seasonalPackages: normalizeSeasonalPackages(row.seasonal_packages ?? row.seasonalPackages),
  };
}

async function getConfig(guildId){ return normalize(await db.loadConfig(guildId)); }
module.exports={DEFAULTS,getConfig,normalize};
