'use strict';

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { createSerialQueue } = require('./serialQueue');

const FILE = path.join(__dirname, '..', 'data', 'matches.json');
let cache = null;
const enqueueDbWrite = createSerialQueue();
// Serializa operações completas de leitura-modificação-gravação nesta instância.
const enqueueMutation = createSerialQueue();

async function initFromDb() {
  if (!db.isEnabled()) return;
  try {
    const value = await db.loadMatches();
    if (Array.isArray(value)) {
      cache = value;
    }
  } catch (error) {
    console.error('[matchStore] Falha ao carregar partidas do PostgreSQL — usando JSON:', error.message);
  }
}

function ensureFile() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]\n', 'utf8');
}

function writeLocalSnapshot(matches) {
  ensureFile();
  const tempFile = `${FILE}.tmp`;
  const contents = `${JSON.stringify(matches, null, 2)}\n`;
  // Atomic rename avoids leaving a truncated JSON file if the process exits
  // during a write. The temporary file is in the same directory/filesystem.
  fs.writeFileSync(tempFile, contents, 'utf8');
  fs.renameSync(tempFile, FILE);
}

function getMatches() {
  if (cache) return cache;
  ensureFile();
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  cache = Array.isArray(parsed) ? parsed : [];
  return cache;
}

function saveMatches(matches) {
  const snapshot = JSON.parse(JSON.stringify(Array.isArray(matches) ? matches : []));
  cache = snapshot;
  writeLocalSnapshot(snapshot);

  if (!db.isEnabled()) return Promise.resolve({ persisted: false, backend: 'json' });

  // Capture an immutable snapshot and serialize PostgreSQL writes. Without
  // this queue, a slower older write could finish after a newer one and
  // overwrite the latest match state in the database.
  return enqueueDbWrite(() => db.saveMatches(snapshot))
    .then(() => ({ persisted: true, backend: 'postgres' }))
    .catch((error) => {
      console.error('[matchStore] Erro ao gravar partidas no PostgreSQL:', error.message);
      return { persisted: false, backend: 'postgres', error };
    });
}

function mutateMatches(mutator) {
  if (typeof mutator !== 'function') return Promise.reject(new TypeError('mutator precisa ser uma função.'));
  return enqueueMutation(async () => {
    // Clone defensivo: nenhum chamador altera o cache antes de a mutação ser confirmada.
    const draft = JSON.parse(JSON.stringify(getMatches()));
    const result = await mutator(draft);
    await saveMatches(draft);
    return { matches: draft, result };
  });
}

function flushPendingWrites() {
  return Promise.all([enqueueDbWrite.flush(), enqueueMutation.flush()]);
}


function findMatch(matches, name) {
  return matches.find((m) => m.name.toLowerCase() === name.toLowerCase());
}

function findMatchByMessageId(matches, messageId) {
  return matches.find((m) => m.messageId === messageId);
}

module.exports = {
  findMatch,
  findMatchByMessageId,
  flushPendingWrites,
  getMatches,
  initFromDb,
  mutateMatches,
  saveMatches,
};
