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

function session(user) {
  return { user, exp: Date.now() + config.sessionHours * 3600 * 1000 };
}

/**
 * Comprueba las credenciales contra las cuentas guardadas en la base y, si no
 * hay coincidencia, contra las de APP_USERS.
 *
 * Se mantienen las dos vias a proposito: APP_USERS sigue sirviendo para
 * arrancar o para recuperar el acceso si alguien se queda fuera, y las cuentas
 * de la base son las que se crean desde la pagina.
 */
async function login(user, password) {
  const key = String(user || '').trim().toLowerCase();
  if (!key || !password) return null;

  const users = require('./users');
  const row = await users.findByUsername(key);
  if (row && Number(row.active) === 1 && await users.verifyPassword(password, row.password_hash)) {
    await users.touchLogin(row.id);
    return session(key);
  }

  const expected = config.users.get(key);
  if (expected && passwordMatches(expected, password)) return session(key);
  return null;
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
 * Exige sesion salvo que se haya pedido ALLOW_ANONYMOUS de forma explicita,
 * que solo funciona fuera de produccion.
 */
function requireAuth(req, res, next) {
  if (config.allowAnonymous) {
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
