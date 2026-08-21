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
  assert.ok(problems.some((p) => /SIGNUP_CODE|APP_USERS/.test(p)), 'debe pedir como controlar el acceso');
});

test('sin base de datos en serverless funciona, pero avisa que es temporal', () => {
  assert.strictEqual(config.ephemeralStorage, true);
  assert.strictEqual(config.dbFile, '/tmp/botxtar.db',
    'en serverless solo se puede escribir en /tmp; fuera de ahi la peticion falla');
  assert.ok(!config.productionProblems().some((p) => /POSTGRES_URL/.test(p)),
    'falta de base no bloquea el arranque: se avisa en pantalla');
});

test('la API responde con la lista de lo que falta', async () => {
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/catalog`, {
      headers: { accept: 'application/json' },
    });
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.strictEqual(body.error, 'Configuracion incompleta');
    assert.ok(Array.isArray(body.problemas) && body.problemas.length >= 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('un navegador recibe una pantalla que explica que configurar', async () => {
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    assert.strictEqual(res.status, 503);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /Falta configurar BOTXTAR/);
    assert.match(html, /SESSION_SECRET/);
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
