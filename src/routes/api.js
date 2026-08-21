'use strict';

const express = require('express');
const { db } = require('../db');
const config = require('../config');
const money = require('../money');
const currencies = require('../currencies');
const ops = require('../operations');
const telegram = require('../telegram');
const report = require('../report');
const auth = require('../auth');
const users = require('../users');

const router = express.Router();
const { ValidationError } = money;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40);
}

/* ------------------------------ sesion ---------------------------------- */

router.post('/auth/login', wrap(async (req, res) => {
  const session = await auth.login(req.body?.user, req.body?.password);
  if (!session) {
    return res.status(401).json({
      error: 'Usuario o clave incorrectos. Revisa que el usuario sea el mismo con el que creaste la cuenta.',
    });
  }
  auth.setSessionCookie(res, session);
  res.json({ user: session.user });
}));

/** Alta de cuenta desde la pagina publica. */
router.post('/auth/register', wrap(async (req, res) => {
  const permission = await users.canRegister(req.body?.code);
  if (!permission.ok) return res.status(403).json({ error: permission.reason });

  const created = await users.create({
    username: req.body?.user,
    password: req.body?.password,
    name: req.body?.name,
    role: permission.role,
  });
  auth.setSessionCookie(res, { user: created.username, exp: Date.now() + 12 * 3600 * 1000 });
  res.status(201).json({ user: created.username, role: created.role });
}));

/** Le dice a la pagina si el registro esta abierto y si pedira codigo. */
router.get('/auth/signup-state', wrap(async (req, res) => {
  const total = await users.count();
  res.json({
    first_account: total === 0,
    code_required: Boolean(config.signupCode),
    open: total === 0 || Boolean(config.signupCode),
  });
}));

router.post('/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  if (config.allowAnonymous) return res.json({ user: 'local', auth_required: false });
  const session = auth.verify(auth.parseCookies(req.headers.cookie)[auth.COOKIE]);
  if (!session) return res.status(401).json({ error: 'No autenticado', auth_required: true });
  res.json({ user: session.user, auth_required: true });
});

router.use(auth.requireAuth);

/* ------------------------------ catalogo -------------------------------- */

router.get('/catalog', wrap(async (req, res) => {
  const countries = await db.all(
    'SELECT * FROM countries WHERE active = 1 ORDER BY sort_order, name'
  );
  const banks = await db.all('SELECT * FROM banks WHERE active = 1 ORDER BY name');
  const banksByCountry = {};
  for (const b of banks) {
    (banksByCountry[b.country_id] ||= []).push(b.name);
  }
  res.json({
    countries: countries.map((c) => ({ ...c, decimals: currencies.decimalsFor(c.currency) })),
    banks: banksByCountry,
    currencies: currencies.list(),
    today: ops.today(),
    telegram_enabled: config.telegramEnabled,
    storage_ephemeral: config.ephemeralStorage,
    user: req.user,
  });
}));

