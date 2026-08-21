'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-vercel-'));
process.env.DB_FILE = path.join(tmp, 'vercel.db');
process.env.APP_USERS = 'bryan:clave123';
process.env.SESSION_SECRET = 'prueba-vercel';

// El punto de entrada de Vercel, no el servidor local.
const app = require('../api/index.js');

/**
 * Imita como invoca Vercel a la funcion: consume el cuerpo de la peticion y
 * lo deja en `req.body` antes de llamar al handler. Si Express intentara leer
 * el stream otra vez, todos los POST llegarian vacios; esta prueba lo detecta.
 */
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw && String(req.headers['content-type'] || '').includes('json')) {
    try { req.body = JSON.parse(raw); } catch { /* cuerpo invalido */ }
  }
  app(req, res);
});

let base;
let cookie = '';

test.before(async () => {
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
});

async function call(pathname, options = {}) {
  const res = await fetch(base + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}

test('el cuerpo que Vercel ya parseo llega completo a la ruta', async () => {
  const r = await call('/api/auth/login', {
    method: 'POST', body: { user: 'bryan', password: 'clave123' },
  });
  assert.strictEqual(r.status, 200, 'si el cuerpo se perdiera, esto seria 401');
  assert.strictEqual(r.data.user, 'bryan');
});

test('los objetos anidados sobreviven: una operacion completa se guarda', async () => {
  const r = await call('/api/operations', {
    method: 'POST',
    body: {
      op_date: '2026-08-21', origin_country_id: 'peru', dest_country_id: 'colombia',
      origin_amount: '10.000', rate: '1.000', delivery_type: 'TRANSFER',
      destinations: [
        { beneficiary_name: 'Ana Perez', bank_name: 'Bancolombia', account_number: '111',
          account_type: 'AHORROS', doc_type: 'CC', doc_number: '1', amount: '3.000.000' },
        { beneficiary_name: 'Luis Gomez', bank_name: 'Nequi', account_number: '222',
          account_type: 'DIGITAL', doc_type: 'CC', doc_number: '2', amount: '7.000.000' },
      ],
      usdt_sales: [{ quantity: '2500', unit_price: '4000', currency: 'COP' }],
    },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.dest_amount, '10000000');
  assert.strictEqual(r.data.transfers.length, 2);
  assert.strictEqual(r.data.usdt_sales.length, 1);
});

test('las validaciones siguen respondiendo con su mensaje', async () => {
  const r = await call('/api/operations', {
    method: 'POST',
    body: {
      op_date: '2026-08-21', origin_country_id: 'peru', dest_country_id: 'colombia',
      origin_amount: '10.000', rate: '1.000', delivery_type: 'TRANSFER',
      destinations: [{ beneficiary_name: 'Ana', amount: '3.000.000' }],
    },
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /Falta repartir 7\.000\.000/);
});

test('la interfaz se sirve desde la misma funcion', async () => {
  const res = await fetch(base + '/');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /BOTXTAR/);
});
