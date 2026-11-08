import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Carrega primeiro o .env existente da Minako e depois o da Activity (sem sobrescrever valores já definidos).
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });
const app = express();
const port = Number(process.env.PORT || (process.env.NODE_ENV === 'production' ? 80 : 3001));
const require = createRequire(import.meta.url);

// Reutiliza os módulos reais do projeto da Minako, sem copiar a lógica do matchmaking.
const db = require('../utils/db.js');
const mmStore = require('../utils/matchmaking/store.js');
const mmSchema = require('../utils/matchmaking/schema.js');
const centralView = require('../utils/matchmaking/centralView.js');
const minakoConfig = require('../utils/config.js');
const giveawayStore = require('../utils/giveawayStore.js');
const giveawayCore = require('../utils/giveawayCore.js');
const tiktokStore = require('../utils/tiktok_store.js');
const tiktokOAuth = require('../utils/tiktok_oauth.js');
const crypto = require('node:crypto');

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

app.get('/api/health', noStore, async (_req, res) => {
  let database = 'disabled';
  let databaseHint = '';
  if (db.isEnabled()) {
    try { await db.getPool().query('SELECT 1'); database = 'ok'; } catch (e) { database = 'error'; databaseHint = dbHint(e); console.error('[Activity] Health: falha no banco:', e.code || '', e.message); }
  }
  res.json({ ok: true, service: 'minako-activity-api', mode: process.env.DATABASE_URL ? 'database-configured' : 'database-not-configured', database, databaseHint, distStale });
});


// Retorno OAuth do TikTok. O state é aleatório, armazenado somente como hash e consumido uma vez.
app.get('/api/tiktok/callback', noStore, async (req, res) => {
  const fail = (status, message) => res.status(status).type('text/plain; charset=utf-8').send(`TikTok Watcher — ${message}\nVocê pode fechar esta janela e voltar ao Discord.`);
  try {
    if (!db.isEnabled()) return fail(503, 'banco de dados indisponível.');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!/^[a-f0-9]{64}$/.test(state)) return fail(400, 'estado de autorização inválido.');
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const context = await tiktokStore.consumeOAuthState(stateHash);
    if (!context) return fail(400, 'link expirado ou já utilizado. Inicie uma nova conexão pelo Discord.');
    if (req.query.error) return fail(400, 'a autorização foi cancelada ou recusada.');
    if (!code || code.length > 4096) return fail(400, 'código de autorização ausente.');

    const account = await tiktokStore.getAccountById(context.guild_id, context.account_id);
    if (!account || account.owner_discord_id !== context.discord_user_id || account.approval_status !== 'approved') {
      return fail(403, 'a conta não corresponde à solicitação aprovada.');
    }

    const token = await tiktokOAuth.exchangeCode(code);
    const grantedScopes = String(token.scope || '').split(',').map(scope => scope.trim()).filter(Boolean);
    if (!grantedScopes.includes('user.info.basic') || !grantedScopes.includes('video.list')) {
      return fail(403, 'a autorização não incluiu todas as permissões necessárias (user.info.basic e video.list). Revise as permissões e tente novamente.');
    }
    let displayName = null;
    try {
      const profileResponse = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10000)
      });
      const profile = await profileResponse.json().catch(() => ({}));
      if (profileResponse.ok && profile?.data?.user?.open_id === token.open_id) displayName = profile.data.user.display_name || null;
    } catch (profileError) {
      console.warn('[TikTok] Não foi possível consultar o nome público do perfil:', profileError.message);
    }

    // Teste real da Display API durante a conexão: consulta até cinco vídeos recentes.
    // A autorização é armazenada mesmo se a listagem falhar, para facilitar o diagnóstico
    // de escopo/produto sem obrigar o criador a repetir o OAuth a cada tentativa.
    let videoTest = { ok: false, count: 0, detail: 'Não foi possível consultar os vídeos.' };
    try {
      const videoResponse = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ max_count: 5 }),
        signal: AbortSignal.timeout(15000)
      });
      const videoPayload = await videoResponse.json().catch(() => ({}));
      const apiError = videoPayload?.error;
      if (videoResponse.ok && apiError?.code === 'ok') {
        const videos = Array.isArray(videoPayload?.data?.videos) ? videoPayload.data.videos : [];
        videoTest = { ok: true, count: videos.length, detail: videos.length
          ? `A Display API retornou ${videos.length} vídeo(s) recente(s).`
          : 'A Display API respondeu corretamente, mas não encontrou vídeos recentes disponíveis para esta conta.' };
      } else {
        const code = String(apiError?.code || `HTTP_${videoResponse.status}`).slice(0, 80);
        videoTest = { ok: false, count: 0, detail: `A autorização OAuth foi concluída, mas a consulta de vídeos falhou (${code}).` };
        console.warn('[TikTok] Teste video.list falhou:', code, String(apiError?.message || '').slice(0, 240));
      }
    } catch (videoError) {
      videoTest = { ok: false, count: 0, detail: 'A autorização foi concluída, mas houve uma falha de rede ao consultar a Display API.' };
      console.warn('[TikTok] Falha de rede no teste video.list:', videoError.message);
    }

    const connected = await tiktokStore.setAccountConnected({
      guildId: context.guild_id,
      accountId: context.account_id,
      discordUserId: context.discord_user_id,
      openId: token.open_id,
      displayName,
      grantedScopes: token.scope || '',
      accessTokenCiphertext: tiktokOAuth.encryptToken(token.access_token),
      refreshTokenCiphertext: token.refresh_token ? tiktokOAuth.encryptToken(token.refresh_token) : null,
      tokenExpiresAt: Number.isFinite(Number(token.expires_in)) ? new Date(Date.now() + Number(token.expires_in) * 1000) : null,
      refreshTokenExpiresAt: Number.isFinite(Number(token.refresh_expires_in)) ? new Date(Date.now() + Number(token.refresh_expires_in) * 1000) : null
    });
    if (!connected) return fail(409, 'não foi possível associar a conta aprovada. Entre em contato com a administração.');
    const heading = videoTest.ok ? 'OAuth e Display API testados!' : 'OAuth conectado; teste da Display API pendente';
    const tone = videoTest.ok ? '#137333' : '#9a6700';
    return res.status(200).type('text/html; charset=utf-8').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Teste TikTok — Minako</title><body style="font:16px system-ui;max-width:600px;margin:12vh auto;padding:24px;color:#222"><h1>Conta TikTok conectada!</h1><p>A autorização OAuth foi concluída e os tokens foram armazenados com criptografia.</p><h2 style="color:${tone}">${heading}</h2><p>${videoTest.detail}</p><p>Você já pode voltar ao Discord. A conexão foi salva para diagnóstico e próximos testes.</p></body></html>`);
  } catch (error) {
    console.error('[TikTok] Falha no callback OAuth:', error.message);
    const status = error.code === 'TIKTOK_TOKEN_EXCHANGE_FAILED' ? 502 : 500;
    return fail(status, 'não foi possível concluir a conexão. Gere um novo link pelo Discord.');
  }
});

// ===== Acesso pelo navegador: login OAuth2 web (a Activity continua usando Bearer) =====
// Sessão em memória: o token do Discord fica só no servidor; o navegador recebe apenas um cookie opaco.
app.set('trust proxy', 1);
const SESSION_COOKIE = 'mk_sid';
const STATE_COOKIE = 'mk_state';
const SESSION_MAX_SEC = 7 * 24 * 3600;
const sessions = new Map();
const loginHits = new Map();
const isProd = process.env.NODE_ENV === 'production';
const siteUrl = (req) => (process.env.SITE_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const parseCookies = (req) => Object.fromEntries((req.get('cookie') || '').split(';').map((p) => p.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
const setCookie = (res, name, value, maxAgeSec) => res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isProd ? '; Secure' : ''}`);
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const rateLimited = (req, max = 30) => {
  const now = Date.now();
  const hits = (loginHits.get(req.ip) || []).filter((t) => now - t < 600000);
  hits.push(now); loginHits.set(req.ip, hits);
  return hits.length > max;
};
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expires < now) sessions.delete(sid);
  if (db.isEnabled()) db.getPool().query('DELETE FROM minako_web_sessions WHERE expires_at < now()').catch(() => {});
  for (const [ip, hits] of loginHits) if (!hits.some((t) => now - t < 600000)) loginHits.delete(ip);
}, 600000).unref();

