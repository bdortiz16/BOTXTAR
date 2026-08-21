'use strict';

const crypto = require('node:crypto');

const KEY = 'session_secret';
let cached = null;

/**
 * Resuelve la clave con la que se firman las sesiones.
 *
 * Antes habia que generarla a mano y ponerla en una variable, y si faltaba la
 * app se negaba a arrancar. Ahora: si SESSION_SECRET esta definida se usa esa;
 * si no, se genera una y se guarda en la base, de modo que todas las
 * instancias firmen igual sin que nadie configure nada.
 *
 * Se resuelve una vez por instancia, despues de crear el esquema.
 */
async function ensureSecret() {
  if (cached) return cached;

  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }

  const { db } = require('./db');
  const existing = await db.get('SELECT value FROM settings WHERE key = ?', [KEY]);
  if (existing?.value) {
    cached = existing.value;
    return cached;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
    [KEY, generated]
  );
  // Si dos instancias arrancaron a la vez, gana la que inserto primero.
  const stored = await db.get('SELECT value FROM settings WHERE key = ?', [KEY]);
  cached = stored?.value || generated;
  return cached;
}

function currentSecret() {
  if (!cached) throw new Error('La clave de sesion todavia no se ha cargado');
  return cached;
}

/** Solo para pruebas: olvida la clave cargada. */
function reset() { cached = null; }

module.exports = { ensureSecret, currentSecret, reset, KEY };
