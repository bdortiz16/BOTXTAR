'use strict';

const { db } = require('./db');
const money = require('./money');
const currencies = require('./currencies');
const config = require('./config');
const { ValidationError } = money;

const DELIVERY_TYPES = ['TRANSFER', 'CASH'];
const RATE_MODES = ['MULTIPLY', 'DIVIDE'];
const STATUSES = ['DRAFT', 'SENT', 'COMPLETED', 'CANCELLED'];

/** Fecha de hoy (YYYY-MM-DD) en la zona horaria de la operacion. */
function today(tz = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function str(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

async function getCountry(id) {
  const row = await db.get('SELECT * FROM countries WHERE id = ?', [str(id, 60)]);
  if (!row) throw new ValidationError(`Pais desconocido: ${id}`);
  return row;
}

/**
 * Calcula el monto destino a partir de monto origen y tasa.
 *
 * Es la pieza central del cambio pedido: el operador ya no escribe el total,
 * el sistema lo calcula. En el ejemplo del negocio 10.000 PEN a tasa 1.000
 * da 10.000.000 COP.
 */
function computeDestAmount({ originAmount, rate, rateMode, destCurrency }) {
  const decimals = currencies.decimalsFor(destCurrency);
  const raw = rateMode === 'DIVIDE'
    ? money.divide(originAmount, rate)
    : money.multiply(originAmount, rate);
  return money.roundScaled(raw, decimals);
}

/** Cuantos decimales significativos tiene una tasa (para no mostrar 1.000,00000000). */
function rateTrailingDecimals(rate) {
  const s = money.toDecimalString(rate, 8);
  const frac = (s.split('.')[1] || '').replace(/0+$/, '');
  return Math.min(Math.max(frac.length, 0), 8);
}

/**
 * Vista previa del calculo, sin guardar nada. La usa el formulario para
 * mostrar el total en vivo mientras se escribe el monto y la tasa.
 */
async function preview(input) {
  const originCountry = await getCountry(input.origin_country_id);
  const destCountry = await getCountry(input.dest_country_id || 'colombia');
  const originCurrency = str(input.origin_currency, 10).toUpperCase() || originCountry.currency;
  const destCurrency = str(input.dest_currency, 10).toUpperCase() || destCountry.currency;

  const originAmount = money.requireAmount(input.origin_amount, 'MONTO');
  const rate = money.requireAmount(input.rate, 'TASA');
  if (!money.isPositive(originAmount)) throw new ValidationError('El MONTO debe ser mayor a 0');
  if (!money.isPositive(rate)) throw new ValidationError('La TASA debe ser mayor a 0');

  const rateMode = RATE_MODES.includes(input.rate_mode) ? input.rate_mode : 'MULTIPLY';
  const destAmount = computeDestAmount({ originAmount, rate, rateMode, destCurrency });

  const originDecimals = currencies.decimalsFor(originCurrency);
  const destDecimals = currencies.decimalsFor(destCurrency);

  return {
    origin_country: originCountry.id,
    origin_currency: originCurrency,
    origin_amount: money.toDecimalString(originAmount, originDecimals),
    origin_amount_display: money.formatAmount(originAmount, originDecimals),
    rate: money.toDecimalString(rate, 8).replace(/0+$/, '').replace(/\.$/, ''),
    rate_display: money.formatAmount(rate, rateTrailingDecimals(rate)),
    rate_mode: rateMode,
    dest_country: destCountry.id,
    dest_currency: destCurrency,
    dest_amount: money.toDecimalString(destAmount, destDecimals),
    dest_amount_display: money.formatAmount(destAmount, destDecimals),
    dest_decimals: destDecimals,
  };
}

/**
 * Valida el reparto (fraccionamiento) contra el total calculado.
 *
 * Este es el control que faltaba en el formulario de Google: si el cliente
 * pide 10.000.000 COP repartidos en 3 cuentas, la suma de las 3 tiene que dar
 * exactamente 10.000.000. La UI muestra el restante en vivo; aqui se bloquea.
 */
function validateSplit(destinations, destAmountScaled, destCurrency) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new ValidationError('Debes agregar al menos un destino');
  }
  const decimals = currencies.decimalsFor(destCurrency);
  const amounts = destinations.map((d, i) => {
    const v = money.requireAmount(d.amount, `MONTO del destino ${i + 1}`);
    if (!money.isPositive(v)) {
      throw new ValidationError(`El MONTO del destino ${i + 1} debe ser mayor a 0`);
    }
    return money.roundScaled(v, decimals);
  });
  const total = money.sum(amounts);
  const diff = destAmountScaled - total;
  if (!money.isZero(diff)) {
    const suma = money.formatAmount(total, decimals);
    const esperado = money.formatAmount(destAmountScaled, decimals);
    throw new ValidationError(
      diff > 0n
        ? `Falta repartir ${money.formatAmount(diff, decimals)} ${destCurrency}. Repartido: ${suma} de ${esperado}.`
        : `Te pasaste por ${money.formatAmount(-diff, decimals)} ${destCurrency}. Repartido: ${suma} de ${esperado}.`
    );
  }
  return amounts;
}

