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
 * Revisa la configuracion antes de atender peticiones en produccion.
 *
 * Son fallos silenciosos, y por eso peligrosos: sin SESSION_SECRET cada
 * instancia firma con una clave distinta y las sesiones se caen al azar; sin
 * Postgres en un entorno serverless la base se borra en cada despliegue.
 */
function productionProblems() {
  if (config.env !== 'production') return [];
  const problems = [];

  if (!process.env.SESSION_SECRET) {
    problems.push('Falta SESSION_SECRET. Sin el, las sesiones se cierran solas. ' +
      'Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (!config.authEnabled && !config.signupCode) {
    problems.push('Falta SIGNUP_CODE (el codigo para crear cuentas) o APP_USERS. '
      + 'Sin ninguno de los dos, cualquiera que encuentre la direccion podria entrar.');
  }
  return problems;
}

/**
 * Sin Postgres en serverless la app funciona, pero guarda en /tmp: los datos
 * duran lo que dure la instancia. No se bloquea el arranque (sirve para
 * probar la interfaz), pero se avisa en pantalla para que nadie confunda esto
 * con contabilidad guardada.
 */
config.ephemeralStorage = !config.databaseUrl && SERVERLESS;
config.productionProblems = productionProblems;
config.authEnabled = config.users.size > 0;

module.exports = config;
