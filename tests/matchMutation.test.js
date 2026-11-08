'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const testFile = path.join(__dirname, '..', 'data', 'matches.json');
const backup = fs.existsSync(testFile) ? fs.readFileSync(testFile, 'utf8') : null;
// O módulo DB importa pg na carga; o teste de fila não precisa de conexão real.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'pg') return { Pool: class Pool {} };
  return originalLoad.call(this, request, parent, isMain);
};
// Sem DATABASE_URL o matchStore usa só o snapshot local (JSON) e não tenta
// gravar no PostgreSQL. O ambiente da aplicação define DATABASE_URL, então o
// mock de pg acima (sem connect/on reais) fazia o saveMatches cair no caminho
// do banco e logar "pool.on/connect is not a function" — erro cosmético, mas
// poluía o console do npm test.
delete process.env.DATABASE_URL;
const store = require('../utils/matchStore');
Module._load = originalLoad;
(async () => {
  try {
    // Use the store's normal local snapshot path without requiring PostgreSQL.
    await store.saveMatches([{ name: 'Concurrent test', players: {} }]);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.mutateMatches(async (matches) => {
      await new Promise(resolve => setTimeout(resolve, i % 3));
      const match = matches.find(m => m.name === 'Concurrent test');
      match.players[`u${i}`] = { username: `u${i}` };
    })));
    const result = store.getMatches().find(m => m.name === 'Concurrent test');
    assert.equal(Object.keys(result.players).length, 10, 'all serialized mutations should survive');
    console.log('matchMutation.test.js: concorrência serializada OK');
  } finally {
    if (backup !== null) fs.writeFileSync(testFile, backup, 'utf8');
    else if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
