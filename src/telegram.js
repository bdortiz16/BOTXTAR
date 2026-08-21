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

const DOC_LABELS = {
  CC: 'C.C.', CE: 'C.E.', NIT: 'NIT', PAS: 'Pasaporte', PPT: 'PPT',
  DNI: 'DNI', RUT: 'RUT', CPF: 'CPF', CURP: 'CURP', RFC: 'RFC',
};

/**
 * Plantilla por defecto del mensaje que llega al grupo del pais.
 *
 * Se guarda en `settings` y se puede editar desde la pantalla de ajustes sin
 * tocar codigo, para calcarla al formato que ya usa el grupo.
 * Marcadores disponibles: {{folio}} {{fecha}} {{pais}} {{pais_destino}}
 * {{monto_origen}} {{moneda_origen}} {{tasa}} {{monto_destino}}
 * {{moneda_destino}} {{tipo}} {{cliente}} {{destinos}} {{usdt}}
 * {{notas}} {{operador}}
 */
const DEFAULT_TEMPLATE = `🧾 <b>{{tipo}} · {{folio}}</b>
📅 {{fecha}}   {{pais}} ➡️ {{pais_destino}}

💵 Monto: <b>{{monto_origen}} {{moneda_origen}}</b>
📈 Tasa: <b>{{tasa}}</b>
💰 Total: <b>{{monto_destino}} {{moneda_destino}}</b>
{{cliente}}
{{destinos}}
{{usdt}}
{{notas}}
👤 {{operador}}`;

const SETTING_KEY = 'telegram_template';

function getTemplate() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY);
  return row ? row.value : DEFAULT_TEMPLATE;
}

function setTemplate(value) {
  const v = String(value ?? '').slice(0, 8000) || DEFAULT_TEMPLATE;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SETTING_KEY, v);
  return v;
}

function fmt(decimalString, currency) {
  return money.formatAmount(money.parseAmount(decimalString) ?? 0n, currencies.decimalsFor(currency));
}

/** Bloque con las cuentas / puntos de entrega, numerado si esta fraccionado. */
function renderDestinations(op) {
  const lines = [];
  if (op.delivery_type === 'TRANSFER') {
    const list = op.transfers || [];
    lines.push(list.length > 1
      ? `🏦 <b>TRANSFERENCIAS (${list.length} cuentas)</b>`
      : '🏦 <b>TRANSFERENCIA</b>');
    list.forEach((t, i) => {
      const head = list.length > 1 ? `\n<b>${i + 1}.</b> ` : '\n';
      const doc = t.doc_number
        ? `${DOC_LABELS[t.doc_type] || t.doc_type || 'Doc'} ${t.doc_number}`
        : '';
      const parts = [
        `${head}👤 ${esc(t.beneficiary_name)}`,
        doc ? `🆔 ${esc(doc)}` : '',
        t.bank_name ? `🏛 ${esc(t.bank_name)}` : '',
        t.account_number
          ? `#️⃣ <code>${esc(t.account_number)}</code>${t.account_type ? ` (${esc(t.account_type)})` : ''}`
          : '',
        `💸 <b>${esc(fmt(t.amount, t.currency))} ${esc(t.currency)}</b>`,
        t.reference ? `📝 ${esc(t.reference)}` : '',
      ].filter(Boolean);
      lines.push(parts.join('\n'));
    });
  } else {
    const list = op.cash_deliveries || [];
    lines.push(list.length > 1
      ? `💵 <b>ENTREGAS EN EFECTIVO (${list.length})</b>`
      : '💵 <b>ENTREGA EN EFECTIVO</b>');
    list.forEach((c, i) => {
      const head = list.length > 1 ? `\n<b>${i + 1}.</b> ` : '\n';
      const doc = c.doc_number
        ? `${DOC_LABELS[c.doc_type] || c.doc_type || 'Doc'} ${c.doc_number}`
        : '';
      const parts = [
        `${head}📍 ${esc(c.city)}${c.address ? ` — ${esc(c.address)}` : ''}`,
        c.contact_name ? `👤 ${esc(c.contact_name)}` : '',
        doc ? `🆔 ${esc(doc)}` : '',
        c.contact_phone ? `📞 ${esc(c.contact_phone)}` : '',
        c.scheduled_at ? `🕒 ${esc(c.scheduled_at)}` : '',
        `💸 <b>${esc(fmt(c.amount, c.currency))} ${esc(c.currency)}</b>`,
        c.reference ? `📝 ${esc(c.reference)}` : '',
      ].filter(Boolean);
      lines.push(parts.join('\n'));
    });
  }
  return lines.join('\n');
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
function renderMessage(op, { template } = {}) {
  const tpl = template || getTemplate();
  const originCurrency = op.origin_currency;
  const destCurrency = op.dest_currency;
  const originName = op.origin_country?.name || op.origin_country_id;
  const originEmoji = op.origin_country?.emoji || '';
  const destName = op.dest_country?.name || op.dest_country_id;
  const destEmoji = op.dest_country?.emoji || '';

  const values = {
    folio: esc(op.folio),
    fecha: esc(op.op_date),
    pais: esc(`${originEmoji} ${originName}`.trim()),
    pais_destino: esc(`${destEmoji} ${destName}`.trim()),
    monto_origen: esc(fmt(op.origin_amount, originCurrency)),
    moneda_origen: esc(originCurrency),
    tasa: esc(op.rate),
    monto_destino: esc(fmt(op.dest_amount, destCurrency)),
    moneda_destino: esc(destCurrency),
    tipo: op.delivery_type === 'CASH' ? 'EFECTIVO' : 'TRANSFERENCIA',
    cliente: op.client_name
      ? `🙍 Cliente: ${esc(op.client_name)}${op.client_contact ? ` (${esc(op.client_contact)})` : ''}`
      : '',
    destinos: renderDestinations(op),
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
  const text = renderMessage(op, { template });
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

module.exports = {
  DEFAULT_TEMPLATE, getTemplate, setTemplate,
  renderMessage, renderDestinations, renderUsdt,
  sendOperation, resolveChat, getMe, esc,
};
