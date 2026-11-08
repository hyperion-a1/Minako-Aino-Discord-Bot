const db = require('./db');

const MAX_HOURS = 24;
const managedGuilds = new Map();

function normalizeSettings(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const duration = Number(config.securityDurationHours);
  return {
    managed: config.securityActionsManaged === true,
    pauseInvites: config.pauseInvites === true,
    pauseDms: config.pauseDms === true,
    durationHours: Number.isInteger(duration) && duration >= 1 && duration <= MAX_HOURS ? duration : 2,
  };
}

async function loadSettings(guildId) {
  const { rows } = await db.getPool().query(
    'SELECT config FROM minako_activity_dashboard_settings WHERE guild_id=$1',
    [guildId]
  );
  return normalizeSettings(rows[0]?.config);
}

async function applySecurityActions(guild, now = Date.now()) {
  let settings;
  try {
    settings = await loadSettings(guild.id);
  } catch (error) {
    // A Dashboard ainda não instalada/configurada não deve afetar ações manuais do servidor.
    if (error.code === '42P01') return { skipped: true, reason: 'dashboard_schema_missing' };
    throw error;
  }
  if (!settings.managed) return { skipped: true, reason: 'not_configured' };

  const previous = managedGuilds.get(guild.id);
  const sameState = previous
    && previous.pauseInvites === settings.pauseInvites
    && previous.pauseDms === settings.pauseDms
    && previous.durationHours === settings.durationHours;
  if (sameState && previous.expiresAt - now > 5 * 60 * 1000) {
    return { skipped: true, reason: 'already_applied', expiresAt: previous.expiresAt };
  }

  const expiresAt = new Date(now + settings.durationHours * 60 * 60 * 1000).toISOString();
  const body = {
    invites_disabled_until: settings.pauseInvites ? expiresAt : null,
    dms_disabled_until: settings.pauseDms ? expiresAt : null,
  };
  await guild.client.rest.put(`/guilds/${guild.id}/incident-actions`, { body });
  managedGuilds.set(guild.id, { ...settings, expiresAt: new Date(expiresAt).getTime() });
  return { applied: true, ...settings, expiresAt };
}

function clearCache(guildId) {
  if (guildId) managedGuilds.delete(guildId);
  else managedGuilds.clear();
}

module.exports = { MAX_HOURS, normalizeSettings, applySecurityActions, clearCache };
