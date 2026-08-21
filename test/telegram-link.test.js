'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-tglink-'));
process.env.DB_FILE = path.join(tmp, 'link.db');
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';

// Telegram simulado, para ver que mensajes manda el bot a los grupos.
const enviados = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    enviados.push({ metodo: req.url.split('/').pop(), payload: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});

let db;
let updates;

test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  ({ db } = require('../src/db'));
  await require('../src/db').init();
  updates = require('../src/telegram-updates');
});

test.after(async () => { await new Promise((r) => fake.close(r)); });

const agregado = (id, title) => ({
  my_chat_member: {
    chat: { id, title, type: 'supergroup' },
    new_chat_member: { status: 'member' },
  },
});

test('reconoce el pais en el nombre del grupo', async () => {
  assert.strictEqual((await updates.countryFromTitle('BRASIL - PAGOS DE CLIENTES'))?.id, 'brasil');
  assert.strictEqual((await updates.countryFromTitle('Peru pagos'))?.id, 'peru');
  assert.strictEqual((await updates.countryFromTitle('PERÚ · clientes'))?.id, 'peru');
  assert.strictEqual((await updates.countryFromTitle('mexico-envios'))?.id, 'mexico');
  assert.strictEqual((await updates.countryFromTitle('Equipo de soporte')), null);
});

test('no confunde un pais con una palabra que lo contiene', async () => {
  // "colombiano" no es "colombia": se exige que el nombre vaya suelto.
  assert.strictEqual(await updates.countryFromTitle('grupo colombiano de amigos'), null);
});

test('al agregar el bot a un grupo con nombre de pais, se vincula solo', async () => {
  const r = await updates.handleUpdate(agregado(-1001, 'BRASIL - PAGOS DE CLIENTES'));
  assert.strictEqual(r.action, 'VINCULADO');
  assert.strictEqual(r.country_id, 'brasil');
  assert.strictEqual(r.auto, true);

  const pais = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'brasil'");
  assert.strictEqual(pais.telegram_chat_id, '-1001');

  const aviso = enviados.at(-1);
  assert.match(aviso.payload.text, /BOTXTAR conectado/);
  assert.match(aviso.payload.text, /Brasil/);
});

test('si el nombre no dice el pais, queda detectado y pide vincular', async () => {
  const r = await updates.handleUpdate(agregado(-1002, 'Equipo operaciones'));
  assert.strictEqual(r.action, 'DETECTADO');
  assert.match(enviados.at(-1).payload.text, /\/vincular/);

  const chats = await updates.listChats();
  const chat = chats.find((c) => c.chat_id === '-1002');
  assert.ok(chat, 'el grupo queda registrado aunque no se vincule');
  assert.strictEqual(chat.country_id, null);
});

test('el comando /vincular asigna el grupo', async () => {
  const r = await updates.handleUpdate({
    message: { chat: { id: -1002, title: 'Equipo operaciones', type: 'supergroup' }, text: '/vincular chile' },
  });
  assert.strictEqual(r.action, 'VINCULADO');
  assert.strictEqual(r.country_id, 'chile');
  const pais = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'chile'");
  assert.strictEqual(pais.telegram_chat_id, '-1002');
});

test('un pais que no existe no rompe nada y ofrece la lista', async () => {
  const r = await updates.handleUpdate({
    message: { chat: { id: -1002, title: 'x', type: 'supergroup' }, text: '/vincular narnia' },
  });
  assert.strictEqual(r.action, 'PAIS_DESCONOCIDO');
  assert.match(enviados.at(-1).payload.text, /vincular/);
});

test('no le roba el grupo a un pais que ya lo tenia', async () => {
  // Brasil ya tiene el -1001; agregar otro grupo que tambien diga Brasil no
  // debe pisarlo en silencio.
  const r = await updates.handleUpdate(agregado(-1003, 'Brasil segundo grupo'));
  assert.strictEqual(r.action, 'DETECTADO');
  const pais = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'brasil'");
  assert.strictEqual(pais.telegram_chat_id, '-1001', 'el grupo original se mantiene');
});

test('vincular a mano mueve el pais de un grupo a otro sin dejar dos', async () => {
  await updates.linkChat('-1003', 'brasil');
  const pais = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'brasil'");
  assert.strictEqual(pais.telegram_chat_id, '-1003');

  const chats = await updates.listChats();
  const conBrasil = chats.filter((c) => c.country_id === 'brasil').map((c) => c.chat_id);
  assert.deepStrictEqual(conBrasil, ['-1003'], 'solo un grupo por pais');
});

test('si sacan al bot del grupo, se desvincula', async () => {
  const r = await updates.handleUpdate({
    my_chat_member: {
      chat: { id: -1003, title: 'Brasil segundo grupo', type: 'supergroup' },
      new_chat_member: { status: 'kicked' },
    },
  });
  assert.strictEqual(r.action, 'SALIO');
  const pais = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'brasil'");
  assert.strictEqual(pais.telegram_chat_id, '', 'el pais queda sin grupo, no apuntando a uno perdido');
});

test('una actualizacion rara no tumba el webhook', async () => {
  for (const basura of [{}, null, { message: {} }, { my_chat_member: {} }, { update_id: 1 }]) {
    const r = await updates.handleUpdate(basura);
    assert.ok(r && typeof r.action === 'string', 'siempre devuelve algo');
    assert.notStrictEqual(r.action, 'ERROR');
  }
});

test('un chat privado no se registra como grupo', async () => {
  const r = await updates.handleUpdate({
    message: { chat: { id: 555, type: 'private' }, text: '/vincular peru' },
  });
  assert.strictEqual(r.action, 'IGNORADA');
  const pais = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'peru'");
  assert.strictEqual(pais.telegram_chat_id, '', 'un privado no puede quedarse con un pais');
});

test('mover un grupo de pais deja libre al pais anterior', async () => {
  await updates.rememberChat({ id: -2001, title: 'Grupo compartido', type: 'supergroup' });
  await updates.linkChat('-2001', 'ecuador');
  await updates.linkChat('-2001', 'venezuela');

  const ecuador = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'ecuador'");
  const venezuela = await db.get("SELECT telegram_chat_id FROM countries WHERE id = 'venezuela'");
  assert.strictEqual(venezuela.telegram_chat_id, '-2001');
  assert.strictEqual(ecuador.telegram_chat_id, '',
    'si el pais anterior siguiera apuntando aqui, sus envios irian al grupo equivocado');

  // Y ningun pais puede quedar con dos grupos.
  await updates.rememberChat({ id: -2002, title: 'Otro grupo', type: 'supergroup' });
  await updates.linkChat('-2002', 'venezuela');
  const chats = await updates.listChats();
  const deVenezuela = chats.filter((c) => c.country_id === 'venezuela').map((c) => c.chat_id);
  assert.deepStrictEqual(deVenezuela, ['-2002']);
});