/** Alta de pais: cubre el "otros paises" que hoy no existe en los grupos. */
router.post('/countries', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new ValidationError('El pais necesita un nombre');
  const id = slugify(req.body?.id || name);
  if (!id) throw new ValidationError('Nombre de pais invalido');
  const currency = String(req.body?.currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3,5}$/.test(currency)) {
    throw new ValidationError('Codigo de moneda invalido (ej: COP, PEN, USD)');
  }
  if (await db.get('SELECT 1 FROM countries WHERE id = ?', [id])) {
    throw new ValidationError(`Ya existe un pais con el identificador "${id}"`);
  }
  const { m: maxOrder } = await db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM countries');
  await db.run(
    `INSERT INTO countries (id, name, emoji, currency, telegram_chat_id,
       telegram_thread_id, color, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name,
     String(req.body?.emoji || '🌎').slice(0, 8),
     currency,
     String(req.body?.telegram_chat_id || '').trim(),
     String(req.body?.telegram_thread_id || '').trim(),
     String(req.body?.color || '#3f51b5').slice(0, 12),
     Number(maxOrder) + 10,
     new Date().toISOString()]
  );
  await ops.audit(req.user, 'COUNTRY_CREATE', null, id);
  res.status(201).json(await db.get('SELECT * FROM countries WHERE id = ?', [id]));
}));

router.patch('/countries/:id', wrap(async (req, res) => {
  const current = await db.get('SELECT * FROM countries WHERE id = ?', [req.params.id]);
  if (!current) throw new ValidationError('Pais no encontrado');
  const fields = ['name', 'emoji', 'currency', 'telegram_chat_id', 'telegram_thread_id',
                  'color', 'active', 'sort_order', 'is_origin', 'is_destination'];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (!(f in (req.body || {}))) continue;
    let v = req.body[f];
    if (['active', 'sort_order', 'is_origin', 'is_destination'].includes(f)) v = Number(v) || 0;
    else if (f === 'currency') v = String(v).trim().toUpperCase();
    else v = String(v ?? '').trim();
    sets.push(`${f} = ?`);
    params.push(v);
  }
  if (!sets.length) return res.json(current);
  params.push(req.params.id);
  await db.run(`UPDATE countries SET ${sets.join(', ')} WHERE id = ?`, params);
  await ops.audit(req.user, 'COUNTRY_UPDATE', null, req.params.id);
  res.json(await db.get('SELECT * FROM countries WHERE id = ?', [req.params.id]));
}));

router.post('/countries/:id/banks', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new ValidationError('El banco necesita un nombre');
  if (!await db.get('SELECT 1 FROM countries WHERE id = ?', [req.params.id])) {
    throw new ValidationError('Pais no encontrado');
  }
  await db.run('INSERT INTO banks (country_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING',
    [req.params.id, name]);
  res.status(201).json({ country_id: req.params.id, name });
}));

/* ----------------------------- operaciones ------------------------------ */

/** Calculo en vivo: el formulario lo llama mientras se escribe monto y tasa. */
router.post('/operations/preview', wrap(async (req, res) => {
  res.json(await ops.preview(req.body || {}));
}));

/**
 * Vista previa del mensaje de Telegram para una operacion que todavia no se
 * guarda, para poder revisarla antes de crear nada.
 */
router.post('/operations/preview-message', wrap(async (req, res) => {
  const built = await ops.buildOperation(req.body || {}, req.user);
  const draft = {
    ...built,
    folio: `${built.op_date.replace(/-/g, '')}-nueva`,
    origin_country: await ops.getCountry(built.origin_country_id),
    dest_country: await ops.getCountry(built.dest_country_id),
  };
  const { chatId } = telegram.resolveChat(draft.origin_country);
  res.json({ text: await telegram.renderForOperation(draft), chat_id: chatId });
}));

router.get('/operations', wrap(async (req, res) => {
  res.json({
    operations: await ops.listOperations({
      from: req.query.from, to: req.query.to, country: req.query.country,
      status: req.query.status, limit: Number(req.query.limit || 200),
      offset: Number(req.query.offset || 0),
    }),
  });
}));

router.get('/operations/:id', wrap(async (req, res) => {
  const op = await ops.getOperation(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operacion no encontrada' });
  res.json(op);
}));

router.post('/operations', wrap(async (req, res) => {
  const built = await ops.buildOperation(req.body || {}, req.user);
  const id = await ops.insertOperation(built);
  res.status(201).json(await ops.getOperation(id));
}));

router.put('/operations/:id', wrap(async (req, res) => {
  const built = await ops.buildOperation(req.body || {}, req.user);
  await ops.updateOperation(Number(req.params.id), built);
  res.json(await ops.getOperation(req.params.id));
}));

/** Vista previa del mensaje tal cual llegara al grupo, antes de enviar. */
router.get('/operations/:id/preview-message', wrap(async (req, res) => {
  const op = await ops.getOperation(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operacion no encontrada' });
  const { chatId } = telegram.resolveChat(op.origin_country);
  res.json({ text: await telegram.renderForOperation(op), chat_id: chatId });
}));

/** Boton ENVIAR: manda la notificacion al grupo del pais y marca la operacion. */
router.post('/operations/:id/send', wrap(async (req, res) => {
  const op = await ops.getOperation(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operacion no encontrada' });
  if (op.status === 'CANCELLED') throw new ValidationError('La operacion esta anulada');
  if (op.status === 'SENT' && !req.body?.resend) {
    return res.status(409).json({
      error: 'Esta operacion ya fue enviada. Marca "reenviar" si quieres mandarla otra vez.',
      operation: op,
    });
  }

  const result = await telegram.sendOperation(op);
  if (!result.sent) {
    await ops.audit(req.user, 'SEND_FAILED', op.id, result.reason);
    return res.status(502).json({ error: result.reason, text: result.text, operation: op });
  }
  await ops.markSent(op.id, { chatId: result.chatId, messageId: result.messageId });
  await ops.audit(req.user, 'SENT', op.id, `chat=${result.chatId} msg=${result.messageId}`);
  res.json({ ok: true, text: result.text, operation: await ops.getOperation(op.id) });
}));

router.post('/operations/:id/status', wrap(async (req, res) => {
  await ops.setStatus(Number(req.params.id), String(req.body?.status || ''), req.user);
  res.json(await ops.getOperation(req.params.id));
}));

/* ------------------------------- informe -------------------------------- */

router.get('/report', wrap(async (req, res) => {
  res.json(await report.build({
    from: req.query.from, to: req.query.to,
    country: req.query.country, status: req.query.status,
  }));
}));

router.get('/report.csv', wrap(async (req, res) => {
  const data = await report.build({
    from: req.query.from, to: req.query.to,
    country: req.query.country, status: req.query.status,
  });
  const name = `botxtar_${data.range.from || 'inicio'}_${data.range.to || 'hoy'}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('﻿' + report.toCsv(data)); // BOM para que Excel lea los acentos
}));

