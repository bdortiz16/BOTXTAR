'use strict';

const { db } = require('./db');
const money = require('./money');
const currencies = require('./currencies');
const ops = require('./operations');

/** Acumulador por moneda: evita mezclar soles con pesos en el mismo total. */
function bucket(map, currency, scaled) {
  const key = currency || '?';
  map.set(key, (map.get(key) || 0n) + scaled);
}

function dump(map) {
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, scaled]) => ({
      currency,
      amount: money.toDecimalString(scaled, currencies.decimalsFor(currency)),
      display: money.formatAmount(scaled, currencies.decimalsFor(currency)),
    }));
}

/**
 * Informe contable de un rango de fechas.
 *
 * Devuelve totales por moneda (recibido y pagado), desglose por pais, por tipo
 * de entrega y el resumen de USDT vendidos. Las operaciones anuladas no suman.
 */
async function build({ from, to, country, status } = {}) {
  const list = await ops.listOperations({ from, to, country, status, limit: 100000 });
  const counted = list.filter((o) => o.status !== 'CANCELLED');

  const received = new Map();   // lo que entrego el cliente (moneda origen)
  const paid = new Map();       // lo que pagamos (moneda destino)
  const byCountry = new Map();
  const byDelivery = { TRANSFER: 0, CASH: 0 };
  const byStatus = {};
  let usdtQty = 0n;
  const usdtGross = new Map();
  let transferCount = 0;
  let cashCount = 0;

  for (const op of counted) {
    const originScaled = money.parseAmount(op.origin_amount) ?? 0n;
    const destScaled = money.parseAmount(op.dest_amount) ?? 0n;
    bucket(received, op.origin_currency, originScaled);
    bucket(paid, op.dest_currency, destScaled);
    byDelivery[op.delivery_type] = (byDelivery[op.delivery_type] || 0) + 1;
    transferCount += op.transfers.length;
    cashCount += op.cash_deliveries.length;

    if (!byCountry.has(op.origin_country_id)) {
      byCountry.set(op.origin_country_id, {
        country_id: op.origin_country_id,
        operations: 0,
        received: new Map(),
        paid: new Map(),
      });
    }
    const c = byCountry.get(op.origin_country_id);
    c.operations += 1;
    bucket(c.received, op.origin_currency, originScaled);
    bucket(c.paid, op.dest_currency, destScaled);

    for (const u of op.usdt_sales) {
      usdtQty += money.parseAmount(u.quantity) ?? 0n;
      bucket(usdtGross, u.currency, money.parseAmount(u.gross_amount) ?? 0n);
    }
  }

  for (const op of list) {
    byStatus[op.status] = (byStatus[op.status] || 0) + 1;
  }

  const names = new Map(
    (await db.all('SELECT id, name, emoji FROM countries')).map((r) => [r.id, r])
  );

  return {
    range: { from: from || null, to: to || null, country: country || null, status: status || null },
    totals: {
      operations: counted.length,
      cancelled: list.length - counted.length,
      received: dump(received),
      paid: dump(paid),
      transfers: transferCount,
      cash_deliveries: cashCount,
      by_delivery: byDelivery,
      by_status: byStatus,
      usdt: {
        quantity: money.toDecimalString(usdtQty, 2),
        quantity_display: money.formatAmount(usdtQty, 2),
        gross: dump(usdtGross),
      },
    },
    by_country: [...byCountry.values()]
      .map((c) => ({
        country_id: c.country_id,
        name: names.get(c.country_id)?.name || c.country_id,
        emoji: names.get(c.country_id)?.emoji || '',
        operations: c.operations,
        received: dump(c.received),
        paid: dump(c.paid),
      }))
      .sort((a, b) => b.operations - a.operations),
    operations: list,
  };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Exporta una fila por destino (no por operacion), que es como se concilia
 * contra los extractos bancarios.
 */
function toCsv(report) {
  const header = [
    'folio', 'fecha', 'estado', 'pais_origen', 'moneda_origen', 'monto_origen',
    'tasa', 'modo_tasa', 'pais_destino', 'moneda_destino', 'monto_destino_total',
    'tipo_entrega', 'cliente', 'destino_n', 'beneficiario', 'documento',
    'banco_o_ciudad', 'cuenta_o_direccion', 'tipo_cuenta', 'monto_destino',
    'usdt_cantidad', 'usdt_precio', 'usdt_total', 'operador', 'notas',
  ];
  const rows = [header.join(',')];

  for (const op of report.operations) {
    const base = [
      op.folio, op.op_date, op.status, op.origin_country_id, op.origin_currency,
      op.origin_amount, op.rate, op.rate_mode, op.dest_country_id, op.dest_currency,
      op.dest_amount, op.delivery_type, op.client_name,
    ];
    const usdtQty = op.usdt_sales.map((u) => u.quantity).join(' | ');
    const usdtPrice = op.usdt_sales.map((u) => u.unit_price).join(' | ');
    const usdtTotal = op.usdt_sales.map((u) => `${u.gross_amount} ${u.currency}`).join(' | ');

    const dests = op.delivery_type === 'TRANSFER'
      ? op.transfers.map((t) => [
          t.position, t.beneficiary_name, `${t.doc_type} ${t.doc_number}`.trim(),
          t.bank_name, t.account_number, t.account_type, t.amount,
        ])
      : op.cash_deliveries.map((c) => [
          c.position, c.contact_name, `${c.doc_type} ${c.doc_number}`.trim(),
          c.city, c.address, '', c.amount,
        ]);

    if (dests.length === 0) dests.push(['', '', '', '', '', '', op.dest_amount]);

    dests.forEach((d, i) => {
      rows.push([...base, ...d,
        i === 0 ? usdtQty : '', i === 0 ? usdtPrice : '', i === 0 ? usdtTotal : '',
        op.created_by, i === 0 ? op.notes : '',
      ].map(csvCell).join(','));
    });
  }
  return rows.join('\n');
}

/**
 * Resumen para la pantalla de inicio.
 *
 * Responde las dos preguntas con las que se abre la app: como va el dia y que
 * queda pendiente. Todo sale de las mismas funciones del informe, para que un
 * numero nunca discrepe entre las dos pantallas.
 */
async function dashboard({ tz } = {}) {
  const hoy = ops.today(tz);
  const primeroDelMes = `${hoy.slice(0, 8)}01`;

  const [delDia, delMes, recientes] = await Promise.all([
    build({ from: hoy, to: hoy }),
    build({ from: primeroDelMes, to: hoy }),
    ops.listOperations({ limit: 6 }),
  ]);

  // Lo que ya se envio al grupo pero todavia nadie marco como pagado.
  const porPagar = new Map();
  let borradores = 0;
  let enviadas = 0;
  for (const op of delMes.operations) {
    if (op.status === 'DRAFT') borradores += 1;
    if (op.status === 'SENT') {
      enviadas += 1;
      bucket(porPagar, op.dest_currency, money.parseAmount(op.dest_amount) ?? 0n);
    }
  }

  return {
    today: hoy,
    month_from: primeroDelMes,
    today_totals: delDia.totals,
    month_totals: delMes.totals,
    pending: {
      drafts: borradores,
      sent_unpaid: enviadas,
      amount: dump(porPagar),
    },
    recent: recientes,
  };
}

module.exports = { build, toCsv, dashboard };
