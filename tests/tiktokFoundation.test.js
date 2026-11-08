'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

const dbPath = require.resolve('../utils/db');
const calls = [];
const fakeDb = {
  getPool() {
    return {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (/SELECT \* FROM minako_tiktok_settings/.test(sql)) return { rows: [] };
        if (/INSERT INTO minako_tiktok_settings/.test(sql)) return { rows: [{
          guild_id: params[0], notification_channel_id: params[1],
          video_notifications_enabled: params[2], live_notifications_enabled: false,
          live_announcements_enabled: params[3], live_mention_creator: params[4],
          live_announce_account_cooldown_seconds: params[5], live_announce_guild_cooldown_seconds: params[6],
          poll_interval_minutes: params[7], max_accounts: params[8], approval_mode: 'hybrid'
        }] };
        return { rows: [] };
      }
    };
  }
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const schema = require('../utils/tiktok_schema');
const store = require('../utils/tiktok_store');

(async () => {
  assert.match(schema.SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS minako_tiktok_settings/);
  assert.match(schema.SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS minako_tiktok_accounts/);
  assert.match(schema.SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS minako_tiktok_events/);
  assert.match(schema.SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS minako_tiktok_oauth_states/);
  assert.match(schema.SCHEMA_SQL, /UNIQUE \(guild_id, account_id, event_type, external_event_id\)/);

  const defaults = await store.getSettings('guild-1');
  assert.equal(defaults.pollIntervalMinutes, 5);
  assert.equal(defaults.maxAccounts, 10);
  assert.equal(defaults.approvalMode, 'hybrid');
  assert.equal(defaults.liveAnnouncementsEnabled, false);
  assert.equal(defaults.liveMentionCreator, false);

  const saved = await store.saveSettings('guild-1', { notificationChannelId: 'channel-1' });
  assert.equal(saved.notificationChannelId, 'channel-1');
  assert.equal(saved.pollIntervalMinutes, 5);
  assert.equal(saved.maxAccounts, 10);
  assert.equal(saved.liveAnnouncementsEnabled, false);
  assert.equal(saved.liveAnnounceAccountCooldownSeconds, 900);

  await assert.rejects(
    () => store.saveSettings('guild-1', { pollIntervalMinutes: 2 }),
    /entre 5 e 60/
  );
  await assert.rejects(
    () => store.saveSettings('guild-1', { maxAccounts: 11 }),
    /entre 1 e 10/
  );
  assert.ok(calls.some(call => /INSERT INTO minako_tiktok_settings/.test(call.sql)));
  console.log('TikTok Watcher foundation: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