function normalizeTransfer(d, i, currency, amountScaled, decimals) {
  const name = str(d.beneficiary_name, 120);
  if (!name) throw new ValidationError(`Falta el NOMBRE del beneficiario en el destino ${i + 1}`);
  return {
    position: i + 1,
    beneficiary_name: name,
    doc_type: str(d.doc_type, 20).toUpperCase(),
    doc_number: str(d.doc_number, 40),
    bank_name: str(d.bank_name, 80),
    account_number: str(d.account_number, 60),
    account_type: str(d.account_type, 20).toUpperCase(),
    amount: money.toDecimalString(amountScaled, decimals),
    currency,
    reference: str(d.reference, 120),
    status: 'PENDING',
  };
}

function normalizeCash(d, i, currency, amountScaled, decimals) {
  const city = str(d.city, 80);
  if (!city) throw new ValidationError(`Falta la CIUDAD de la entrega ${i + 1}`);
  return {
    position: i + 1,
    city,
    address: str(d.address, 200),
    contact_name: str(d.contact_name, 120),
    contact_phone: str(d.contact_phone, 40),
    doc_type: str(d.doc_type, 20).toUpperCase(),
    doc_number: str(d.doc_number, 40),
    scheduled_at: str(d.scheduled_at, 40),
    amount: money.toDecimalString(amountScaled, decimals),
    currency,
    reference: str(d.reference, 120),
    status: 'PENDING',
  };
}

/** Venta de USDT asociada a la operacion (opcional, puede haber varias). */
function normalizeUsdt(s, i) {
  const quantity = money.requireAmount(s.quantity, `CANTIDAD USDT ${i + 1}`);
  const unitPrice = money.requireAmount(s.unit_price, `PRECIO USDT ${i + 1}`);
  if (!money.isPositive(quantity)) throw new ValidationError(`La CANTIDAD de USDT ${i + 1} debe ser mayor a 0`);
  if (!money.isPositive(unitPrice)) throw new ValidationError(`El PRECIO de USDT ${i + 1} debe ser mayor a 0`);
  const currency = str(s.currency, 10).toUpperCase() || 'COP';
  const decimals = currencies.decimalsFor(currency);
  const gross = money.roundScaled(money.multiply(quantity, unitPrice), decimals);
  return {
    position: i + 1,
    quantity: money.toDecimalString(quantity, 2),
    unit_price: money.toDecimalString(unitPrice, 8).replace(/0+$/, '').replace(/\.$/, ''),
    currency,
    gross_amount: money.toDecimalString(gross, decimals),
    network: str(s.network, 20).toUpperCase(),
    wallet: str(s.wallet, 120),
    counterparty: str(s.counterparty, 120),
    reference: str(s.reference, 120),
  };
}

/** Consecutivo del dia: 20260821-001. Salta los folios ya usados. */
async function nextFolio(opDate, conn = db) {
  const compact = opDate.replace(/-/g, '');
  const row = await conn.get('SELECT COUNT(*) AS c FROM operations WHERE op_date = ?', [opDate]);
  let n = Number(row.c) + 1;
  let folio = `${compact}-${String(n).padStart(3, '0')}`;
  while (await conn.get('SELECT 1 FROM operations WHERE folio = ?', [folio])) {
    n += 1;
    folio = `${compact}-${String(n).padStart(3, '0')}`;
  }
  return folio;
}