const sessionKey = crypto.createHash('sha256').update(`minako-web-session:${process.env.SESSION_SECRET || process.env.DISCORD_CLIENT_SECRET || ''}`).digest();
const seal = (text) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', sessionKey, iv); const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.'); };
const unseal = (v) => { const [iv, tag, enc] = v.split('.').map((x) => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); };
const sidHash = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');
let sessionSchemaReady = null;
const ensureSessionSchema = () => (sessionSchemaReady ||= db.getPool().query(`CREATE TABLE IF NOT EXISTS minako_web_sessions (
  sid_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, csrf TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch((e) => { sessionSchemaReady = null; throw e; }));

async function saveSession(sid, s) {
  sessions.set(sid, s);
  if (!db.isEnabled()) return;
  try {
    await ensureSessionSchema();
    await db.getPool().query('INSERT INTO minako_web_sessions (sid_hash,user_id,username,csrf,token_ciphertext,expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [sidHash(sid), s.user.id, s.user.username, s.csrf, seal(s.accessToken), new Date(s.expires)]);
  } catch (e) { console.warn('[Web] Sessão não persistida no banco:', e.message); }
}
async function dropSession(sid) {
  if (!sid) return;
  sessions.delete(sid);
  if (db.isEnabled()) await db.getPool().query('DELETE FROM minako_web_sessions WHERE sid_hash=$1', [sidHash(sid)]).catch(() => {});
}
async function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  let s = sessions.get(sid);
  if (!s && db.isEnabled()) {
    try {
      await ensureSessionSchema();
      const { rows } = await db.getPool().query('SELECT * FROM minako_web_sessions WHERE sid_hash=$1 AND expires_at>now()', [sidHash(sid)]);
      if (rows[0]) {
        s = { accessToken: unseal(rows[0].token_ciphertext), csrf: rows[0].csrf, expires: new Date(rows[0].expires_at).getTime(), user: { id: rows[0].user_id, username: rows[0].username } };
        sessions.set(sid, s);
      }
    } catch (e) { console.warn('[Web] Falha ao ler sessão do banco:', e.message); }
  }
  if (!s) return null;
  if (s.expires < Date.now()) { await dropSession(sid); return null; }
  return s;
}

// Aceita Bearer (Activity) ou cookie de sessão (web). Com cookie, métodos que alteram dados exigem o token CSRF.
async function resolveAuth(req) {
  const bearer = readBearer(req);
  if (bearer) return { token: bearer, via: 'bearer' };
  const session = await getSession(req);
  if (!session) return { token: '' };
  if (!['GET', 'HEAD'].includes(req.method) && !safeEqual(req.get('x-csrf-token') || '', session.csrf)) return { token: '', csrfFailed: true };
  return { token: session.accessToken, via: 'session', session };
}

app.get('/auth/login', noStore, (req, res) => {
  if (rateLimited(req)) return res.status(429).type('text/plain; charset=utf-8').send('Muitas tentativas. Aguarde alguns minutos.');
  if (!process.env.DISCORD_CLIENT_ID) return res.status(503).type('text/plain; charset=utf-8').send('DISCORD_CLIENT_ID não configurado.');
  const state = crypto.randomBytes(24).toString('hex');
  setCookie(res, STATE_COOKIE, state, 600);
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify guilds',
    redirect_uri: `${siteUrl(req)}/auth/callback`, state,
  });
  return res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', noStore, async (req, res) => {
  try {
    if (rateLimited(req)) return res.redirect('/?login=erro');
    const saved = parseCookies(req)[STATE_COOKIE] || '';
    setCookie(res, STATE_COOKIE, '', 0);
    if (req.query.error) return res.redirect('/?login=cancelado');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || code.length > 4096 || !saved || !safeEqual(state, saved)) return res.redirect('/?login=erro');
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: `${siteUrl(req)}/auth/callback`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) { console.warn('[Web] Troca OAuth falhou:', response.status); return res.redirect('/?login=erro'); }
    const user = await getDiscordUser(payload.access_token);
    if (!user?.id) return res.redirect('/?login=erro');
    const ttl = Math.min(Number(payload.expires_in) || SESSION_MAX_SEC, SESSION_MAX_SEC);
    const sid = crypto.randomBytes(32).toString('hex');
    await saveSession(sid, {
      accessToken: payload.access_token, csrf: crypto.randomBytes(24).toString('hex'), expires: Date.now() + ttl * 1000,
      user: { id: user.id, username: user.global_name || user.username },
    });
    setCookie(res, SESSION_COOKIE, sid, ttl);
    return res.redirect('/');
  } catch (error) {
    console.error('[Web] Erro no callback OAuth:', error.message);
    return res.redirect('/?login=erro');
  }
});

app.post('/auth/logout', noStore, async (req, res) => {
  const auth = await resolveAuth(req);
  if (auth.csrfFailed) return res.status(403).json({ error: 'Token CSRF inválido.' });
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) await dropSession(sid);
  setCookie(res, SESSION_COOKIE, '', 0);
  return res.json({ ok: true });
});

app.get('/api/session', noStore, async (req, res) => {
  const s = await getSession(req);
  res.json(s ? { authenticated: true, user: s.user, csrf: s.csrf } : { authenticated: false });
});

// Servidores onde a pessoa é Administrator e a Minako está presente (checagem do bot em cache por 5 min).
const botGuilds = { at: 0, ids: null };
async function getBotGuildIds() {
  if (!process.env.MINAKO_TOKEN) return null;
  if (botGuilds.ids && Date.now() - botGuilds.at < 300000) return botGuilds.ids;
  const ids = new Set();
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL('https://discord.com/api/v10/users/@me/guilds');
    url.searchParams.set('limit', '200');
    if (after) url.searchParams.set('after', after);
    const response = await fetch(url, { headers: { Authorization: `Bot ${process.env.MINAKO_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return botGuilds.ids;
    const list = await response.json();
    list.forEach((g) => ids.add(g.id));
    if (list.length < 200) break;
    after = list[list.length - 1].id;
  }
  botGuilds.at = Date.now(); botGuilds.ids = ids;
  return ids;
}

app.get('/api/web/guilds', noStore, async (req, res) => {
  try {
    const auth = await resolveAuth(req);
    if (auth.via !== 'session') return res.status(401).json({ error: 'Entre com o Discord para continuar.' });
    const all = [];
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL('https://discord.com/api/v10/users/@me/guilds');
      url.searchParams.set('limit', '200');
      if (after) url.searchParams.set('after', after);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(10000) });
      if (response.status === 401) { await dropSession(parseCookies(req)[SESSION_COOKIE]); return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' }); }
      if (!response.ok) return res.status(502).json({ error: 'Não foi possível listar seus servidores.' });
      const list = await response.json();
      all.push(...list);
      if (list.length < 200) break;
      after = list[list.length - 1].id;
    }
    const botIds = await getBotGuildIds();
    const guilds = all
      .filter((g) => { try { return (BigInt(g.permissions || '0') & 8n) === 8n; } catch { return false; } })
      .filter((g) => !botIds || botIds.has(g.id))
      .map((g) => ({ id: g.id, name: g.name, icon: g.icon || null }));
    return res.json({ guilds });
  } catch (error) {
    console.error('[Web] Erro ao listar servidores:', error.message);
    return res.status(502).json({ error: 'Não foi possível listar seus servidores.' });
  }
});

