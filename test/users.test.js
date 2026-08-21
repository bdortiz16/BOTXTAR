'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-users-'));
process.env.DB_FILE = path.join(tmp, 'users.db');
delete process.env.APP_USERS;
delete process.env.ADMIN_PASSWORD;
process.env.SESSION_SECRET = 'prueba-users';

const { init } = require('../src/db');
const users = require('../src/users');
const auth = require('../src/auth');
const config = require('../src/config');

test.before(async () => { await init(); });

test('la clave se guarda cifrada, nunca en claro', async () => {
  const hash = await users.hashPassword('clave-secreta-123');
  assert.ok(hash.startsWith('scrypt$'));
  assert.ok(!hash.includes('clave-secreta-123'));
  assert.ok(await users.verifyPassword('clave-secreta-123', hash));
  assert.ok(!await users.verifyPassword('clave-secreta-124', hash));
});

test('dos usuarios con la misma clave dan hashes distintos', async () => {
  const a = await users.hashPassword('la-misma-clave');
  const b = await users.hashPassword('la-misma-clave');
  assert.notStrictEqual(a, b, 'cada uno lleva su propia sal');
  assert.ok(await users.verifyPassword('la-misma-clave', a));
  assert.ok(await users.verifyPassword('la-misma-clave', b));
});

test('un hash corrupto no deja entrar', async () => {
  for (const malo of ['', 'x', 'scrypt$1$2$3', 'md5$a$b$c$d$e']) {
    assert.strictEqual(await users.verifyPassword('lo-que-sea', malo), false);
  }
});

test('la primera cuenta se puede crear y queda de administrador', async () => {
  const permiso = await users.canRegister('');
  assert.strictEqual(permiso.ok, true);
  assert.strictEqual(permiso.role, 'OWNER');

  const creado = await users.create({
    username: 'BryanDavidOrtiz51@Gmail.com', password: 'clave-de-prueba',
    name: 'Bryan', role: permiso.role,
  });
  assert.strictEqual(creado.username, 'bryandavidortiz51@gmail.com', 'se normaliza a minusculas');
});

test('el usuario entra sin importar mayusculas ni espacios', async () => {
  const s = await auth.login('  BRYANDAVIDORTIZ51@GMAIL.COM  ', 'clave-de-prueba');
  assert.ok(s, 'deberia entrar');
  assert.strictEqual(s.user, 'bryandavidortiz51@gmail.com');
});

test('con la clave equivocada no entra', async () => {
  assert.strictEqual(await auth.login('bryandavidortiz51@gmail.com', 'otra'), null);
  assert.strictEqual(await auth.login('noexiste', 'clave-de-prueba'), null);
  assert.strictEqual(await auth.login('', ''), null);
});

test('no se puede repetir un usuario', async () => {
  await assert.rejects(
    () => users.create({ username: 'bryandavidortiz51@gmail.com', password: 'otra-clave-larga' }),
    /ya existe/
  );
});

test('rechaza usuarios y claves que no sirven', async () => {
  await assert.rejects(() => users.create({ username: 'ab', password: 'clave-larga-ok' }), /3 caracteres/);
  await assert.rejects(() => users.create({ username: 'con espacio', password: 'clave-larga' }), /espacios/);
  await assert.rejects(() => users.create({ username: 'valido', password: 'corta' }), /8 caracteres/);
});

test('con una cuenta creada, el registro queda cerrado sin codigo', async () => {
  const permiso = await users.canRegister('');
  assert.strictEqual(permiso.ok, false);
  assert.match(permiso.reason, /SIGNUP_CODE/);
});

test('con codigo de invitacion se puede crear mas cuentas', async () => {
  config.signupCode = 'CODIGO-DE-LA-EMPRESA';
  try {
    assert.strictEqual((await users.canRegister('mal')).ok, false);
    const permiso = await users.canRegister('CODIGO-DE-LA-EMPRESA');
    assert.strictEqual(permiso.ok, true);
    assert.strictEqual(permiso.role, 'OPERATOR', 'no hereda administrador');

    await users.create({ username: 'jose', password: 'clave-de-jose', role: permiso.role });
    assert.ok(await auth.login('jose', 'clave-de-jose'));
  } finally {
    config.signupCode = '';
  }
});

test('una cuenta desactivada deja de entrar', async () => {
  const { db } = require('../src/db');
  await db.run("UPDATE users SET active = 0 WHERE username = 'jose'");
  assert.strictEqual(await auth.login('jose', 'clave-de-jose'), null);
  await db.run("UPDATE users SET active = 1 WHERE username = 'jose'");
  assert.ok(await auth.login('jose', 'clave-de-jose'));
});

test('sin ALLOW_ANONYMOUS la API exige sesion aunque no haya APP_USERS', async () => {
  assert.strictEqual(config.allowAnonymous, false,
    'el modo sin clave no puede activarse solo por no configurar usuarios');

  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/catalog`);
    assert.strictEqual(res.status, 401, 'sin sesion no se ve el catalogo');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
