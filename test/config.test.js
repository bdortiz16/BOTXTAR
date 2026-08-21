'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Este archivo corre en su propio proceso, asi que puede simular produccion
// sin afectar al resto de la suite.
process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
delete process.env.SESSION_SECRET;
delete process.env.APP_USERS;
delete process.env.ADMIN_PASSWORD;
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL;

const config = require('../src/config');

test('en produccion avisa de lo que falta antes de atender peticiones', () => {
  const problems = config.productionProblems();
  assert.ok(problems.some((p) => /SESSION_SECRET/.test(p)), 'debe pedir SESSION_SECRET');
  assert.ok(problems.some((p) => /APP_USERS/.test(p)), 'debe pedir usuarios');
  assert.ok(problems.some((p) => /POSTGRES_URL/.test(p)), 'debe pedir Postgres en serverless');
});

test('el servidor responde 500 explicando la configuracion incompleta', async () => {
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/catalog`);
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.error, 'Configuracion incompleta');
    assert.ok(Array.isArray(body.problemas) && body.problemas.length >= 3);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('en desarrollo no bloquea nada', () => {
  const original = config.env;
  config.env = 'development';
  assert.deepStrictEqual(config.productionProblems(), []);
  config.env = original;
});