// Troca o authorization code obtido pelo Embedded App SDK por um token OAuth2.
// O Client Secret permanece exclusivamente no servidor.
app.post('/api/token', noStore, async (req, res) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!code || code.length > 4096) return res.status(400).json({ error: 'Código OAuth ausente ou inválido.' });
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Configure DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET no arquivo .env da Activity.' });
    }

    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      console.warn('[Activity] Discord OAuth exchange failed:', response.status);
      return res.status(401).json({ error: 'Não foi possível autorizar esta sessão com o Discord.' });
    }
    return res.json({ access_token: payload.access_token, token_type: payload.token_type, expires_in: payload.expires_in, scope: payload.scope });
  } catch (error) {
    console.error('[Activity] OAuth exchange error:', error.message);
    return res.status(502).json({ error: 'Falha ao comunicar com o Discord durante a autorização.' });
  }
});

async function getDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  return response.json();
}

async function getUserGuild(accessToken, guildId) {
  let before = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL('https://discord.com/api/v10/users/@me/guilds');
    url.searchParams.set('limit', '200');
    if (before) url.searchParams.set('before', before);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const guilds = await response.json();
    if (!Array.isArray(guilds) || guilds.length === 0) return null;
    const found = guilds.find((guild) => guild.id === guildId);
    if (found) return found;
    if (guilds.length < 200) return null;
    before = guilds[guilds.length - 1].id;
  }
  return null;
}

async function isGuildMember(accessToken, guildId) {
  return Boolean(await getUserGuild(accessToken, guildId));
}

function readBearer(req) {
  const match = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
}

