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

const config = {
  port: Number(process.env.PORT || 3000),
  env: process.env.NODE_ENV || 'development',
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'botxtar.db'),

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
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  secureCookies: bool(process.env.SECURE_COOKIES, process.env.NODE_ENV === 'production'),

  // Zona horaria usada para la fecha por defecto y los informes.
  timezone: process.env.TIMEZONE || 'America/Bogota',
};

config.telegramEnabled = Boolean(config.telegram.token);
config.authEnabled = config.users.size > 0;

module.exports = config;
