'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Cada corrida usa su propia base para no ensuciar la de trabajo.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.ADMIN_PASSWORD = 'test';

const money = require('../src/money');
const { init } = require('../src/db');
const ops = require('../src/operations');
const telegram = require('../src/telegram');
const report = require('../src/report');

test.before(async () => { await init(); });

/** El caso que se hace todos los dias: 10.000 soles a tasa 1.000. */
const BASE = {
  op_date: '2026-08-21',
  origin_country_id: 'peru',
  dest_country_id: 'colombia',
  origin_amount: '10.000',
  rate: '1.000',
  rate_mode: 'MULTIPLY',
  delivery_type: 'TRANSFER',
};

test('el sistema calcula el monto a pagar sin que nadie lo escriba', async () => {
  const calc = await ops.preview(BASE);
  assert.strictEqual(calc.dest_amount, '10000000');
  assert.strictEqual(calc.dest_currency, 'COP');
  assert.strictEqual(calc.dest_amount_display, '10.000.000');
  assert.strictEqual(calc.origin_currency, 'PEN');
});

test('la tasa tambien puede ser division', async () => {
  const calc = await ops.preview({ ...BASE, origin_amount: '1000', rate: '4', rate_mode: 'DIVIDE' });
  assert.strictEqual(calc.dest_amount, '250');
});

test('rechaza monto o tasa en cero', async () => {
  await assert.rejects(() => ops.preview({ ...BASE, origin_amount: '0' }), /MONTO/);
  await assert.rejects(() => ops.preview({ ...BASE, rate: '0' }), /TASA/);
});

test('el fraccionamiento debe cuadrar exacto con el total', () => {
  const total = money.parseAmount('10000000');
  // 3.000.000 + 3.000.000 + 3.000.000 deja 1.000.000 sin repartir.
  assert.throws(
    () => ops.validateSplit(
      [{ amount: '3000000' }, { amount: '3000000' }, { amount: '3000000' }], total, 'COP'
    ),
    /Falta repartir 1\.000\.000/
  );
  // Pasarse tambien se bloquea.
  assert.throws(
    () => ops.validateSplit([{ amount: '9000000' }, { amount: '2000000' }], total, 'COP'),
    /Te pasaste por 1\.000\.000/
  );
  // Repartido exacto: pasa.
  assert.doesNotThrow(() => ops.validateSplit(
    [{ amount: '3000000' }, { amount: '3000000' }, { amount: '4000000' }], total, 'COP'
  ));
});

test('guarda una operacion fraccionada en 3 cuentas y la recupera entera', async () => {
  const built = await ops.buildOperation({
    ...BASE,
    client_name: 'Cliente demo',
    destinations: [
      { beneficiary_name: 'Ana Perez', doc_type: 'CC', doc_number: '111', bank_name: 'Bancolombia',
        account_number: '1234567890', account_type: 'AHORROS', amount: '3.000.000' },
      { beneficiary_name: 'Luis Gomez', doc_type: 'CC', doc_number: '222', bank_name: 'Nequi',
        account_number: '3001234567', account_type: 'DIGITAL', amount: '3.000.000' },
      { beneficiary_name: 'Sara Diaz', doc_type: 'CE', doc_number: '333', bank_name: 'Davivienda',
        account_number: '9876543210', account_type: 'CORRIENTE', amount: '4.000.000' },
    ],
    usdt_sales: [{ quantity: '2500', unit_price: '4000', currency: 'COP', network: 'TRON' }],
  }, 'bryan');

  const id = await ops.insertOperation(built);
  const op = await ops.getOperation(id);

  assert.strictEqual(op.transfers.length, 3);
  assert.strictEqual(op.dest_amount, '10000000');
  assert.strictEqual(op.usdt_sales.length, 1);
  assert.strictEqual(op.usdt_sales[0].gross_amount, '10000000');
  assert.strictEqual(op.status, 'DRAFT');
  assert.match(op.folio, /^20260821-\d{3}$/);

  const suma = op.transfers.reduce((acc, t) => acc + money.parseAmount(t.amount), 0n);
  assert.strictEqual(money.toDecimalString(suma, 0), '10000000');
});

test('una operacion sin nombre de beneficiario no pasa', async () => {
  await assert.rejects(() => ops.buildOperation({
    ...BASE,
    destinations: [{ beneficiary_name: '', amount: '10000000' }],
  }, 'bryan'), /NOMBRE/);
});

test('la entrega en efectivo exige ciudad', async () => {
  await assert.rejects(() => ops.buildOperation({
    ...BASE, delivery_type: 'CASH',
    destinations: [{ city: '', amount: '10000000' }],
  }, 'bryan'), /CIUDAD/);

  await assert.doesNotReject(() => ops.buildOperation({
    ...BASE, delivery_type: 'CASH',
    destinations: [{ city: 'Bogota', address: 'Cra 7', amount: '10000000' }],
  }, 'bryan'));
});

test('el mensaje de Telegram trae las 3 cuentas y la venta de USDT', async () => {
  const op = (await ops.listOperations({ limit: 1 }))[0];
  const full = await ops.getOperation(op.id);
  const text = await telegram.renderForOperation(full);

  assert.match(text, /10\.000,00 PEN/);
  assert.match(text, /10\.000\.000 COP/);
  assert.match(text, /REPARTIDO EN 3 CUENTAS/);
  assert.match(text, /Ana Perez/);
  assert.match(text, /Sara Diaz/);
  assert.match(text, /VENTA USDT/);
  assert.match(text, /2\.500,00 USDT/);
});

test('el informe suma por moneda y no mezcla soles con pesos', async () => {
  const rep = await report.build({ from: '2026-08-21', to: '2026-08-21' });
  const recibido = Object.fromEntries(rep.totals.received.map((r) => [r.currency, r.amount]));
  const pagado = Object.fromEntries(rep.totals.paid.map((r) => [r.currency, r.amount]));
  assert.strictEqual(recibido.PEN, '10000.00');
  assert.strictEqual(pagado.COP, '10000000');
  assert.strictEqual(rep.totals.usdt.quantity, '2500.00');
});

test('las operaciones anuladas salen del informe', async () => {
  const op = (await ops.listOperations({ limit: 1 }))[0];
  await ops.setStatus(op.id, 'CANCELLED', 'bryan');
  const rep = await report.build({ from: '2026-08-21', to: '2026-08-21' });
  assert.strictEqual(rep.totals.operations, 0);
  assert.strictEqual(rep.totals.cancelled, 1);
  await ops.setStatus(op.id, 'DRAFT', 'bryan');
});

test('el CSV trae una fila por cuenta destino', async () => {
  const rep = await report.build({ from: '2026-08-21', to: '2026-08-21' });
  const csv = report.toCsv(rep);
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines.length, 4); // cabecera + 3 cuentas
  assert.match(lines[1], /Ana Perez/);
});
