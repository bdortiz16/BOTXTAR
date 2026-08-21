'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-api-'));
process.env.DB_FILE = path.join(tmp, 'api.db');
process.env.APP_USERS = 'bryan:clave123';
process.env.SESSION_SECRET = 'secreto-de-prueba';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';

// Servidor que imita a api.telegram.org para comprobar el envio de verdad.
const received = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, payload: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/getMe')) {
      res.end(JSON.stringify({ ok: true, result: { username: 'botxtar_bot' } }));
    } else {
      res.end(JSON.stringify({ ok: true, result: { message_id: 4242 } }));
    }
  });
});

let base;
let app;
let server;
let cookie = '';

test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  app = require('../src/server');
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
});

async function call(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

test('sin sesion la API responde 401', async () => {
  const r = await call('/api/catalog');
  assert.strictEqual(r.status, 401);
});

test('rechaza una clave incorrecta', async () => {
  const r = await call('/api/auth/login', { method: 'POST', body: { user: 'bryan', password: 'mala' } });
  assert.strictEqual(r.status, 401);
});

test('entra con la clave correcta', async () => {
  const r = await call('/api/auth/login', { method: 'POST', body: { user: 'bryan', password: 'clave123' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user, 'bryan');
});

test('el catalogo trae los paises que ya tienen grupo', async () => {
  const r = await call('/api/catalog');
  assert.strictEqual(r.status, 200);
  const ids = r.data.countries.map((c) => c.id);
  for (const id of ['peru', 'chile', 'brasil', 'mexico', 'colombia']) {
    assert.ok(ids.includes(id), `falta ${id}`);
  }
  assert.ok(r.data.banks.colombia.includes('Nequi'));
});

test('se puede agregar un pais nuevo (otros paises)', async () => {
  const r = await call('/api/countries', {
    method: 'POST',
    body: { name: 'Argentina', emoji: '🇦🇷', currency: 'ARS', telegram_chat_id: '-1009999' },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.id, 'argentina');

  const dup = await call('/api/countries', { method: 'POST', body: { name: 'Argentina', currency: 'ARS' } });
  assert.strictEqual(dup.status, 400);
});

test('la vista previa calcula el total en vivo', async () => {
  const r = await call('/api/operations/preview', {
    method: 'POST',
    body: { origin_country_id: 'peru', dest_country_id: 'colombia', origin_amount: '10.000', rate: '1.000' },
  });
  assert.strictEqual(r.data.dest_amount_display, '10.000.000');
});

let opId;

test('crea la operacion fraccionada en 3 cuentas', async () => {
  const r = await call('/api/operations', {
    method: 'POST',
    body: {
      op_date: '2026-08-21',
      origin_country_id: 'peru', dest_country_id: 'colombia',
      origin_amount: '10.000', rate: '1.000', rate_mode: 'MULTIPLY',
      delivery_type: 'TRANSFER',
      client_name: 'Cliente demo',
      destinations: [
        { beneficiary_name: 'Ana Perez', doc_type: 'CC', doc_number: '111',
          bank_name: 'Bancolombia', account_number: '123', account_type: 'AHORROS', amount: '3.000.000' },
        { beneficiary_name: 'Luis Gomez', doc_type: 'CC', doc_number: '222',
          bank_name: 'Nequi', account_number: '300', account_type: 'DIGITAL', amount: '3.000.000' },
        { beneficiary_name: 'Sara Diaz', doc_type: 'CE', doc_number: '333',
          bank_name: 'Davivienda', account_number: '987', account_type: 'CORRIENTE', amount: '4.000.000' },
      ],
      usdt_sales: [{ quantity: '2500', unit_price: '4000', currency: 'COP', network: 'TRON' }],
    },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.transfers.length, 3);
  assert.strictEqual(r.data.dest_amount, '10000000');
  opId = r.data.id;
});

test('bloquea un reparto que no cuadra', async () => {
  const r = await call('/api/operations', {
    method: 'POST',
    body: {
      op_date: '2026-08-21', origin_country_id: 'peru', dest_country_id: 'colombia',
      origin_amount: '10.000', rate: '1.000', delivery_type: 'TRANSFER',
      destinations: [
        { beneficiary_name: 'Ana', amount: '3.000.000' },
        { beneficiary_name: 'Luis', amount: '3.000.000' },
      ],
    },
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /Falta repartir 4\.000\.000/);
});

test('envia el mensaje al grupo del pais', async () => {
  await call('/api/countries/peru', { method: 'PATCH', body: { telegram_chat_id: '-1001111' } });
  const r = await call(`/api/operations/${opId}/send`, { method: 'POST', body: {} });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.operation.status, 'SENT');
  assert.strictEqual(r.data.operation.telegram_message_id, '4242');

  const sent = received.filter((x) => x.url.endsWith('/sendMessage')).pop();
  assert.strictEqual(sent.payload.chat_id, '-1001111');
  assert.match(sent.payload.text, /Ana Perez/);
  assert.match(sent.payload.text, /10\.000\.000 COP/);
});

test('no reenvia sin confirmar', async () => {
  const r = await call(`/api/operations/${opId}/send`, { method: 'POST', body: {} });
  assert.strictEqual(r.status, 409);
});

test('avisa si el pais no tiene grupo configurado', async () => {
  await call('/api/countries/chile', { method: 'PATCH', body: { telegram_chat_id: '' } });
  const created = await call('/api/operations', {
    method: 'POST',
    body: {
      op_date: '2026-08-21', origin_country_id: 'chile', dest_country_id: 'colombia',
      origin_amount: '100.000', rate: '4,2', delivery_type: 'CASH',
      destinations: [{ city: 'Medellin', address: 'Poblado', amount: '420000' }],
    },
  });
  assert.strictEqual(created.status, 201);
  const r = await call(`/api/operations/${created.data.id}/send`, { method: 'POST', body: {} });
  assert.strictEqual(r.status, 502);
  assert.match(r.data.error, /no tiene grupo de Telegram/);
});

test('el informe y el CSV responden', async () => {
  const rep = await call('/api/report?from=2026-08-21&to=2026-08-21');
  assert.strictEqual(rep.status, 200);
  assert.ok(rep.data.totals.operations >= 2);

  const csv = await call('/api/report.csv?from=2026-08-21&to=2026-08-21');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.data, /folio,fecha,estado/);
  assert.match(csv.data, /Ana Perez/);
});

test('la plantilla del mensaje se puede editar', async () => {
  const saved = await call('/api/settings/template', {
    method: 'PUT', body: { template: 'PRUEBA {{folio}} = {{monto_destino}} {{moneda_destino}}' },
  });
  assert.strictEqual(saved.status, 200);
  const pv = await call(`/api/operations/${opId}/preview-message`);
  assert.match(pv.data.text, /^PRUEBA 20260821-\d{3} = 10\.000\.000 COP$/);
  await call('/api/settings/template', { method: 'PUT', body: { template: '' } }); // restaura
});

test('la pagina principal se sirve', async () => {
  const res = await fetch(base + '/');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /BOTXTAR/);
});

test('la vista previa del mensaje funciona sin guardar la operacion', async () => {
  const r = await call('/api/operations/preview-message', {
    method: 'POST',
    body: {
      op_date: '2026-08-21', origin_country_id: 'peru', dest_country_id: 'colombia',
      origin_amount: '10.000', rate: '1.000', delivery_type: 'TRANSFER',
      destinations: [{ beneficiary_name: 'Ana Perez', bank_name: 'Nequi', amount: '10.000.000' }],
    },
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.data.text, /Ana Perez/);
  assert.match(r.data.text, /10\.000\.000 COP/);
  assert.strictEqual(r.data.chat_id, '-1001111');

  // Un reparto que no cuadra tampoco pasa por aqui.
  const bad = await call('/api/operations/preview-message', {
    method: 'POST',
    body: {
      op_date: '2026-08-21', origin_country_id: 'peru', dest_country_id: 'colombia',
      origin_amount: '10.000', rate: '1.000', delivery_type: 'TRANSFER',
      destinations: [{ beneficiary_name: 'Ana', amount: '5.000.000' }],
    },
  });
  assert.strictEqual(bad.status, 400);
});

test('la pagina publica se sirve en la raiz y la app en /app', async () => {
  const home = await fetch(base + '/');
  assert.strictEqual(home.status, 200);
  const html = await home.text();
  assert.match(html, /casas de remesas/i, 'la raiz es la pagina publica');
  assert.match(html, /Crear cuenta/);

  const appRes = await fetch(base + '/app');
  assert.strictEqual(appRes.status, 200);
  assert.match(await appRes.text(), /app\.js/, '/app sirve la aplicacion');
});

test('el estado del registro se puede consultar sin sesion', async () => {
  const res = await fetch(base + '/api/auth/signup-state');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(typeof data.open, 'boolean');
  assert.strictEqual(typeof data.code_required, 'boolean');
});

test('sin codigo de invitacion no se cuela un registro', async () => {
  // Esta base ya tiene APP_USERS pero ninguna cuenta creada: la primera pasa.
  const primera = await call('/api/auth/register', {
    method: 'POST',
    body: { user: 'duenio', password: 'clave-del-duenio', name: 'Duenio' },
  });
  assert.strictEqual(primera.status, 201);
  assert.strictEqual(primera.data.role, 'OWNER');

  const segunda = await call('/api/auth/register', {
    method: 'POST',
    body: { user: 'colado', password: 'clave-del-colado' },
  });
  assert.strictEqual(segunda.status, 403);
  assert.match(segunda.data.error, /registro esta cerrado/i);
});

test('la cuenta creada sirve para entrar', async () => {
  const r = await call('/auth/logout'.replace('/auth', '/api/auth'), { method: 'POST' });
  assert.strictEqual(r.status, 200);
  const login = await call('/api/auth/login', {
    method: 'POST', body: { user: 'DUENIO', password: 'clave-del-duenio' },
  });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.data.user, 'duenio');
});

test('el panel de inicio resume el dia y lo pendiente', async () => {
  const hoy = require('../src/operations').today();

  // Se mide la diferencia y no el total: otras pruebas de este archivo crean
  // operaciones, y algunas caen en "hoy" segun el dia en que se corra.
  const antes = (await call('/api/dashboard')).data;
  const suma = (lista, moneda) =>
    Number(lista.find((x) => x.currency === moneda)?.amount || 0);

  // Una operacion enviada y otra sin enviar, con fecha de hoy.
  const enviada = await call('/api/operations', {
    method: 'POST',
    body: {
      op_date: hoy, origin_country_id: 'peru', dest_country_id: 'colombia',
      origin_amount: '10.000', rate: '1.000', delivery_type: 'TRANSFER',
      destinations: [{ beneficiary_name: 'Ana', bank_name: 'Nequi', amount: '10.000.000' }],
    },
  });
  assert.strictEqual(enviada.status, 201);
  await call(`/api/operations/${enviada.data.id}/status`, { method: 'POST', body: { status: 'SENT' } });

  const borrador = await call('/api/operations', {
    method: 'POST',
    body: {
      op_date: hoy, origin_country_id: 'chile', dest_country_id: 'colombia',
      origin_amount: '100.000', rate: '4,2', delivery_type: 'CASH',
      destinations: [{ city: 'Cali', amount: '420.000' }],
    },
  });
  assert.strictEqual(borrador.status, 201);

  const r = await call('/api/dashboard');
  assert.strictEqual(r.status, 200);
  const d = r.data;

  assert.ok(['Buenos días', 'Buenas tardes', 'Buenas noches'].includes(d.greeting));
  assert.strictEqual(d.user.username, 'duenio');
  assert.strictEqual(d.today, hoy);

  assert.strictEqual(d.today_totals.operations - antes.today_totals.operations, 2,
    'cuenta las dos operaciones nuevas del dia');
  assert.strictEqual(
    suma(d.today_totals.received, 'PEN') - suma(antes.today_totals.received, 'PEN'), 10000,
    'suma los soles recibidos'
  );
  assert.strictEqual(
    suma(d.today_totals.received, 'CLP') - suma(antes.today_totals.received, 'CLP'), 100000,
    'suma los pesos chilenos sin mezclarlos con los soles'
  );

  assert.strictEqual(d.pending.sent_unpaid - antes.pending.sent_unpaid, 1,
    'lo enviado sin pagar queda pendiente');
  assert.strictEqual(d.pending.drafts - antes.pending.drafts, 1,
    'los borradores quedan pendientes de enviar');
  assert.strictEqual(
    suma(d.pending.amount, 'COP') - suma(antes.pending.amount, 'COP'), 10000000,
    'solo suma lo enviado, no los borradores'
  );

  assert.ok(Array.isArray(d.recent) && d.recent.length > 0);
  assert.ok(d.recent[0].transfers || d.recent[0].cash_deliveries,
    'las operaciones recientes vienen con sus destinos');
});

test('el panel no se ve sin sesion', async () => {
  const guardada = cookie;
  cookie = '';
  const r = await call('/api/dashboard');
  assert.strictEqual(r.status, 401);
  cookie = guardada;
});

test('el webhook de Telegram rechaza a quien no traiga el secreto', async () => {
  const { db } = require('../src/db');
  await db.run(
    "INSERT INTO settings (key, value) VALUES ('telegram_webhook_secret', 'secreto-de-prueba') "
    + 'ON CONFLICT (key) DO UPDATE SET value = excluded.value'
  );

  const cuerpo = {
    my_chat_member: {
      chat: { id: -100777, title: 'ECUADOR pagos', type: 'supergroup' },
      new_chat_member: { status: 'member' },
    },
  };

  // Sin cabecera: no pasa.
  const sinSecreto = await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  assert.strictEqual(sinSecreto.status, 401);

  // Con un secreto equivocado: tampoco.
  const malSecreto = await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'otro' },
    body: JSON.stringify(cuerpo),
  });
  assert.strictEqual(malSecreto.status, 401);

  // Y el grupo no quedo registrado por los intentos fallidos.
  const antes = await db.get("SELECT chat_id FROM telegram_chats WHERE chat_id = '-100777'");
  assert.strictEqual(antes, undefined);

  // Con el secreto correcto: se procesa y se vincula solo.
  const bien = await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'secreto-de-prueba' },
    body: JSON.stringify(cuerpo),
  });
  assert.strictEqual(bien.status, 200);
  assert.strictEqual((await bien.json()).country_id, 'ecuador');

  const pais = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'ecuador'");
  assert.strictEqual(pais.telegram_chat_id, '-100777');
});