/** Construye la operacion completa y validada a partir del payload del form. */
async function buildOperation(input, actor) {
  const calc = await preview(input);
  const destDecimals = calc.dest_decimals;
  const destAmountScaled = money.parseAmount(calc.dest_amount);

  const deliveryType = DELIVERY_TYPES.includes(input.delivery_type) ? input.delivery_type : null;
  if (!deliveryType) throw new ValidationError('Elige si es TRANSFERENCIA o ENTREGA DE EFECTIVO');

  const destinations = Array.isArray(input.destinations) ? input.destinations : [];
  const amounts = validateSplit(destinations, destAmountScaled, calc.dest_currency);

  const transfers = [];
  const cash = [];
  destinations.forEach((d, i) => {
    if (deliveryType === 'TRANSFER') {
      transfers.push(normalizeTransfer(d, i, calc.dest_currency, amounts[i], destDecimals));
    } else {
      cash.push(normalizeCash(d, i, calc.dest_currency, amounts[i], destDecimals));
    }
  });

  const usdtInput = Array.isArray(input.usdt_sales) ? input.usdt_sales : [];
  const usdt = usdtInput
    .filter((s) => s && (s.quantity || s.unit_price))
    .map((s, i) => normalizeUsdt(s, i));

  const opDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.op_date || '')) ? input.op_date : today();

  return {
    op_date: opDate,
    origin_country_id: calc.origin_country,
    origin_currency: calc.origin_currency,
    origin_amount: calc.origin_amount,
    rate: calc.rate,
    rate_mode: calc.rate_mode,
    dest_country_id: calc.dest_country,
    dest_currency: calc.dest_currency,
    dest_amount: calc.dest_amount,
    delivery_type: deliveryType,
    client_name: str(input.client_name, 120),
    client_contact: str(input.client_contact, 80),
    notes: str(input.notes, 1000),
    created_by: str(actor, 60),
    transfers,
    cash_deliveries: cash,
    usdt_sales: usdt,
  };
}

