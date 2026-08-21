'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const COOKIE = 'botxtar_session';

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Comparacion en tiempo constante para no filtrar la clave por timing. */
function passwordMatches(expected, given) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a); // gasta el mismo tiempo igualmente
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function login(user, password) {
  const key = String(user || '').trim().toLowerCase();
  const expected = config.users.get(key);
  if (!expected) return null;
  if (!passwordMatches(expected, password)) return null;
  return { user: key, exp: Date.now() + config.sessionHours * 3600 * 1000 };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, payload) {
  const attrs = [
    `${COOKIE}=${sign(payload)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionHours * 3600}`,
  ];
  if (config.secureCookies) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Si no hay usuarios configurados (APP_USERS / ADMIN_PASSWORD), la app corre
 * abierta: util para probar en local, nunca para produccion. El servidor lo
 * advierte al arrancar.
 */
function requireAuth(req, res, next) {
  if (!config.authEnabled) {
    req.user = 'local';
    return next();
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = verify(cookies[COOKIE]);
  if (!session) {
    res.status(401).json({ error: 'Sesion expirada. Vuelve a entrar.' });
    return;
  }
  req.user = session.user;
  next();
}

module.exports = { COOKIE, login, verify, setSessionCookie, clearSessionCookie, requireAuth, parseCookies };