test('el webhook no se puede llamar sin sesion ni secreto configurado', async () => {
  const { db } = require('../src/db');
  await db.run("UPDATE settings SET value = '' WHERE key = 'telegram_webhook_secret'");
  const r = await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': '' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(r.status, 401, 'sin webhook conectado no se acepta nada');
});

test('los grupos detectados se pueden listar y reasignar desde la app', async () => {
  const lista = await call('/api/telegram/chats');
  assert.strictEqual(lista.status, 200);
  const chat = lista.data.chats.find((c) => c.chat_id === '-100777');
  assert.ok(chat, 'el grupo detectado aparece en la lista');
  assert.strictEqual(chat.country_id, 'ecuador');
  assert.strictEqual(chat.title, 'ECUADOR pagos');

  // Reasignar a otro pais.
  const mover = await call('/api/telegram/chats/-100777/link', {
    method: 'POST', body: { country_id: 'venezuela' },
  });
  assert.strictEqual(mover.status, 200);

  const { db } = require('../src/db');
  const venezuela = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'venezuela'");
  const ecuador = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'ecuador'");
  assert.strictEqual(venezuela.telegram_chat_id, '-100777');
  assert.strictEqual(ecuador.telegram_chat_id, '', 'el pais anterior queda libre');

  // Y desvincular.
  await call('/api/telegram/chats/-100777/link', { method: 'POST', body: { country_id: '' } });
  const despues = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'venezuela'");
  assert.strictEqual(despues.telegram_chat_id, '');
});

test('conectar el webhook exige una direccion publica', async () => {
  // La prueba corre en 127.0.0.1: Telegram no podria alcanzarla.
  const r = await call('/api/telegram/connect', { method: 'POST', body: {} });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /direccion publica|HTTPS/i);
});
