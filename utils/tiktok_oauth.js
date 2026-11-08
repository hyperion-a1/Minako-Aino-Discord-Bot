'use strict';

const crypto = require('node:crypto');

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REQUIRED_SCOPES = ['user.info.basic', 'video.list'];

function getEncryptionKey() {
  const raw = String(process.env.TIKTOK_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) throw new Error('TIKTOK_TOKEN_ENCRYPTION_KEY não configurada.');
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TIKTOK_TOKEN_ENCRYPTION_KEY deve representar exatamente 32 bytes (64 caracteres hex ou Base64 de 32 bytes).');
  return key;
}

function encryptToken(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('Token vazio ou inválido.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptToken(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Formato de token criptografado desconhecido.');
  const [, ivPart, tagPart, dataPart] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}

async function refreshAccessToken(refreshToken) {
  if (typeof refreshToken !== 'string' || !refreshToken) throw new TypeError('Refresh token ausente.');
  const { clientKey, clientSecret } = getOAuthConfig();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !payload.refresh_token || !payload.open_id) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    const error = new Error(`Não foi possível renovar a autorização TikTok (${String(detail).slice(0, 180)}).`);
    error.code = 'TIKTOK_REFRESH_FAILED';
    throw error;
  }
  return payload;
}

async function revokeToken(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) return false;
  const { clientKey, clientSecret } = getOAuthConfig();
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/revoke/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, token: accessToken }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`TikTok não confirmou a revogação (HTTP ${response.status}).`);
  const payload = await response.json().catch(() => ({}));
  if (payload.error) throw new Error(String(payload.error_description || payload.error).slice(0, 180));
  return true;
}

function getOAuthConfig() {
  const clientKey = String(process.env.TIKTOK_CLIENT_KEY || '').trim();
  const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.TIKTOK_REDIRECT_URI || '').trim();
  if (!clientKey || !clientSecret || !redirectUri) throw new Error('Configure TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET e TIKTOK_REDIRECT_URI.');
  let parsed;
  try { parsed = new URL(redirectUri); } catch { throw new Error('TIKTOK_REDIRECT_URI não é uma URL válida.'); }
  if (parsed.protocol !== 'https:') throw new Error('TIKTOK_REDIRECT_URI deve utilizar HTTPS.');
  if (parsed.search || parsed.hash) throw new Error('TIKTOK_REDIRECT_URI deve ser estática, sem parâmetros ou fragmentos.');
  return { clientKey, clientSecret, redirectUri };
}

function createAuthorizationUrl(state) {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) throw new TypeError('Estado OAuth inválido.');
  const { clientKey, redirectUri } = getOAuthConfig();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_key', clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', REQUIRED_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCode(code) {
  if (typeof code !== 'string' || !code || code.length > 4096) throw new TypeError('Código OAuth inválido.');
  const { clientKey, clientSecret, redirectUri } = getOAuthConfig();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token || !payload.open_id) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    const error = new Error(`TikTok não concluiu a troca do código OAuth (${String(detail).slice(0, 180)}).`);
    error.code = 'TIKTOK_TOKEN_EXCHANGE_FAILED';
    throw error;
  }
  return payload;
}

module.exports = {
  AUTHORIZE_URL, TOKEN_URL, REQUIRED_SCOPES,
  getOAuthConfig, createAuthorizationUrl, exchangeCode, refreshAccessToken, revokeToken,
  encryptToken, decryptToken
};