async function insertChildren(conn, id, op) {
  for (const t of op.transfers) {
    await conn.run(
      `INSERT INTO transfers (operation_id, position, beneficiary_name, doc_type, doc_number,
        bank_name, account_number, account_type, amount, currency, reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t.position, t.beneficiary_name, t.doc_type, t.doc_number, t.bank_name,
       t.account_number, t.account_type, t.amount, t.currency, t.reference, t.status]
    );
  }
  for (const c of op.cash_deliveries) {
    await conn.run(
      `INSERT INTO cash_deliveries (operation_id, position, city, address, contact_name,
        contact_phone, doc_type, doc_number, scheduled_at, amount, currency, reference, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.position, c.city, c.address, c.contact_name, c.contact_phone, c.doc_type,
       c.doc_number, c.scheduled_at, c.amount, c.currency, c.reference, c.status]
    );
  }
  for (const u of op.usdt_sales) {
    await conn.run(
      `INSERT INTO usdt_sales (operation_id, position, quantity, unit_price, currency,
        gross_amount, network, wallet, counterparty, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, u.position, u.quantity, u.unit_price, u.currency, u.gross_amount,
       u.network, u.wallet, u.counterparty, u.reference]
    );
  }
}

/**
 * Guarda la operacion y sus destinos en una sola transaccion: si algo falla a
 * mitad, no queda una operacion con la mitad de las cuentas.
 */
async function insertOperation(op) {
  return db.tx(async (conn) => {
    const now = new Date().toISOString();
    const folio = await nextFolio(op.op_date, conn);

    const row = await conn.get(
      `INSERT INTO operations (
         folio, op_date, origin_country_id, origin_currency, origin_amount,
         rate, rate_mode, dest_country_id, dest_currency, dest_amount,
         delivery_type, client_name, client_contact, notes, status,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
       RETURNING id`,
      [folio, op.op_date, op.origin_country_id, op.origin_currency, op.origin_amount,
       op.rate, op.rate_mode, op.dest_country_id, op.dest_currency, op.dest_amount,
       op.delivery_type, op.client_name, op.client_contact, op.notes,
       op.created_by, now, now]
    );
    const id = Number(row.id);

    await insertChildren(conn, id, op);
    await audit(op.created_by, 'CREATE', id, `folio=${folio}`, conn);
    return id;
  });
}

async function updateOperation(id, op) {
  const current = await getOperation(id);
  if (!current) throw new ValidationError('Operacion no encontrada');
  if (current.status === 'CANCELLED') {
    throw new ValidationError('No se puede editar una operacion anulada');
  }

  return db.tx(async (conn) => {
    await conn.run(
      `UPDATE operations SET op_date=?, origin_country_id=?, origin_currency=?, origin_amount=?,
         rate=?, rate_mode=?, dest_country_id=?, dest_currency=?, dest_amount=?, delivery_type=?,
         client_name=?, client_contact=?, notes=?, updated_at=?
       WHERE id=?`,
      [op.op_date, op.origin_country_id, op.origin_currency, op.origin_amount,
       op.rate, op.rate_mode, op.dest_country_id, op.dest_currency, op.dest_amount,
       op.delivery_type, op.client_name, op.client_contact, op.notes,
       new Date().toISOString(), id]
    );
    for (const table of ['transfers', 'cash_deliveries', 'usdt_sales']) {
      await conn.run(`DELETE FROM ${table} WHERE operation_id = ?`, [id]);
    }
    await insertChildren(conn, id, op);
    await audit(op.created_by, 'UPDATE', id, '', conn);
    return id;
  });
}

/** Carga los hijos de varias operaciones de una vez, sin una consulta por fila. */
async function attachChildren(rows) {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const r of rows) {
    r.transfers = [];
    r.cash_deliveries = [];
    r.usdt_sales = [];
  }
  for (const table of ['transfers', 'cash_deliveries', 'usdt_sales']) {
    const children = await db.all(
      `SELECT * FROM ${table} WHERE operation_id IN (${marks}) ORDER BY operation_id, position`,
      ids
    );
    for (const child of children) byId.get(Number(child.operation_id))?.[table].push(child);
  }
  return rows;
}

async function getOperation(id) {
  const op = await db.get('SELECT * FROM operations WHERE id = ?', [Number(id)]);
  if (!op) return null;
  await attachChildren([op]);
  op.origin_country = await db.get('SELECT * FROM countries WHERE id=?', [op.origin_country_id]) || null;
  op.dest_country = await db.get('SELECT * FROM countries WHERE id=?', [op.dest_country_id]) || null;
  return op;
}

async function listOperations({ from, to, country, status, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('op_date >= ?'); params.push(from); }
  if (to) { where.push('op_date <= ?'); params.push(to); }
  if (country) { where.push('origin_country_id = ?'); params.push(country); }
  if (status) { where.push('status = ?'); params.push(status); }
  params.push(Number(limit), Number(offset));

  const rows = await db.all(
    `SELECT * FROM operations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY op_date DESC, id DESC LIMIT ? OFFSET ?`,
    params
  );
  return attachChildren(rows);
}

async function setStatus(id, status, actor) {
  if (!STATUSES.includes(status)) throw new ValidationError(`Estado invalido: ${status}`);
  await db.run('UPDATE operations SET status=?, updated_at=? WHERE id=?',
    [status, new Date().toISOString(), Number(id)]);
  await audit(actor, `STATUS:${status}`, Number(id), '');
}

async function markSent(id, { chatId, messageId }) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE operations SET status='SENT', sent_at=?, telegram_chat_id=?,
       telegram_message_id=?, updated_at=? WHERE id=?`,
    [now, String(chatId || ''), String(messageId || ''), now, Number(id)]
  );
}

async function audit(actor, action, operationId, detail, conn = db) {
  await conn.run(
    'INSERT INTO audit_log (at, actor, action, operation_id, detail) VALUES (?,?,?,?,?)',
    [new Date().toISOString(), String(actor || ''), action, operationId ?? null, String(detail || '')]
  );
}

module.exports = {
  DELIVERY_TYPES, RATE_MODES, STATUSES,
  today, getCountry, computeDestAmount, preview, validateSplit,
  buildOperation, insertOperation, updateOperation, getOperation,
  listOperations, setStatus, markSent, audit, nextFolio,
};
