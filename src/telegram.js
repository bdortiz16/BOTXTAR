'use strict';

const config = require('./config');
const { db } = require('./db');
const money = require('./money');
const currencies = require('./currencies');

/** Escapa texto para parse_mode=HTML de Telegram. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Etiquetas tal como se escriben en los grupos: "CEDULA", no "C.C.". */
const DOC_LABELS = {
  CC: 'CEDULA', CE: 'CEDULA EXTRANJERIA', NIT: 'NIT', PAS: 'PASAPORTE', PPT: 'PPT',
  DNI: 'DNI', RUC: 'RUC', RUT: 'RUT', CPF: 'CPF', CNPJ: 'CNPJ',
  CURP: 'CURP', RFC: 'RFC', INE: 'INE', CI: 'CI', V: 'V', E: 'E', J: 'J',
};

function docLabel(type) {
  return DOC_LABELS[String(type || '').toUpperCase()] || String(type || 'DOCUMENTO').toUpperCase();
}

/** Fecha y hora como las escribe el bot actual: "20/8/2026 13:40:50". */
function formatDateTime(date = new Date(), tz = config.timezone) {
  const parts = new Intl.DateTimeFormat('es-CO', {
    timeZone: tz, day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

/**
 * Plantillas del mensaje que llega al grupo del pais.
 *
 * "mejorado" agrega lo que hoy no se ve (referencia, tasa, moneda, total) y
 * pone cuentas y documentos en <code>, que en Telegram se copia de un toque y
 * evita que la app los convierta en enlaces de telefono.
 *
 * "clasico" reproduce exactamente el formato que llega hoy a los grupos, para
 * quien prefiera no cambiar nada.
 *
 * Marcadores: {{folio}} {{fecha}} {{fecha_hora}} {{hora}} {{pais}}
 * {{pais_destino}} {{monto_origen}} {{monto_origen_num}} {{moneda_origen}}
 * {{tasa}} {{monto_destino}} {{monto_destino_num}} {{moneda_destino}}
 * {{tipo}} {{cliente}} {{destinos}} {{destinos_simple}} {{usdt}} {{notas}}
 * {{operador}}
 */
const PRESETS = {
  mejorado: `📍 <b>NUEVO PAGO</b> · <code>{{folio}}</code>
🗓 {{fecha_hora}}
{{pais}} ➡️ {{pais_destino}}

💵 Monto: <b>{{monto_origen}} {{moneda_origen}}</b>
📈 Tasa: <b>{{tasa}}</b>
💰 Total: <b>{{monto_destino}} {{moneda_destino}}</b>
{{cliente}}

{{destinos}}
{{usdt}}
{{notas}}
👤 {{operador}}`,

  clasico: `NUEVO PAGO 📍: {{fecha_hora}}

Monto: {{monto_origen_num}}

{{destinos_simple}}`,
};

const DEFAULT_TEMPLATE = PRESETS.mejorado;

const SETTING_KEY = 'telegram_template';

async function getTemplate() {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [SETTING_KEY]);
  return row ? row.value : DEFAULT_TEMPLATE;
}

async function setTemplate(value) {
  const v = String(value ?? '').slice(0, 8000) || DEFAULT_TEMPLATE;
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [SETTING_KEY, v]
  );
  return v;
}

function fmt(decimalString, currency) {
  return money.formatAmount(money.parseAmount(decimalString) ?? 0n, currencies.decimalsFor(currency));
}

/**
 * Numero sin separadores de miles, como lo escribe el bot actual. Si los
 * decimales son todos cero se omiten: 5100.00 se escribe 5100.
 */
function plain(decimalString, currency) {
  const out = money.toDecimalString(money.parseAmount(decimalString) ?? 0n, currencies.decimalsFor(currency));
  return out.replace(/\.0+$/, '');
}

/**
 * Bloque de cuentas / puntos de entrega.
 *
 * El banco va primero y en mayuscula porque es lo que busca quien va a pagar.
 * Cuenta y documento van en <code>: en Telegram se copian de un toque y no se
 * convierten en enlaces de telefono, que es lo que pasa hoy con los numeros
 * largos.
 */
function renderDestinations(op) {
  const blocks = [];

  if (op.delivery_type === 'TRANSFER') {
    const list = op.transfers || [];
    const many = list.length > 1;
    if (many) blocks.push(`🏦 <b>REPARTIDO EN ${list.length} CUENTAS</b>`);

    list.forEach((t, i) => {
      const head = many ? `<b>${i + 1}/${list.length}</b> · ` : '🏦 ';
      const lines = [`${head}<b>${esc((t.bank_name || 'BANCO').toUpperCase())}</b>`];
      if (t.beneficiary_name) lines.push(esc(t.beneficiary_name));

      const cuenta = [
        t.account_type ? esc(t.account_type) : '',
        t.account_number ? `<code>${esc(t.account_number)}</code>` : '',
      ].filter(Boolean).join(' · ');
      if (cuenta) lines.push(cuenta);

      if (t.doc_number) lines.push(`${esc(docLabel(t.doc_type))} <code>${esc(t.doc_number)}</code>`);
      lines.push(`💸 <b>${esc(fmt(t.amount, t.currency))} ${esc(t.currency)}</b>`);
      if (t.reference) lines.push(`📝 ${esc(t.reference)}`);
      blocks.push(lines.join('\n'));
    });
  } else {
    const list = op.cash_deliveries || [];
    const many = list.length > 1;
    if (many) blocks.push(`💵 <b>${list.length} ENTREGAS EN EFECTIVO</b>`);

    list.forEach((c, i) => {
      const head = many ? `<b>${i + 1}/${list.length}</b> · ` : '💵 ';
      const lines = [`${head}<b>${esc((c.city || 'EFECTIVO').toUpperCase())}</b>`];
      if (c.address) lines.push(`📍 ${esc(c.address)}`);
      if (c.contact_name) lines.push(esc(c.contact_name));
      if (c.doc_number) lines.push(`${esc(docLabel(c.doc_type))} <code>${esc(c.doc_number)}</code>`);
      if (c.contact_phone) lines.push(`📞 <code>${esc(c.contact_phone)}</code>`);
      if (c.scheduled_at) lines.push(`🕒 ${esc(c.scheduled_at)}`);
      lines.push(`💸 <b>${esc(fmt(c.amount, c.currency))} ${esc(c.currency)}</b>`);
      if (c.reference) lines.push(`📝 ${esc(c.reference)}`);
      blocks.push(lines.join('\n'));
    });
  }
  return blocks.join('\n\n');
}

/**
 * Mismo bloque en el formato que llega hoy a los grupos: banco, nombre, tipo
 * de cuenta, numero, documento, y el monto abajo separado por una linea.
 */
function renderDestinationsSimple(op) {
  const blocks = [];

  if (op.delivery_type === 'TRANSFER') {
    for (const t of op.transfers || []) {
      const datos = [
        esc((t.bank_name || '').toUpperCase()),
        esc(t.beneficiary_name),
        esc(t.account_type),
        esc(t.account_number),
        t.doc_number ? esc(docLabel(t.doc_type)) : '',
        esc(t.doc_number),
      ].filter(Boolean);
      blocks.push(`${datos.join('\n')}\n\n${esc(plain(t.amount, t.currency))}`);
    }
  } else {
    for (const c of op.cash_deliveries || []) {
      const datos = [
        'EFECTIVO',
        esc((c.city || '').toUpperCase()),
        esc(c.address),
        esc(c.contact_name),
        c.doc_number ? esc(docLabel(c.doc_type)) : '',
        esc(c.doc_number),
        esc(c.contact_phone),
      ].filter(Boolean);
      blocks.push(`${datos.join('\n')}\n\n${esc(plain(c.amount, c.currency))}`);
    }
  }
  return blocks.join('\n\n');
}

/** Bloque de venta de USDT; vacio si la operacion no lleva cripto. */
function renderUsdt(op) {
  const list = op.usdt_sales || [];
  if (list.length === 0) return '';
  const lines = ['\n🪙 <b>VENTA USDT</b>'];
  let totalQty = 0n;
  for (const u of list) {
    totalQty += money.parseAmount(u.quantity) ?? 0n;
    const bits = [
      `• ${esc(money.formatAmount(money.parseAmount(u.quantity), 2))} USDT`,
      `× ${esc(u.unit_price)}`,
      `= <b>${esc(fmt(u.gross_amount, u.currency))} ${esc(u.currency)}</b>`,
    ];
    lines.push(bits.join(' '));
    const extra = [
      u.network ? `red ${esc(u.network)}` : '',
      u.counterparty ? `contraparte ${esc(u.counterparty)}` : '',
      u.wallet ? `<code>${esc(u.wallet)}</code>` : '',
    ].filter(Boolean);
    if (extra.length) lines.push(`   ${extra.join(' · ')}`);
  }
  if (list.length > 1) {
    lines.push(`Total: <b>${esc(money.formatAmount(totalQty, 2))} USDT</b>`);
  }
  return lines.join('\n');
}

/** Sustituye los marcadores y limpia lineas vacias sobrantes. */
function renderMessage(op, { template, now } = {}) {
  const tpl = template || DEFAULT_TEMPLATE;
  const stamp = now || (op.sent_at ? new Date(op.sent_at) : new Date());
  const fechaHora = formatDateTime(stamp);
  const originCurrency = op.origin_currency;
  const destCurrency = op.dest_currency;
  const originName = op.origin_country?.name || op.origin_country_id;
  const originEmoji = op.origin_country?.emoji || '';
  const destName = op.dest_country?.name || op.dest_country_id;
  const destEmoji = op.dest_country?.emoji || '';

  const values = {
    folio: esc(op.folio),
    fecha: esc(op.op_date),
    fecha_hora: esc(fechaHora),
    hora: esc(fechaHora.split(' ')[1] || ''),
    pais: esc(`${originEmoji} ${originName}`.trim()),
    pais_destino: esc(`${destEmoji} ${destName}`.trim()),
    monto_origen: esc(fmt(op.origin_amount, originCurrency)),
    monto_origen_num: esc(plain(op.origin_amount, originCurrency)),
    moneda_origen: esc(originCurrency),
    tasa: esc(op.rate),
    monto_destino: esc(fmt(op.dest_amount, destCurrency)),
    monto_destino_num: esc(plain(op.dest_amount, destCurrency)),
    moneda_destino: esc(destCurrency),
    tipo: op.delivery_type === 'CASH' ? 'EFECTIVO' : 'TRANSFERENCIA',
    cliente: op.client_name
      ? `🙍 Cliente: ${esc(op.client_name)}${op.client_contact ? ` (${esc(op.client_contact)})` : ''}`
      : '',
    destinos: renderDestinations(op),
    destinos_simple: renderDestinationsSimple(op),
    usdt: renderUsdt(op),
    notas: op.notes ? `\n🗒 ${esc(op.notes)}` : '',
    operador: esc(op.created_by || 'sistema'),
  };

  let out = tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m);

  // Colapsa los huecos que dejan los marcadores opcionales vacios.
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/** Renderiza usando la plantilla guardada en ajustes. */
async function renderForOperation(op, { now } = {}) {
  return renderMessage(op, { template: await getTemplate(), now });
}

/** Grupo al que va la notificacion: el del pais, o el de respaldo. */
function resolveChat(country) {
  const chatId = (country?.telegram_chat_id || '').trim() || config.telegram.fallbackChatId;
  const threadId = (country?.telegram_thread_id || '').trim();
  return { chatId, threadId };
}

async function callApi(method, payload) {
  const url = `${config.telegram.apiBase}/bot${config.telegram.token}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.telegram.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.description || `Telegram HTTP ${res.status}`);
      err.status = res.status;
      err.retryAfter = data?.parameters?.retry_after;
      err.telegram = data;
      throw err;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Envia el mensaje al grupo del pais. Reintenta ante fallos transitorios y
 * respeta el retry_after cuando Telegram limita la velocidad.
 */
async function sendOperation(op, { template } = {}) {
  const text = renderMessage(op, { template: template || await getTemplate() });
  const { chatId, threadId } = resolveChat(op.origin_country);

  if (!config.telegramEnabled) {
    return { sent: false, reason: 'TELEGRAM_BOT_TOKEN no configurado', text, chatId };
  }
  if (!chatId) {
    return {
      sent: false,
      reason: `El pais "${op.origin_country?.name || op.origin_country_id}" no tiene grupo de Telegram configurado`,
      text,
      chatId: '',
    };
  }

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (threadId) payload.message_thread_id = Number(threadId);

  let lastErr;
  for (let attempt = 1; attempt <= config.telegram.retries; attempt++) {
    try {
      const result = await callApi('sendMessage', payload);
      return { sent: true, text, chatId, messageId: result.message_id };
    } catch (err) {
      lastErr = err;
      // 4xx que no sea rate limit: reintentar no cambia nada.
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
      const waitMs = err.retryAfter ? err.retryAfter * 1000 : 2 ** attempt * 500;
      if (attempt < config.telegram.retries) await sleep(waitMs);
    }
  }
  return { sent: false, reason: lastErr?.message || 'Error desconocido', text, chatId };
}

/** Verifica el token y devuelve el usuario del bot (para la pantalla de ajustes). */
async function getMe() {
  if (!config.telegramEnabled) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN no configurado' };
  try {
    const me = await callApi('getMe', {});
    return { ok: true, bot: me };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Operacion de muestra para previsualizar una plantilla en Ajustes sin tener
 * que crear un envio de verdad.
 */
function sampleOperation() {
  return {
    folio: '20260820-007',
    op_date: '2026-08-20',
    origin_country_id: 'brasil',
    origin_country: { id: 'brasil', name: 'Brasil', emoji: '🇧🇷' },
    origin_currency: 'BRL',
    origin_amount: '5100.00',
    rate: '564',
    rate_mode: 'MULTIPLY',
    dest_country_id: 'colombia',
    dest_country: { id: 'colombia', name: 'Colombia', emoji: '🇨🇴' },
    dest_currency: 'COP',
    dest_amount: '2876400',
    delivery_type: 'TRANSFER',
    client_name: 'Cliente de ejemplo',
    client_contact: '',
    notes: '',
    created_by: 'bryan',
    transfers: [{
      position: 1, beneficiary_name: 'Juan Ramirez', doc_type: 'CC', doc_number: '1088354953',
      bank_name: 'Bancolombia', account_number: '11548736279', account_type: 'AHORROS',
      amount: '2876400', currency: 'COP', reference: '',
    }],
    cash_deliveries: [],
    usdt_sales: [],
  };
}

module.exports = {
  PRESETS, DEFAULT_TEMPLATE, getTemplate, setTemplate,
  renderMessage, renderForOperation, renderDestinations, renderDestinationsSimple, renderUsdt,
  sendOperation, resolveChat, getMe, esc, formatDateTime, docLabel, sampleOperation,
};
