'use strict';
const assert = require('node:assert/strict');

class FakeEmbedBuilder {
  setColor() { return this; }
  setAuthor() { return this; }
  setTitle() { return this; }
  setURL() { return this; }
  setDescription() { return this; }
  addFields() { return this; }
  setTimestamp() { return this; }
  setImage() { return this; }
}
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'discord.js') return { EmbedBuilder: FakeEmbedBuilder };
  if (request === 'pg') return { Pool: class FakePool {} };
  return originalLoad.call(this, request, parent, isMain);
};

const monitor = require('../utils/tiktok_video_monitor');
Module._load = originalLoad;
const normalized = monitor.normalizeVideo({
  id: '123456789', title: 'Vídeo novo', video_description: 'Descrição',
  create_time: 1793820000, share_url: 'https://www.tiktok.com/@teste/video/123456789',
  cover_image_url: 'https://p16-sign.tiktokcdn.com/cover.jpeg'
});
assert.equal(normalized.id, '123456789');
assert.equal(normalized.title, 'Vídeo novo');
assert.equal(normalized.url, 'https://www.tiktok.com/@teste/video/123456789');
assert.ok(normalized.occurredAt instanceof Date);
assert.equal(monitor.normalizeVideo({ title: 'sem id' }), null);
assert.equal(monitor.normalizeVideo({ id: 'abc', share_url: 'javascript:alert(1)' }).url, 'https://www.tiktok.com/video/abc');

(async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, monitor.API_URL);
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).max_count, 20);
    return { ok: true, status: 200, json: async () => ({ error: { code: 'ok' }, data: { videos: [{ id: 'v1' }] } }) };
  };
  const videos = await monitor.fetchVideos('fake-token');
  assert.equal(videos.length, 1);
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'invalid_token', message: 'expired' } }) });
  await assert.rejects(() => monitor.fetchVideos('bad-token'), /invalid_token/);
  global.fetch = originalFetch;
  console.log('TikTok Video Monitor: testes passaram.');
})().catch(error => { console.error(error); process.exitCode = 1; });