async function authorizeDashboard(req, res, next) {
  try {
    const auth = await resolveAuth(req);
    if (auth.csrfFailed) return res.status(403).json({ error: 'Token CSRF inválido. Recarregue a página.' });
    const accessToken = auth.token;
    const guildId = String(req.query.guildId || req.body?.guildId || '');
    if (!accessToken) return res.status(401).json({ error: 'Conecte-se ao Discord para acessar a Dashboard.' });
    if (!/^\d{17,20}$/.test(guildId)) return res.status(400).json({ error: 'Abra a Activity dentro de um servidor do Discord.' });
    const user = await getDiscordUser(accessToken);
    if (!user?.id) return res.status(401).json({ error: 'Sua sessão do Discord expirou. Conecte-se novamente.' });
    const guild = await getUserGuild(accessToken, guildId);
    if (!guild) return res.status(403).json({ error: 'Você precisa ser membro deste servidor para acessar a Dashboard.' });
    let permissions = 0n;
    try { permissions = BigInt(guild.permissions || '0'); } catch {}
    if ((permissions & 8n) !== 8n) return res.status(403).json({ error: 'A Dashboard está restrita a administradores do servidor.' });
    req.dashboardContext = { guildId, userId: user.id };
    return next();
  } catch (error) {
    console.error('[Activity] Dashboard authorization error:', error.message);
    return res.status(502).json({ error: 'Não foi possível verificar suas permissões no Discord.' });
  }
}

const DASHBOARD_SCHEMA = `CREATE TABLE IF NOT EXISTS minako_activity_dashboard_settings (
  guild_id TEXT PRIMARY KEY,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
const csvIds = (value) => String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
const onlySnowflakes = (value, label) => {
  const ids = csvIds(value);
  if (ids.some((id) => !/^\d{15,22}$/.test(id))) throw new Error(`${label}: use IDs numéricos do Discord, separados por vírgula.`);
  return [...new Set(ids)];
};
const dayToNumber = (day) => ({ sunday: 0, monday: 1, saturday: 6 }[day] ?? 1);
const numberToDay = (day) => ({ 0: 'sunday', 1: 'monday', 6: 'saturday' }[day] ?? 'monday');
const toDashboard = (row, stored = {}) => {
  const c = minakoConfig.normalize(row);
  return {
    ...stored,
    weekStartDay: numberToDay(c.weekStartDay), weekStartTime: c.weekStartTime, timezone: c.timezone,
    moderationChannel: c.moderationChannelId || '', publicationChannel: c.publicationChannelId || '',
    nightEnabled: c.nightModeEnabled, nightStart: c.nightModeStartTime, nightEnd: c.nightModeEndTime,
    nightCategories: (c.nightModeCategoryIds || []).join(', '), nightAffectedChannels: (c.nightModeAffectedChannelIds || []).join(', '),
    nightImmuneChannels: (c.nightModeImmuneChannelIds || []).join(', '), nightNoticeChannels: (c.nightModeNoticeChannelIds || []).join(', '),
    nightNoticeUrl: c.nightModeNoticeUrl || '',
    seasonal: { halloween: c.seasonalPackages.halloween !== false, christmas: c.seasonalPackages.natal !== false, newYear: c.seasonalPackages.ano_novo !== false },
    starRole: c.starRoleId || '', matchAdminRoles: (c.partidaAdminRoleIds || []).join(', '),
  };
};

async function loadDashboardConfig(guildId) {
  const { rows } = await db.getPool().query('SELECT config FROM minako_activity_dashboard_settings WHERE guild_id=$1', [guildId]);
  const stored = rows[0]?.config || {};
  const row = await db.loadConfig(guildId);
  return toDashboard(row, stored);
}

// Datas dos sorteios: o campo datetime-local não tem fuso. O servidor (UTC na hospedagem) o lia como UTC,
// enquanto o bot usa o horário de Brasília. Aqui o valor é sempre interpretado em GIVEAWAY_TZ.
const GIVEAWAY_TZ = (() => { const tz = process.env.GIVEAWAY_TIMEZONE || 'America/Sao_Paulo'; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'America/Sao_Paulo'; } })();
function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  const g = (t) => Number(parts.find((x) => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000;
}
function localToDate(value, tz = GIVEAWAY_TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || ''));
  if (!m) return new Date(value); // ISO completo (com Z/offset) segue como está
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const first = wall - tzOffsetMs(wall, tz);
  return new Date(wall - tzOffsetMs(first, tz));
}
function dateToLocal(value, tz = GIVEAWAY_TZ) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

// Traduz erros comuns do PostgreSQL em dicas legíveis (sem expor host, usuário ou senha).
function dbHint(error) {
  const code = String(error?.code || '');
  const known = {
    ECONNREFUSED: 'o servidor do PostgreSQL recusou a conexão', ENOTFOUND: 'o endereço do banco não foi encontrado (confira DATABASE_URL)',
    ETIMEDOUT: 'tempo esgotado ao conectar no banco', ECONNRESET: 'a conexão com o banco foi interrompida',
    '28P01': 'usuário ou senha do banco incorretos (confira DATABASE_URL)', '28000': 'o banco recusou o usuário informado',
    '3D000': 'o banco informado em DATABASE_URL não existe', '53300': 'o banco atingiu o limite de conexões',
    '57P03': 'o banco está iniciando, tente de novo em instantes', '42P01': 'falta uma tabela no banco',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado SSL do banco não confiável', SELF_SIGNED_CERT_IN_CHAIN: 'certificado SSL do banco não confiável',
  };
  if (known[code]) return `${known[code]} [${code}]`;
  if (/ssl/i.test(String(error?.message || ''))) return 'problema de SSL na conexão com o banco';
  return code ? `erro do banco [${code}]` : '';
}

function dashboardToGiveawayTemplate(config) {
  const durationMap = { '1h': 60, '6h': 360, '12h': 720, '24h': 1440, '3d': 4320, '7d': 10080 };
  const durationMinutes = durationMap[config.giveawayDuration] || 1440;
  const customEnd = config.giveawayDuration === 'custom' && config.giveawayEndDate ? localToDate(config.giveawayEndDate) : null;
  const blocks = Array.isArray(config.giveawayMessageBlocks) && config.giveawayMessageBlocks.length
    ? config.giveawayMessageBlocks
    : [{ type: 'text', content: String(config.giveawayMessage || '').slice(0, 1500) }];
  return giveawayCore.normalizeConfig({
    name: config.giveawayName,
    minParticipants: Number(config.giveawayMin) || 0,
    maxParticipants: Number(config.giveawayMax) || 0,
    winnerCount: Number(config.giveawayWinners) || 1,
    end: customEnd && !Number.isNaN(customEnd.getTime()) ? { mode: 'date', at: customEnd.toISOString() } : { mode: 'duration', durationMinutes },
    allowedRoleIds: onlySnowflakes(config.giveawayAllowedRoles, 'Cargos permitidos'),
    blockedRoleIds: onlySnowflakes(config.giveawayBlockedRoles, 'Cargos bloqueados'),
    allowedUserIds: onlySnowflakes(config.giveawayAllowedMembers, 'Membros permitidos'),
    blockedUserIds: onlySnowflakes(config.giveawayBlockedMembers, 'Membros bloqueados'),
    rulesScope: config.giveawayRulesScope || 'local',
    cooldown: { giveaways: config.giveawayCooldownType === 'giveaways' ? Number(config.giveawayCooldownAmount) || 0 : 0, days: config.giveawayCooldownType === 'days' ? Number(config.giveawayCooldownAmount) || 0 : 0 },
    schedule: { enabled: config.giveawayStart === 'scheduled', startsAt: config.giveawayStart === 'scheduled' && config.giveawayScheduledAt ? localToDate(config.giveawayScheduledAt).toISOString() : null },
    channelId: onlySnowflakes(config.giveawayChannel, 'Canal do sorteio')[0] || null,
    pin: Boolean(config.giveawayPin),
    privateThread: { enabled: Boolean(config.giveawayPrivateThread), message: String(config.giveawayPrivateMessage || '').slice(0, 1800) },
    message: { accentColor: /^#[0-9a-f]{6}$/i.test(config.giveawayColor || '') ? Number.parseInt(config.giveawayColor.slice(1), 16) : null, blocks },
  });
}

function templateToDashboard(template, current) {
  const c = template || {};
  const end = c.end || {};
  const duration = Number(end.durationMinutes || 1440);
  const durationName = ({60:'1h',360:'6h',720:'12h',1440:'24h',4320:'3d',10080:'7d'})[duration] || '24h';
  const cooldown = c.cooldown || {};
  const blockText = (c.message?.blocks || []).filter((b) => b.type === 'text').map((b) => b.content).join('\n');
  return { ...current,
    giveawayName: c.name || current.giveawayName,
    giveawayMin: c.minParticipants ?? current.giveawayMin,
    giveawayMax: c.maxParticipants ?? current.giveawayMax,
    giveawayWinners: c.winnerCount ?? current.giveawayWinners,
    giveawayDuration: end.mode === 'date' ? 'custom' : durationName,
    giveawayEndDate: end.at ? dateToLocal(end.at) : '',
    giveawayAllowedRoles: (c.allowedRoleIds || []).join(', '), giveawayBlockedRoles: (c.blockedRoleIds || []).join(', '),
    giveawayAllowedMembers: (c.allowedUserIds || []).join(', '), giveawayBlockedMembers: (c.blockedUserIds || []).join(', '),
    giveawayCooldownType: cooldown.giveaways ? 'giveaways' : cooldown.days ? 'days' : 'none',
    giveawayCooldownAmount: cooldown.giveaways || cooldown.days || 1,
    giveawayRulesScope: c.rulesScope || 'local', giveawayStart: c.schedule?.enabled ? 'scheduled' : 'immediate',
    giveawayScheduledAt: c.schedule?.startsAt ? dateToLocal(c.schedule.startsAt) : '',
    giveawayChannel: c.channelId || '', giveawayPin: Boolean(c.pin),
    giveawayPrivateThread: Boolean(c.privateThread?.enabled), giveawayPrivateMessage: c.privateThread?.message || current.giveawayPrivateMessage,
    giveawayColor: c.message?.accentColor == null ? '#f6bd4b' : `#${Number(c.message.accentColor).toString(16).padStart(6,'0')}`,
    giveawayMessage: blockText || current.giveawayMessage,
    giveawayMessageBlocks: c.message?.blocks || [],
  };
}


