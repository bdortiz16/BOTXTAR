'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

function bool(v, fallback = false) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'on'].includes(String(v).toLowerCase());
}

/**
 * Usuarios operadores. Formato: "bryan:clave1,admin2:clave2".
 * Si no se define, se usa ADMIN_USER / ADMIN_PASSWORD.
 */
function parseUsers() {
  const raw = process.env.APP_USERS;
  const users = new Map();
  if (raw) {
    for (const pair of raw.split(',')) {
      const idx = pair.indexOf(':');
      if (idx <= 0) continue;
      const user = pair.slice(0, idx).trim();
      const pass = pair.slice(idx + 1).trim();
      if (user && pass) users.set(user.toLowerCase(), pass);
    }
  }
  if (users.size === 0) {
    const user = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
    const pass = process.env.ADMIN_PASSWORD || '';
    if (pass) users.set(user, pass);
  }
  return users;
}

// Vercel, Netlify y AWS Lambda marcan el entorno con estas variables.
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
  || process.env.NETLIFY);

/**
 * En serverless el unico directorio donde se puede escribir es /tmp. El resto
 * del sistema de archivos es de solo lectura, y abrir ahi el SQLite reventaba
 * la peticion con un error 500 sin explicacion.
 */
const DEFAULT_DB_FILE = SERVERLESS
  ? '/tmp/botxtar.db'
  : path.join(__dirname, '..', 'data', 'botxtar.db');

const config = {
  port: Number(process.env.PORT || 3000),
  env: process.env.NODE_ENV || 'development',
  serverless: SERVERLESS,
  dbFile: process.env.DB_FILE || DEFAULT_DB_FILE,

  // Con Postgres configurado la app lo usa y deja de tocar el disco. Es lo
  // que hace falta en Vercel, donde el sistema de archivos es efimero.
  // POSTGRES_URL lo pone la integracion de Vercel; DATABASE_URL, Neon y otros.
  databaseUrl: (process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim(),

  // Un unico bot de Telegram; cada pais apunta a su propio grupo (chat_id).
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    timeoutMs: Number(process.env.TELEGRAM_TIMEOUT_MS || 15000),
    retries: Number(process.env.TELEGRAM_RETRIES || 3),
    // Grupo por defecto cuando un pais aun no tiene chat propio.
    fallbackChatId: process.env.TELEGRAM_FALLBACK_CHAT_ID || '',
  },

  users: parseUsers(),

  // Codigo de invitacion para crear cuenta desde la pagina publica. Sin el,
  // solo se puede crear la primera cuenta (la del dueño).
  signupCode: (process.env.SIGNUP_CODE || '').trim(),
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  secureCookies: bool(process.env.SECURE_COOKIES, process.env.NODE_ENV === 'production'),

  // Zona horaria usada para la fecha por defecto y los informes.
  timezone: process.env.TIMEZONE || 'America/Bogota',
};

config.telegramEnabled = Boolean(config.telegram.token);
config.usesPostgres = Boolean(config.databaseUrl);

/**
 * Modo sin clave, solo para trastear en local. Hay que pedirlo a proposito:
 * antes se activaba solo con que faltara APP_USERS, y desde que las cuentas
 * viven en la base eso podia dejar una instancia entera abierta por olvidar
 * una variable. En produccion se ignora.
 */
config.allowAnonymous = bool(process.env.ALLOW_ANONYMOUS, false)
  && (process.env.NODE_ENV || 'development') !== 'production';

/**
 * Avisos sobre como quedo montada la instancia.
 *
 * Antes esto bloqueaba el arranque, y eso resulto peor que el problema que
 * intentaba evitar: dejaba la app inservible con un mensaje que no decia que
 * arreglar. Ahora la app funciona siempre y los avisos se muestran dentro,
 * donde se ven y se pueden atender sin adivinar.
 */
function warnings() {
  const list = [];

  if (config.ephemeralStorage) {
    list.push({
      code: 'SIN_BASE',
      level: 'bad',
      text: 'No hay base de datos conectada: las operaciones se guardan en memoria y '
        + 'se borran solas. Sirve para revisar la app, todavia no para llevar la '
        + 'contabilidad. Conecta Postgres (POSTGRES_URL) cuando puedas.',
    });
  }
  if (!config.signupCode && !config.authEnabled) {
    list.push({
      code: 'REGISTRO_ABIERTO',
      level: 'warn',
      text: 'Cualquiera que llegue a la direccion puede crear la primera cuenta. '
        + 'Define SIGNUP_CODE para que haga falta un codigo de invitacion.',
    });
  }
  if (!config.telegramEnabled) {
    list.push({
      code: 'SIN_TELEGRAM',
      level: 'warn',
      text: 'Telegram no esta configurado: las operaciones se guardan pero no se '
        + 'envian al grupo. Falta TELEGRAM_BOT_TOKEN.',
    });
  }
  return list;
}

config.ephemeralStorage = !config.databaseUrl && SERVERLESS;
config.warnings = warnings;
config.authEnabled = config.users.size > 0;

module.exports = config;
