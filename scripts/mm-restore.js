#!/usr/bin/env node
'use strict';
// Restaura o matchmaking de UM servidor a partir de um backup gerado por /minako-matchmaking backup.
// Uso (simulação, padrão):  node scripts/mm-restore.js --file backup.json --guild 123456789012345678
// Uso (aplica de verdade):  node scripts/mm-restore.js --file backup.json --guild 123456789012345678 --confirm
// Substitui APENAS as linhas minako_mm_* daquele servidor, dentro de uma transação (tudo ou nada).
require('dotenv').config();
const fs = require('node:fs');
const db = require('../utils/db');
const schema = require('../utils/matchmaking/schema');
const { buildRestorePlan } = require('../utils/matchmaking/backupFormat');

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
(async () => {
  const file = arg('file'); const guild = arg('guild'); const confirm = process.argv.includes('--confirm');
  if (!file || !guild) throw new Error('Informe --file e --guild.');
  const plan = buildRestorePlan(JSON.parse(fs.readFileSync(file, 'utf8')), guild);
  console.log('Linhas no backup:', plan.counts);
  if (!confirm) { console.log('SIMULAÇÃO: nada foi alterado. Rode de novo com --confirm para aplicar.'); return; }
  await schema.migrate(); // garante que as tabelas existem
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    for (const s of plan.steps) await client.query(s.sql, s.params);
    await client.query('COMMIT'); console.log('Restauração concluída.');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
})().catch(e => { console.error('Falha:', e.message); process.exitCode = 1; }).finally(() => db.closePool?.());
