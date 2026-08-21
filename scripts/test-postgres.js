'use strict';

/**
 * Corre la suite contra un Postgres de verdad, un archivo de prueba por base
 * para que no se pisen entre si.
 *
 *   PGTEST_URL=postgres://usuario@host:5432 npm run test:pg
 *
 * La URL no lleva nombre de base: el script crea y borra una por archivo.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const baseUrl = (process.env.PGTEST_URL || 'postgres://postgres@127.0.0.1:5432').replace(/\/$/, '');
const FILES = ['operations', 'telegram', 'users', 'banks', 'api'];

function psql(dbUrl, sql) {
  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' });
}

let failed = 0;
for (const name of FILES) {
  const dbName = `botxtar_test_${name}`;
  psql(`${baseUrl}/postgres`, `DROP DATABASE IF EXISTS ${dbName}`);
  psql(`${baseUrl}/postgres`, `CREATE DATABASE ${dbName}`);
  console.log(`\n=== ${name} contra Postgres ===`);
  try {
    execFileSync(process.execPath, ['--test', path.join('test', `${name}.test.js`)], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: `${baseUrl}/${dbName}` },
    });
  } catch {
    failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} archivo(s) con fallos contra Postgres`);
  process.exit(1);
}
console.log('\nTodo verde contra Postgres');
