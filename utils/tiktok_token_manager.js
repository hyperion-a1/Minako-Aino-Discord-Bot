'use strict';

const store = require('./tiktok_store');
const oauth = require('./tiktok_oauth');

const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const refreshInFlight = new Map();

async function getValidAccessToken({ guildId, accountId, ownerDiscordId }) {
  const saved = await store.getAccountTokenCiphertext({ guildId, accountId, discordUserId: ownerDiscordId });
  if (!saved || saved.connection_status !== 'connected' || saved.approval_status !== 'approved' || !saved.access_token_ciphertext) {
    throw new Error('A conta TikTok não está conectada e aprovada.');
  }
  const expiry = saved.token_expires_at ? new Date(saved.token_expires_at).getTime() : 0;
  if (expiry > Date.now() + REFRESH_MARGIN_MS) return oauth.decryptToken(saved.access_token_ciphertext);
  if (!saved.refresh_token_ciphertext) throw new Error('A conta TikTok não possui refresh token. É necessário reconectar.');

  const lockKey = `${guildId}:${accountId}`;
  if (refreshInFlight.has(lockKey)) return refreshInFlight.get(lockKey);
  const refreshPromise = (async () => {
    try {
      // Releitura após adquirir o lock: outra chamada pode ter renovado o token nesse intervalo.
      const latest = await store.getAccountTokenCiphertext({ guildId, accountId, discordUserId: ownerDiscordId });
      const latestExpiry = latest?.token_expires_at ? new Date(latest.token_expires_at).getTime() : 0;
      if (latest?.access_token_ciphertext && latestExpiry > Date.now() + REFRESH_MARGIN_MS) return oauth.decryptToken(latest.access_token_ciphertext);
      if (!latest?.refresh_token_ciphertext) throw new Error('A conta TikTok não possui refresh token. É necessário reconectar.');
      const refreshed = await oauth.refreshAccessToken(oauth.decryptToken(latest.refresh_token_ciphertext));
      if (refreshed.open_id !== latest.tiktok_open_id) throw new Error('O identificador TikTok mudou durante a renovação; reconexão necessária.');
      const updated = await store.updateAccountTokens({
        guildId, accountId, openId: latest.tiktok_open_id,
        accessTokenCiphertext: oauth.encryptToken(refreshed.access_token),
        refreshTokenCiphertext: oauth.encryptToken(refreshed.refresh_token),
        tokenExpiresAt: new Date(Date.now() + Number(refreshed.expires_in || 0) * 1000),
        refreshTokenExpiresAt: new Date(Date.now() + Number(refreshed.refresh_expires_in || 0) * 1000)
      });
      if (!updated) throw new Error('Não foi possível salvar a rotação dos tokens TikTok.');
      return refreshed.access_token;
    } catch (error) {
      await store.markAccountError({ guildId, accountId, message: error.message }).catch(() => {});
      throw error;
    } finally {
      refreshInFlight.delete(lockKey);
    }
  })();
  refreshInFlight.set(lockKey, refreshPromise);
  return refreshPromise;
}

module.exports = { REFRESH_MARGIN_MS, getValidAccessToken };