// Dashboard administrativa: leitura e gravação por servidor, com autorização de administrador.
app.get('/api/dashboard', noStore, authorizeDashboard, async (req, res) => {
  try {
    if (!db.isEnabled()) return res.status(503).json({ error: 'DATABASE_URL não está configurada.' });
    await db.getPool().query(DASHBOARD_SCHEMA);
    await giveawayStore.ensureSchema();
    const { guildId } = req.dashboardContext;
    const [config, templates, mm] = await Promise.all([
      loadDashboardConfig(guildId),
      giveawayStore.listTemplates(guildId, 50),
      mmStore.getSettings(guildId),
    ]);
    config.centralChannel = config.centralChannel || mm.centralChannelId || '';
    config.matchModes = config.matchModes || (mm.modes || []).map((m) => m.name).join(', ') || 'Clássico, Ranqueada, Casual';
    return res.json({ config, templates, giveawayMessageV2: true });
  } catch (error) {
    console.error('[Activity] Dashboard load error:', error.code || '', error.message);
    const hint = dbHint(error);
    return res.status(500).json({ error: `Não foi possível carregar as configurações da Dashboard.${hint ? ` Banco: ${hint}.` : ''}` });
  }
});

app.put('/api/dashboard', noStore, authorizeDashboard, async (req, res) => {
  try {
    if (!db.isEnabled()) return res.status(503).json({ error: 'DATABASE_URL não está configurada.' });
    const { guildId, userId } = req.dashboardContext;
    const config = req.body?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return res.status(400).json({ error: 'Configuração inválida.' });
    if (!/^\d{2}:\d{2}$/.test(String(config.weekStartTime || '')) || !/^\d{2}:\d{2}$/.test(String(config.nightStart || '')) || !/^\d{2}:\d{2}$/.test(String(config.nightEnd || ''))) return res.status(400).json({ error: 'Horários devem usar o formato HH:MM.' });
    const moderation = onlySnowflakes(config.moderationChannel, 'Canal de moderação')[0] || null;
    const publication = onlySnowflakes(config.publicationChannel, 'Canal de publicação')[0] || null;
    const starRole = onlySnowflakes(config.starRole, 'Cargo Estrela da Semana')[0] || null;
    const adminRoles = onlySnowflakes(config.matchAdminRoles, 'Cargos administradores de partidas');
    const nightCategories = onlySnowflakes(config.nightCategories, 'Categorias afetadas');
    const nightAffected = onlySnowflakes(config.nightAffectedChannels, 'Canais afetados');
    const nightImmune = onlySnowflakes(config.nightImmuneChannels, 'Canais imunes');
    const nightNotices = onlySnowflakes(config.nightNoticeChannels, 'Canais de comunicados');
    const seasonalPackages = { halloween: config.seasonal?.halloween !== false, natal: config.seasonal?.christmas !== false, ano_novo: config.seasonal?.newYear !== false };
    const current = minakoConfig.normalize(await db.loadConfig(guildId));
    const day = dayToNumber(config.weekStartDay);
    await db.saveConfig(guildId, {
      ...current, timezone: String(config.timezone || current.timezone), weekStartDay: day,
      weekStartTime: String(config.weekStartTime), moderationChannelId: moderation, publicationChannelId: publication,
      starRoleId: starRole, partidaAdminRoleIds: adminRoles,
      nightModeEnabled: Boolean(config.nightEnabled), nightModeStartTime: String(config.nightStart), nightModeEndTime: String(config.nightEnd),
      nightModeCategoryIds: nightCategories, nightModeAffectedChannelIds: nightAffected,
      nightModeImmuneChannelIds: nightImmune, nightModeNoticeChannelIds: nightNotices,
      nightModeNoticeUrl: String(config.nightNoticeUrl || '').trim() || null, seasonalPackages,
    });
    await mmStore.saveSettingsPatch(guildId, { centralChannelId: onlySnowflakes(config.centralChannel, 'Canal da Central de Matchmaking')[0] || null });
    await db.getPool().query(`INSERT INTO minako_activity_dashboard_settings (guild_id, config, updated_by, updated_at)
      VALUES ($1,$2::jsonb,$3,now()) ON CONFLICT (guild_id) DO UPDATE SET config=EXCLUDED.config, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [guildId, JSON.stringify(config), userId]);
    return res.json({ ok: true, savedAt: new Date().toISOString(), config: await loadDashboardConfig(guildId) });
  } catch (error) {
    const badInput = /use IDs numéricos|Horários devem/.test(error.message || '');
    return res.status(badInput ? 400 : 500).json({ error: error.message || 'Não foi possível salvar as configurações.' });
  }
});

app.post('/api/dashboard/templates', noStore, authorizeDashboard, async (req, res) => {
  try {
    if (!db.isEnabled()) return res.status(503).json({ error: 'DATABASE_URL não está configurada.' });
    await giveawayStore.ensureSchema();
    const { guildId, userId } = req.dashboardContext;
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 80) return res.status(400).json({ error: 'O nome do template deve ter entre 1 e 80 caracteres.' });
    const config = dashboardToGiveawayTemplate(req.body?.config || {});
    await giveawayStore.saveTemplate(guildId, name, config, userId);
    return res.status(201).json({ ok: true, templates: await giveawayStore.listTemplates(guildId, 50) });
  } catch (error) {
    const status = error.code === 'TEMPLATE_TAKEN' ? 409 : /use IDs numéricos/.test(error.message || '') ? 400 : 500;
    return res.status(status).json({ error: error.message || 'Não foi possível salvar o template.' });
  }
});

app.get('/api/dashboard/templates/:id', noStore, authorizeDashboard, async (req, res) => {
  try {
    await giveawayStore.ensureSchema();
    const template = await giveawayStore.getTemplate(req.dashboardContext.guildId, req.params.id);
    if (!template) return res.status(404).json({ error: 'Template não encontrado neste servidor.' });
    const current = await loadDashboardConfig(req.dashboardContext.guildId);
    return res.json({ template: { id: template.id, name: template.name }, config: templateToDashboard(template.config, current) });
  } catch (error) { return res.status(500).json({ error: 'Não foi possível carregar o template.' }); }
});

app.delete('/api/dashboard/templates/:id', noStore, authorizeDashboard, async (req, res) => {
  try {
    await giveawayStore.ensureSchema();
    const template = await giveawayStore.getTemplate(req.dashboardContext.guildId, req.params.id);
    if (!template) return res.status(404).json({ error: 'Template não encontrado neste servidor.' });
    const deleted = await giveawayStore.deleteTemplate(req.dashboardContext.guildId, template.name);
    return res.json({ ok: deleted, templates: await giveawayStore.listTemplates(req.dashboardContext.guildId, 50) });
  } catch (error) { return res.status(500).json({ error: 'Não foi possível excluir o template.' }); }
});

// ===== Sorteios: criar/agendar pelo site. O bot publica (agendador a cada 15 s) com as mesmas regras do /sorteios. =====
const GIVEAWAY_LIVE = ['scheduled', 'starting', 'active', 'drawn'];
async function listLiveGiveaways(guildId) {
  const { rows } = await db.getPool().query(
    `SELECT id, name, status, channel_id, starts_at, ends_at FROM minako_giveaways WHERE guild_id=$1 AND status = ANY($2) ORDER BY id DESC LIMIT 20`,
    [guildId, GIVEAWAY_LIVE]);
  return rows.map((r) => ({ id: String(r.id), name: r.name, status: r.status, channelId: r.channel_id, startsAt: r.starts_at, endsAt: r.ends_at }));
}

app.get('/api/dashboard/giveaways', noStore, authorizeDashboard, async (req, res) => {
  try {
    if (!db.isEnabled()) return res.status(503).json({ error: 'DATABASE_URL não está configurada.' });
    await giveawayStore.ensureSchema();
    return res.json({ giveaways: await listLiveGiveaways(req.dashboardContext.guildId) });
  } catch (error) {
    console.error('[Activity] giveaways list:', error.message);
    return res.status(500).json({ error: 'Não foi possível listar os sorteios.' });
  }
});

app.post('/api/dashboard/giveaways', noStore, authorizeDashboard, async (req, res) => {
  try {
    if (!db.isEnabled()) return res.status(503).json({ error: 'DATABASE_URL não está configurada.' });
    if (!process.env.MINAKO_TOKEN) return res.status(503).json({ error: 'MINAKO_TOKEN não está configurado no ambiente do site.' });
    await giveawayStore.ensureSchema();
    const { guildId, userId } = req.dashboardContext;
    const cfg = dashboardToGiveawayTemplate(req.body?.config || {});
    const errors = giveawayCore.validateConfig(cfg);
    if (errors.length) return res.status(400).json({ error: `Pendências: ${errors.join(' · ')}` });
    const channelResponse = await fetch(`https://discord.com/api/v10/channels/${cfg.channelId}`, { headers: { Authorization: `Bot ${process.env.MINAKO_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    const channel = channelResponse.ok ? await channelResponse.json() : null;
    if (!channel || channel.guild_id !== guildId || ![0, 5, 10, 11, 12].includes(channel.type)) {
      return res.status(400).json({ error: 'O canal escolhido não está disponível ou não aceita mensagens (fóruns e categorias não servem).' });
    }
    const scheduled = Boolean(cfg.schedule.enabled);
    const row = await giveawayStore.insertGiveaway({
      guildId, hostId: userId, config: cfg, status: 'scheduled',
      startsAt: scheduled ? new Date(cfg.schedule.startsAt) : new Date(),
      endsAt: scheduled && cfg.end.mode === 'date' ? new Date(cfg.end.at) : null,
    });
    return res.status(201).json({
      ok: true, id: String(row.id), scheduled,
      message: scheduled ? 'Sorteio agendado. O bot publica no horário definido.' : 'Sorteio enviado ao bot. Ele será publicado no canal em até 15 segundos.',
    });
  } catch (error) {
    if (error.code === 'NAME_TAKEN') return res.status(409).json({ error: 'Já existe um sorteio ativo com esse nome. Escolha outro.' });
    console.error('[Activity] giveaway create:', error.message);
    return res.status(500).json({ error: error.message || 'Não foi possível criar o sorteio.' });
  }
});

// Só cancela sorteios ainda não publicados; os ativos continuam sendo encerrados/cancelados pelo /sorteios no Discord.
app.post('/api/dashboard/giveaways/:id/cancel', noStore, authorizeDashboard, async (req, res) => {
  try {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'ID inválido.' });
    const result = await giveawayStore.cancelTx(req.dashboardContext.guildId, req.params.id, 'Cancelado pela Dashboard', ['scheduled']);
    if (result.kind === 'cancelled') return res.json({ ok: true });
    return res.status(409).json({ error: result.kind === 'missing' ? 'Sorteio não encontrado.' : 'Só dá para cancelar sorteios ainda não publicados. Use /sorteios cancelar no Discord.' });
  } catch (error) {
    console.error('[Activity] giveaway cancel:', error.message);
    return res.status(500).json({ error: 'Não foi possível cancelar o sorteio.' });
  }
});

