'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Simula un despliegue en Vercel sin nada configurado: ni base, ni clave de
// sesion, ni forma de controlar el registro. La app tiene que funcionar igual.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-conf-'));
process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.DB_FILE = path.join(tmp, 'conf.db');
delete process.env.SESSION_SECRET;
delete process.env.APP_USERS;
delete process.env.ADMIN_PASSWORD;
delete process.env.SIGNUP_CODE;
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL;
delete process.env.TELEGRAM_BOT_TOKEN;

const config = require('../src/config');
const { init } = require('../src/db');
const { ensureSecret } = require('../src/secret');

// El servidor crea el esquema antes de resolver la clave de sesion; aqui se
// hace lo mismo para probar las piezas por separado.
test.before(async () => { await init(); });

test('en serverless la base va a /tmp, que es lo unico que se puede escribir', () => {
  // Se comprueba en otro proceso: tocar la cache de modulos aqui dejaria al
  // resto del archivo apuntando a otra base.
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env, VERCEL: '1' };
  delete env.DB_FILE;
  const salida = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(require('./src/config').dbFile)"],
    { env, cwd: path.join(__dirname, '..'), encoding: 'utf8' }
  );
  assert.strictEqual(salida.trim(), '/tmp/botxtar.db');
});

test('sin configurar nada, la app avisa pero no se bloquea', () => {
  const avisos = config.warnings();
  const codigos = avisos.map((w) => w.code);
  assert.ok(codigos.includes('SIN_BASE'), 'avisa que los datos se borran');
  assert.ok(codigos.includes('REGISTRO_ABIERTO'), 'avisa que el registro esta abierto');
  assert.ok(codigos.includes('SIN_TELEGRAM'), 'avisa que no enviara nada');
  for (const w of avisos) assert.ok(w.text.length > 30, 'cada aviso dice que hacer');
});

test('la clave de sesion se genera sola y se reutiliza', async () => {
  const primera = await ensureSecret();
  assert.ok(primera.length >= 32, 'una clave corta no sirve para firmar');

  // Otra instancia, misma base: tiene que resolver la misma clave, o las
  // sesiones se cerrarian al azar segun a que instancia caiga cada peticion.
  const { reset, ensureSecret: again } = require('../src/secret');
  reset();
  assert.strictEqual(await again(), primera);
});

test('la app entera responde sin ninguna variable configurada', async () => {
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(base + '/health')).json();
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.ephemeral, true);

    // Se puede crear la primera cuenta y entrar, sin configurar nada.
    const reg = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'bryan@gmail.com', password: 'clave-de-prueba' }),
    });
    assert.strictEqual(reg.status, 201);
    const cookie = reg.headers.get('set-cookie').split(';')[0];

    const cat = await (await fetch(base + '/api/catalog', { headers: { cookie } })).json();
    assert.strictEqual(cat.countries.length, 8);
    assert.ok(cat.warnings.some((w) => w.code === 'SIN_BASE'),
      'la app muestra el aviso de que los datos se borran');

    // Y sin sesion sigue sin verse nada.
    const anon = await fetch(base + '/api/catalog');
    assert.strictEqual(anon.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('la sesion firmada sobrevive entre peticiones', async () => {
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'bryan@gmail.com', password: 'clave-de-prueba' }),
    });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const me = await (await fetch(base + '/api/auth/me', { headers: { cookie } })).json();
    assert.strictEqual(me.user, 'bryan@gmail.com');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('sin ninguna cuenta, el login no miente diciendo "clave incorrecta"', async () => {
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Se borran las cuentas para simular una instancia reciclada.
    const { db } = require('../src/db');
    await db.run('DELETE FROM users');

    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'bryandavidortiz51@gmail.com', password: 'la-que-sea' }),
    });
    assert.strictEqual(r.status, 401);
    const body = await r.json();
    assert.strictEqual(body.code, 'SIN_CUENTAS');
    assert.match(body.error, /No hay ninguna cuenta/i);
    assert.match(body.error, /se borran|base de datos/i,
      'debe explicar por que desaparecio la cuenta');
    assert.ok(!/clave incorrect/i.test(body.error),
      'no puede culpar a la clave cuando no hay con que compararla');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('el estado del registro avisa que el almacenamiento es temporal', async () => {
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup-state`);
    const data = await res.json();
    assert.strictEqual(data.storage_ephemeral, true);
    assert.strictEqual(data.first_account, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('con credenciales por variable, una clave mala si es una clave mala', async () => {
  const config = require('../src/config');
  config.users.set('respaldo', 'clave-de-respaldo');
  config.authEnabled = true;
  try {
    const app = require('../src/server');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const mala = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'respaldo', password: 'equivocada' }),
      });
      assert.strictEqual(mala.status, 401);
      assert.strictEqual((await mala.json()).code, undefined,
        'aqui si hay con que comparar: es un error de credenciales');

      const buena = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'respaldo', password: 'clave-de-respaldo' }),
      });
      assert.strictEqual(buena.status, 200,
        'las credenciales por variable sobreviven a que se borre la base');
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    config.users.delete('respaldo');
    config.authEnabled = false;
  }
});