/* -------------------------------- ajustes ------------------------------- */

router.get('/settings/template', wrap(async (req, res) => {
  res.json({
    template: await telegram.getTemplate(),
    default: telegram.DEFAULT_TEMPLATE,
    presets: telegram.PRESETS,
  });
}));

router.put('/settings/template', wrap(async (req, res) => {
  const template = await telegram.setTemplate(req.body?.template);
  await ops.audit(req.user, 'TEMPLATE_UPDATE', null, '');
  res.json({ template });
}));

/** Prueba una plantilla contra una operacion de muestra, sin guardar nada. */
router.post('/settings/template/preview', wrap(async (req, res) => {
  const template = String(req.body?.template ?? '') || await telegram.getTemplate();
  const sample = telegram.sampleOperation();
  if (req.body?.split) {
    sample.origin_country = { id: 'peru', name: 'Peru', emoji: '🇵🇪' };
    sample.origin_country_id = 'peru';
    sample.origin_currency = 'PEN';
    sample.origin_amount = '10000.00';
    sample.rate = '1000';
    sample.dest_amount = '10000000';
    sample.transfers = [
      { position: 1, beneficiary_name: 'Ana Perez', doc_type: 'CC', doc_number: '1088354953',
        bank_name: 'Bancolombia', account_number: '11548736279', account_type: 'AHORROS',
        amount: '3000000', currency: 'COP', reference: '' },
      { position: 2, beneficiary_name: 'Luis Gomez', doc_type: 'CC', doc_number: '1020304050',
        bank_name: 'Nequi', account_number: '3001234567', account_type: 'DIGITAL',
        amount: '3000000', currency: 'COP', reference: '' },
      { position: 3, beneficiary_name: 'Sara Diaz', doc_type: 'CE', doc_number: '778899',
        bank_name: 'Davivienda', account_number: '9876543210', account_type: 'CORRIENTE',
        amount: '4000000', currency: 'COP', reference: '' },
    ];
    sample.usdt_sales = [{
      position: 1, quantity: '2500.00', unit_price: '4000', currency: 'COP',
      gross_amount: '10000000', network: 'TRON', counterparty: 'Binance', wallet: '', reference: '',
    }];
  }
  try {
    res.json({ text: telegram.renderMessage(sample, { template }) });
  } catch (err) {
    throw new ValidationError(`La plantilla tiene un error: ${err.message}`);
  }
}));

router.get('/telegram/status', wrap(async (req, res) => {
  const status = await telegram.getMe();
  const countries = await db.all(
    'SELECT id, name, emoji, telegram_chat_id FROM countries WHERE active = 1 ORDER BY sort_order'
  );
  res.json({
    ...status,
    fallback_chat_id: config.telegram.fallbackChatId,
    countries: countries.map((c) => ({
      ...c,
      configured: Boolean(c.telegram_chat_id || config.telegram.fallbackChatId),
    })),
  });
}));

module.exports = router;