// Busca de membros por nome/apelido (q) ou resolução de nomes por ID (ids). Requer o intent GuildMembers do bot.
app.get('/api/dashboard/members', noStore, authorizeDashboard, async (req, res) => {
  try {
    const botToken = process.env.MINAKO_TOKEN;
    if (!botToken) return res.status(503).json({ error: 'MINAKO_TOKEN não está configurado no ambiente do site.' });
    const { guildId } = req.dashboardContext;
    const base = `https://discord.com/api/v10/guilds/${guildId}/members`;
    const headers = { Authorization: `Bot ${botToken}` };
    const fmt = (m) => ({ id: m.user.id, name: m.nick || m.user.global_name || m.user.username, username: m.user.username });
    const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 25);
    if (ids.length) {
      if (ids.some((id) => !/^\d{15,22}$/.test(id))) return res.status(400).json({ error: 'IDs inválidos.' });
      const found = await Promise.all(ids.map(async (id) => {
        const r = await fetch(`${base}/${id}`, { headers, signal: AbortSignal.timeout(10000) });
        return r.ok ? fmt(await r.json()) : null;
      }));
      return res.json({ members: found.filter(Boolean) });
    }
    const q = String(req.query.q || '').trim().slice(0, 32);
    if (q.length < 2) return res.json({ members: [] });
    const r = await fetch(`${base}/search?query=${encodeURIComponent(q)}&limit=10`, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(502).json({ error: 'Não foi possível buscar membros agora.' });
    return res.json({ members: (await r.json()).filter((m) => m.user && !m.user.bot).map(fmt) });
  } catch (error) {
    console.error('[Activity] members:', error.message);
    return res.status(502).json({ error: 'Não foi possível buscar membros agora.' });
  }
});

