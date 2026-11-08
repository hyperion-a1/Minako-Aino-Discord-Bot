'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const oauth = require('../utils/tiktok_oauth');

process.env.TIKTOK_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const token = 'tiktok-access-token-test';
const encrypted = oauth.encryptToken(token);
assert.notEqual(encrypted, token);
assert.equal(oauth.decryptToken(encrypted), token);
assert.throws(() => oauth.decryptToken(`${encrypted.slice(0, -1)}x`));

process.env.TIKTOK_CLIENT_KEY = 'test-client-key';
process.env.TIKTOK_CLIENT_SECRET = 'test-client-secret';
process.env.TIKTOK_REDIRECT_URI = 'https://minako.example.com/api/tiktok/callback';
const state = crypto.randomBytes(32).toString('hex');
const authUrl = new URL(oauth.createAuthorizationUrl(state));
assert.equal(authUrl.origin + authUrl.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
assert.equal(authUrl.searchParams.get('client_key'), 'test-client-key');
assert.equal(authUrl.searchParams.get('response_type'), 'code');
assert.equal(authUrl.searchParams.get('scope'), 'user.info.basic,video.list');
assert.equal(authUrl.searchParams.get('redirect_uri'), process.env.TIKTOK_REDIRECT_URI);
assert.equal(authUrl.searchParams.get('state'), state);

process.env.TIKTOK_REDIRECT_URI = 'http://insecure.example.com/callback';
assert.throws(() => oauth.createAuthorizationUrl(state), /HTTPS/);
process.env.TIKTOK_REDIRECT_URI = 'https://minako.example.com/callback?unsafe=1';
assert.throws(() => oauth.createAuthorizationUrl(state), /estática/);

console.log('TikTok OAuth: testes passaram.');
