const db = require('../db');

let cached = null;
let cachedAt = 0;
const CACHE_TTL_MS = 15000;

const HERO_ROUTES = new Set([
  'Rota Superior',
  'Selva',
  'Rota do Meio',
  'Apoio',
  'Rota Inferior',
]);

function normalizeHero(hero) {
  if (!hero || typeof hero !== 'object') return null;
  const id = String(hero.id || '').trim();
  const name = String(hero.name || '').trim();
  if (!id || !name || hero.active === false) return null;
  return {
    id,
    name,
    aliases: Array.isArray(hero.aliases) ? hero.aliases.map(v => String(v).trim()).filter(Boolean) : [],
    routes: Array.isArray(hero.routes)
      ? [...new Set(hero.routes.map(v => String(v).trim()).filter(v => HERO_ROUTES.has(v)))].slice(0, 5)
      : [],
  };
}

async function getHeroCatalog({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const rows = await db.loadSharedHeroCatalog();
  const catalog = (Array.isArray(rows) ? rows : []).map(normalizeHero).filter(Boolean);
  catalog.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  cached = catalog;
  cachedAt = Date.now();
  return catalog;
}

function resolveHeroIds(values, catalog) {
  const byId = new Map(catalog.map(hero => [hero.id, hero]));
  const byName = new Map();
  for (const hero of catalog) {
    byName.set(hero.name.toLocaleLowerCase('pt-BR'), hero);
    for (const alias of hero.aliases) byName.set(alias.toLocaleLowerCase('pt-BR'), hero);
  }

  const ids = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const key = String(raw || '').trim();
    const hero = byId.get(key) || byName.get(key.toLocaleLowerCase('pt-BR'));
    if (hero && !ids.includes(hero.id)) ids.push(hero.id);
  }
  return ids;
}

function namesForIds(ids, catalog) {
  const byId = new Map(catalog.map(hero => [hero.id, hero]));
  return (Array.isArray(ids) ? ids : []).map(id => byId.get(id)?.name).filter(Boolean);
}

module.exports = { getHeroCatalog, resolveHeroIds, namesForIds };