// Canais, categorias e cargos do servidor (via bot) para os seletores da Dashboard. Cache de 60 s por servidor.
const guildDataCache = new Map();
app.get('/api/dashboard/guild-data', noStore, authorizeDashboard, async (req, res) => {
  try {
    const botToken = process.env.MINAKO_TOKEN;
    if (!botToken) return res.status(503).json({ error: 'MINAKO_TOKEN não está configurado no ambiente do site.' });
    const { guildId } = req.dashboardContext;
    const hit = guildDataCache.get(guildId);
    if (hit && Date.now() - hit.at < 60000) return res.json(hit.data);
    const get = async (part) => {
      const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/${part}`, { headers: { Authorization: `Bot ${botToken}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`${part}: HTTP ${response.status}`);
      return response.json();
    };
    const [channels, roles, active] = await Promise.all([get('channels'), get('roles'), get('threads/active').catch(() => ({ threads: [] }))]);
    const data = {
      channels: channels.filter((c) => [0, 2, 4, 5, 13, 15].includes(c.type))
        .map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id || null, position: c.position || 0 }))
        .sort((a, b) => a.position - b.position),
      roles: roles.filter((r) => r.id !== guildId)
        .map((r) => ({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null, position: r.position, managed: Boolean(r.managed) }))
        .sort((a, b) => b.position - a.position),
      threads: (active.threads || []).filter((t) => [10, 11, 12].includes(t.type))
        .map((t) => ({ id: t.id, name: t.name, parentId: t.parent_id || null }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    };
    guildDataCache.set(guildId, { at: Date.now(), data });
    return res.json(data);
  } catch (error) {
    console.error('[Activity] guild-data:', error.message);
    return res.status(502).json({ error: `Não foi possível carregar canais e cargos do servidor (${error.message}).` });
  }
});

