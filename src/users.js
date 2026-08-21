'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { db } = require('./db');
const config = require('./config');
const { ValidationError } = require('./money');

const scrypt = promisify(crypto.scrypt);

// Parametros de scrypt: coste alto pero razonable para un login por sesion.
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

/**
 * Guarda la clave como `scrypt$N$r$p$sal$hash`.
 *
 * Se usa scrypt del modulo crypto de Node, no una dependencia externa: es
 * lento a proposito, lleva sal unica por usuario y no hay que confiar en un
 * paquete de terceros para lo unico que protege la contabilidad.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = await scrypt(password, salt, expected.length,
      { N: Number(n), r: Number(rr), p: Number(pp) });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * El usuario puede ser un nombre corto o un correo: lo unico que se exige es
 * que no tenga espacios y que sea suficientemente largo para no confundirse.
 */
function validateUsername(value) {
  const user = normalizeUsername(value);
  if (user.length < 3) throw new ValidationError('El usuario necesita al menos 3 caracteres');
  if (user.length > 60) throw new ValidationError('El usuario es demasiado largo');
  if (/\s/.test(user)) throw new ValidationError('El usuario no puede llevar espacios');
  return user;
}

function validatePassword(value) {
  const pass = String(value ?? '');
  if (pass.length < 8) throw new ValidationError('La clave necesita al menos 8 caracteres');
  if (pass.length > 200) throw new ValidationError('La clave es demasiado larga');
  return pass;
}

async function count() {
  const row = await db.get('SELECT COUNT(*) AS c FROM users');
  return Number(row.c);
}

async function findByUsername(username) {
  return db.get('SELECT * FROM users WHERE username = ?', [normalizeUsername(username)]);
}

async function create({ username, password, name, role = 'OPERATOR' }) {
  const user = validateUsername(username);
  const pass = validatePassword(password);
  if (await findByUsername(user)) {
    throw new ValidationError('Ese usuario ya existe. Prueba con otro o entra con tu clave.');
  }
  const row = await db.get(
    `INSERT INTO users (username, name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [user, String(name ?? '').trim().slice(0, 120), await hashPassword(pass), role,
     new Date().toISOString()]
  );
  return { id: Number(row.id), username: user, role };
}

/**
 * Decide si se permite registrarse.
 *
 * Con SIGNUP_CODE definido hace falta el codigo: es lo que evita que
 * cualquiera que encuentre la direccion se meta a ver la contabilidad. Sin el,
 * solo se permite crear la primera cuenta, para poder arrancar.
 */
async function canRegister(code) {
  const expected = config.signupCode;
  if (expected) {
    if (String(code ?? '').trim() !== expected) {
      return { ok: false, reason: 'Codigo de invitacion incorrecto. Pideselo al administrador.' };
    }
    return { ok: true, role: (await count()) === 0 ? 'OWNER' : 'OPERATOR' };
  }
  if ((await count()) === 0) return { ok: true, role: 'OWNER' };
  return {
    ok: false,
    reason: 'El registro esta cerrado. El administrador debe configurar un codigo de '
      + 'invitacion (SIGNUP_CODE) para que puedas crear tu cuenta.',
  };
}

async function touchLogin(id) {
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), id]);
}

module.exports = {
  hashPassword, verifyPassword, normalizeUsername, validateUsername, validatePassword,
  count, findByUsername, create, canRegister, touchLogin,
};
