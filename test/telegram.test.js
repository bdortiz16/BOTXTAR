'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-tg-'));
process.env.DB_FILE = path.join(tmp, 'tg.db');
process.env.TIMEZONE = 'America/Bogota';

const telegram = require('../src/telegram');

const NOW = new Date('2026-08-20T18:40:50Z'); // 13:40:50 en Bogota

test('la fecha y hora salen como las escribe el bot actual', () => {
  assert.strictEqual(telegram.formatDateTime(NOW), '20/8/2026 13:40:50');
});

test('el formato "como hoy" reproduce el mensaje de los grupos', () => {
  const op = telegram.sampleOperation();
  const text = telegram.renderMessage(op, { template: telegram.PRESETS.clasico, now: NOW });
  assert.strictEqual(text, [
    'NUEVO PAGO 📍: 20/8/2026 13:40:50',
    '',
    'Monto: 5100',
    '',
    'BANCOLOMBIA',
    'Juan Ramirez',
    'AHORROS',
    '11548736279',
    'CEDULA',
    '1088354953',
    '',
    '2876400',
  ].join('\n'));
});

test('el formato mejorado agrega lo que hoy no se ve', () => {
  const op = telegram.sampleOperation();
  const text = telegram.renderMessage(op, { template: telegram.PRESETS.mejorado, now: NOW });
  assert.match(text, /NUEVO PAGO/);
  assert.match(text, /<code>20260820-007<\/code>/);   // referencia para citar el pago
  assert.match(text, /Tasa: <b>564<\/b>/);            // la tasa hoy no aparece
  assert.match(text, /5\.100,00 BRL/);                // moneda de origen explicita
  assert.match(text, /2\.876\.400 COP/);              // total con moneda
  assert.match(text, /Brasil ➡️ 🇨🇴 Colombia/);
});

test('cuenta y documento van en <code> para copiarlos de un toque', () => {
  const op = telegram.sampleOperation();
  const text = telegram.renderMessage(op, { template: telegram.PRESETS.mejorado, now: NOW });
  assert.match(text, /<code>11548736279<\/code>/);
  assert.match(text, /<code>1088354953<\/code>/);
});

test('el fraccionamiento se numera y suma el total', () => {
  const op = telegram.sampleOperation();
  op.dest_amount = '10000000';
  op.transfers = [
    { beneficiary_name: 'Ana Perez', bank_name: 'Bancolombia', account_type: 'AHORROS',
      account_number: '111', doc_type: 'CC', doc_number: '1', amount: '3000000', currency: 'COP' },
    { beneficiary_name: 'Luis Gomez', bank_name: 'Nequi', account_type: 'DIGITAL',
      account_number: '222', doc_type: 'CC', doc_number: '2', amount: '3000000', currency: 'COP' },
    { beneficiary_name: 'Sara Diaz', bank_name: 'Davivienda', account_type: 'CORRIENTE',
      account_number: '333', doc_type: 'CE', doc_number: '3', amount: '4000000', currency: 'COP' },
  ];
  const text = telegram.renderMessage(op, { template: telegram.PRESETS.mejorado, now: NOW });
  assert.match(text, /REPARTIDO EN 3 CUENTAS/);
  assert.match(text, /1\/3/);
  assert.match(text, /3\/3/);
  assert.match(text, /CEDULA EXTRANJERIA/);
});

test('la entrega en efectivo dice donde', () => {
  const op = telegram.sampleOperation();
  op.delivery_type = 'CASH';
  op.transfers = [];
  op.cash_deliveries = [{
    city: 'Medellin', address: 'El Poblado, Cra 43A', contact_name: 'Pedro Ruiz',
    contact_phone: '3001234567', doc_type: 'CC', doc_number: '123', scheduled_at: 'hoy 3:00 pm',
    amount: '2876400', currency: 'COP',
  }];
  const text = telegram.renderMessage(op, { template: telegram.PRESETS.mejorado, now: NOW });
  assert.match(text, /MEDELLIN/);
  assert.match(text, /El Poblado/);
  assert.match(text, /hoy 3:00 pm/);
});

test('el texto del cliente se escapa: no rompe el HTML de Telegram', () => {
  const op = telegram.sampleOperation();
  op.client_name = 'Ana <b>rara</b> & cia';
  const text = telegram.renderMessage(op, { template: telegram.PRESETS.mejorado, now: NOW });
  assert.match(text, /Ana &lt;b&gt;rara&lt;\/b&gt; &amp; cia/);
});

test('una plantilla vacia vuelve al formato por defecto', () => {
  assert.strictEqual(telegram.setTemplate(''), telegram.DEFAULT_TEMPLATE);
  assert.strictEqual(telegram.setTemplate('   hola {{folio}}'), '   hola {{folio}}');
  telegram.setTemplate('');
});