// Dados reais: somente para um servidor em que o usuário autenticado seja membro.
app.get('/api/central', noStore, async (req, res) => {
  try {
    const authHeader = req.get('authorization') || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const accessToken = (await resolveAuth(req)).token || match?.[1];
    const guildId = typeof req.query.guildId === 'string' ? req.query.guildId : '';
    if (!accessToken) return res.status(401).json({ error: 'Autentique-se com o Discord para consultar a Central.' });
    if (!/^\d{17,20}$/.test(guildId)) return res.status(400).json({ error: 'Abra a Activity em um servidor do Discord para consultar a Central.' });

    const user = await getDiscordUser(accessToken);
    if (!user?.id) return res.status(401).json({ error: 'Sessão Discord inválida ou expirada. Conecte-se novamente.' });
    const member = await isGuildMember(accessToken, guildId);
    if (!member) return res.status(403).json({ error: 'Não foi possível confirmar sua participação neste servidor. Verifique se autorizou o escopo de servidores e tente novamente.' });
    if (!db.isEnabled()) return res.status(503).json({ error: 'DATABASE_URL não está configurada no ambiente da Activity.' });

    const [data, cfg] = await Promise.all([
      mmStore.getCentralData(guildId),
      mmStore.getSettings(guildId),
    ]);
    const vm = centralView.buildView(data, cfg.modes);
    // Não expõe IDs de usuários nem nomes a partir do feed de eventos. A interface recebe apenas
    // eventos genéricos e dados agregados da Central pública.
    const recent = (data.recentEvents || []).map((event) => {
      const labels = {
        'group.created': 'Um grupo foi aberto',
        'group.joined': 'Uma pessoa entrou em um grupo',
        'proposal.confirmed': 'Uma equipe foi formada',
        'group.completed': 'Uma partida foi registrada',
      };
      const text = labels[event.type];
      return text ? { text, at: event.at } : null;
    }).filter(Boolean).slice(0, 5);

    return res.json({
      mode: 'live',
      guildId,
      viewer: { id: user.id, username: user.global_name || user.username },
      updatedAt: Date.now(),
      availableNow: vm.availableNow,
      openGroups: vm.groups.map((group) => ({ id: String(group.id), mode: group.mode, free: group.free, capacity: group.capacity, confirmed: group.confirmed })),
      freeSlots: vm.freeSlots,
      pendingProposals: vm.pendingProposals,
      matchesToday: vm.matchesToday,
      weekly: vm.weekly,
      recent,
    });
  } catch (error) {
    console.error('[Activity] Central API error:', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar os dados do matchmaking agora.' });
  }
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(__dirname, 'dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

let distStale = false;
async function start() {
  try {
    const { statSync } = await import('node:fs');
    distStale = statSync(path.resolve(__dirname, 'src/App.jsx')).mtimeMs > statSync(path.resolve(__dirname, 'dist/index.html')).mtimeMs + 1000;
    if (distStale) console.warn('[Activity] ATENÇÃO: activity/dist é mais antigo que activity/src. Rode "npm --prefix activity run build"; sem isso o site continua mostrando a interface antiga.');
  } catch { /* sem dist/src: ignora */ }
  if (process.env.DATABASE_URL) {
    try {
      // Idempotente: utiliza as migrações existentes do módulo de matchmaking.
      await db.initSchema();
      const applied = await mmSchema.migrate();
      await db.getPool().query(DASHBOARD_SCHEMA);
      await giveawayStore.ensureSchema();
      await tiktokStore.ensureSchema();
      if (applied.length) console.log(`[Activity] Migrações do matchmaking aplicadas: ${applied.join(', ')}`);
    } catch (error) {
      console.error('[Activity] Banco configurado, mas a inicialização do schema falhou:', error.message);
      console.error('[Activity] A API ficará indisponível para dados reais até corrigir DATABASE_URL/schema.');
    }
  } else {
    console.warn('[Activity] DATABASE_URL não definida; a interface abrirá, mas dados reais não estarão disponíveis.');
  }
  app.listen(port, '0.0.0.0', () => console.log(`[Activity] API ouvindo na porta ${port}`));
}

start().catch((error) => {
  console.error('[Activity] Falha ao iniciar:', error);
  process.exitCode = 1;
});

async function shutdown() {
  try { await db.closePool(); } catch (error) { console.error('[Activity] Falha ao fechar PostgreSQL:', error.message); }
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
