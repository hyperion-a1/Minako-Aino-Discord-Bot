#!/usr/bin/env node
'use strict';
// Remove TODAS as tabelas minako_mm_* (reversão total do módulo). Não toca em mais nada.
// FAÇA O BACKUP ANTES (/minako-matchmaking backup). Uso:  node scripts/mm-rollback.js APAGAR-MATCHMAKING
require('dotenv').config();
const db = require('../utils/db');
const schema = require('../utils/matchmaking/schema');
schema.rollback(process.argv[2]).then(() => console.log('Tabelas minako_mm_* removidas.'))
  .catch(e => { console.error('Falha:', e.message); process.exitCode = 1; }).finally(() => db.closePool?.());
