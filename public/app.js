'use strict';

/* ==========================================================================
   BOTXTAR — asistente de envios
   Flujo: fecha -> pais -> monto y tasa -> tipo -> destinos -> USDT -> enviar
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const state = {
  user: null,
  authRequired: true,
  catalog: null,
  screen: 'home',
  step: 0,
  draft: null,
  calc: null,
  savedOp: null,
};

/* ----------------------------- utilidades ------------------------------- */

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer;
function toast(msg, kind = '') {
  clearTimeout(toastTimer);
  document.querySelector('.toast')?.remove();
  const el = h(`<div class="toast ${kind}">${esc(msg)}</div>`).firstElementChild;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3000);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.authRequired) {
    state.user = null;
    renderLogin();
    throw new Error(data.error || 'Sesion expirada');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

/* --------------- dinero en el navegador (espejo de src/money.js) --------- */

const SCALE = 8n;
const FACTOR = 10n ** SCALE;

function parseAmount(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[\s  '’]/g, '').replace(/[^\d.,\-]/g, '');
  if (!s) return null;
  let sign = 1n;
  if (s.startsWith('-')) { sign = -1n; s = s.slice(1); }
  if (s.includes('-')) return null;

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  let sep = null;
  if (dots && commas) sep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  else if (dots || commas) {
    const ch = dots ? '.' : ',';
    const count = dots || commas;
    const tail = s.slice(s.lastIndexOf(ch) + 1);
    const head = s.slice(0, s.indexOf(ch));
    sep = (count === 1 && tail.length === 3 && head.length > 0) || count > 1 ? null : ch;
  }
  let int = s;
  let frac = '';
  if (sep) {
    const i = s.lastIndexOf(sep);
    int = s.slice(0, i);
    frac = s.slice(i + 1);
  }
  int = int.replace(/[.,]/g, '');
  frac = frac.replace(/[.,]/g, '');
  if (!int && !frac) return null;
  frac = frac.slice(0, 8).padEnd(8, '0');
  return sign * (BigInt(int || '0') * FACTOR + BigInt(frac));
}

function roundScaled(v, decimals) {
  if (decimals >= 8) return v;
  const step = 10n ** (SCALE - BigInt(decimals));
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const rem = abs % step;
  let out = abs - rem;
  if (rem * 2n >= step) out += step;
  return neg ? -out : out;
}

function toDecimalString(v, decimals) {
  const r = roundScaled(v, decimals);
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(8, '0').slice(0, decimals);
  return (neg ? '-' : '') + (decimals > 0 ? `${int}.${frac}` : `${int}`);
}

function fmt(v, decimals = 2) {
  if (v === null || v === undefined) return '—';
  const s = toDecimalString(v, decimals);
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + (frac ? `${g},${frac}` : g);
}

function decimalsOf(code) {
  const c = (state.catalog?.currencies || []).find((x) => x.code === code);
  return c ? c.decimals : 2;
}

/* ------------------- campos de importe con formato en vivo --------------- */

/**
 * Agrupa los miles mientras se escribe y conserva la posicion del cursor.
 * Resuelve el "no colocar comas ni puntos" del formulario viejo: ahora se
 * puede escribir como sea y el campo lo ordena solo.
 */
function attachAmountInput(el, decimals) {
  const format = () => {
    const before = el.value;
    const caret = el.selectionStart ?? before.length;
    const digitsBefore = before.slice(0, caret).replace(/\D/g, '').length;

    let raw = before.replace(/[^\d.,]/g, '');
    const decSep = decimals > 0 ? (raw.includes(',') ? ',' : null) : null;
    let intPart = raw;
    let fracPart = '';
    if (decSep) {
      const i = raw.indexOf(decSep);
      intPart = raw.slice(0, i);
      fracPart = raw.slice(i + 1).replace(/[^\d]/g, '').slice(0, decimals);
    }
    intPart = intPart.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const out = decSep ? `${grouped},${fracPart}` : grouped;
    if (out === before) return;
    el.value = out;

    let seen = 0;
    let pos = out.length;
    for (let i = 0; i < out.length; i++) {
      if (/\d/.test(out[i])) seen++;
      if (seen === digitsBefore) { pos = i + 1; break; }
    }
    if (digitsBefore === 0) pos = 0;
    try { el.setSelectionRange(pos, pos); } catch { /* input sin seleccion */ }
  };
  el.addEventListener('input', format);
  el.setAttribute('inputmode', decimals > 0 ? 'decimal' : 'numeric');
  el.setAttribute('autocomplete', 'off');
  return el;
}

/* ------------------------------- borrador -------------------------------- */

function newDraft(countryId) {
  const country = state.catalog.countries.find((c) => c.id === countryId);
  return {
    op_date: $('#op-date')?.value || state.catalog.today,
    origin_country_id: countryId,
    origin_currency: country?.currency || 'USD',
    dest_country_id: 'colombia',
    dest_currency: 'COP',
    origin_amount: '',
    rate: '',
    rate_mode: 'MULTIPLY',
    delivery_type: null,
    client_name: '',
    client_contact: '',
    notes: '',
    destinations: [],
    usdt_sales: [],
  };
}

function destTotalScaled() {
  return state.calc ? parseAmount(state.calc.dest_amount) : null;
}

function splitState() {
  const total = destTotalScaled();
  const decimals = decimalsOf(state.draft.dest_currency);
  const parts = state.draft.destinations.map((d) => roundScaled(parseAmount(d.amount) ?? 0n, decimals));
  const assigned = parts.reduce((a, b) => a + b, 0n);
  const rest = total === null ? null : total - assigned;
  return { total, assigned, rest, decimals };
}

/* ================================ vistas ================================ */

function setHeader(title, subtitle, showBack) {
  $('#title').firstChild.nodeValue = title;
  $('#subtitle').textContent = subtitle || '';
  $('#btn-back').classList.toggle('hidden', !showBack);
}

/* ------------------------------- login ---------------------------------- */

function renderLogin() {
  state.screen = 'login';
  setHeader('BOTXTAR', 'Ingresa para continuar', false);
  $('#btn-report').classList.add('hidden');
  $('#btn-settings').classList.add('hidden');
  view.innerHTML = '';
  view.append(h(`
    <form class="panel" id="login-form" autocomplete="on">
      <h2>Acceso</h2>
      <div class="field">
        <label for="lg-user">Usuario</label>
        <input id="lg-user" name="username" autocomplete="username" required>
      </div>
      <div class="field">
        <label for="lg-pass">Clave</label>
        <input id="lg-pass" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button class="btn" type="submit">ENTRAR</button>
    </form>
  `));
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/login', {
        method: 'POST',
        body: { user: $('#lg-user').value, password: $('#lg-pass').value },
      });
      state.user = r.user;
      await boot();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

/* -------------------------------- inicio -------------------------------- */

function renderHome() {
  state.screen = 'home';
  state.step = 0;
  setHeader('ENVIOS', `Operador: ${state.user}`, false);
  $('#btn-report').classList.remove('hidden');
  $('#btn-settings').classList.remove('hidden');

  const noTelegram = !state.catalog.telegram_enabled;
  const countries = state.catalog.countries.filter((c) => Number(c.is_origin) === 1);

  view.innerHTML = '';
  view.append(h(`
    ${noTelegram ? '<div class="alert">Telegram no esta configurado: las operaciones se guardan pero no se envian. Configura TELEGRAM_BOT_TOKEN.</div>' : ''}
    <div class="panel">
      <h2>Fecha de la operacion</h2>
      <input type="date" id="op-date" value="${esc(state.catalog.today)}">
      <div class="hint">Todas las operaciones del dia quedan bajo esta fecha en el informe.</div>
    </div>

    <span class="badge-title">ENVIOS</span>
    <div class="panel">
      <div class="countries" id="grid"></div>
    </div>

    <div class="panel">
      <h2>Ultimas operaciones</h2>
      <div class="oplist" id="recent"><div class="muted small">Cargando…</div></div>
    </div>
  `));

  const grid = $('#grid');
  for (const c of countries) {
    const missingChat = !c.telegram_chat_id;
    const btn = h(`
      <button class="country" data-id="${esc(c.id)}">
        <span class="dot" style="background:${esc(c.color)}">${esc(c.emoji || '🌎')}${missingChat ? '<span class="warn-dot" title="Sin grupo de Telegram"></span>' : ''}</span>
        <span class="name">${esc(c.name)}</span>
        <span class="cur">${esc(c.currency)}</span>
      </button>
    `).firstElementChild;
    btn.addEventListener('click', () => startOperation(c.id));
    grid.append(btn);
  }
  const add = h(`
    <button class="country add" id="add-country">
      <span class="dot">＋</span>
      <span class="name">Otro pais</span>
      <span class="cur">agregar</span>
    </button>
  `).firstElementChild;
  add.addEventListener('click', renderNewCountry);
  grid.append(add);

  loadRecent();
}

async function loadRecent() {
  try {
    const { operations } = await api('/operations?limit=8');
    const box = $('#recent');
    if (!box) return;
    box.innerHTML = '';
    if (!operations.length) {
      box.append(h('<div class="muted small">Todavia no hay operaciones registradas.</div>'));
      return;
    }
    for (const op of operations) box.append(opCard(op));
  } catch { /* la lista es informativa; si falla no bloquea el alta */ }
}

function opCard(op) {
  const dd = decimalsOf(op.dest_currency);
  const od = decimalsOf(op.origin_currency);
  const el = h(`
    <button class="opcard" data-id="${op.id}">
      <div class="top">
        <span class="folio">${esc(op.folio)} <span class="pill ${op.status}">${esc(op.status)}</span></span>
        <span class="amt">${esc(fmt(parseAmount(op.dest_amount), dd))} ${esc(op.dest_currency)}</span>
      </div>
      <div class="meta">
        ${esc(op.op_date)} · ${esc(op.origin_country_id)} ·
        ${esc(fmt(parseAmount(op.origin_amount), od))} ${esc(op.origin_currency)} × ${esc(op.rate)} ·
        ${op.delivery_type === 'CASH' ? 'efectivo' : 'transferencia'}${(op.transfers?.length || op.cash_deliveries?.length || 1) > 1 ? ` (${op.transfers.length || op.cash_deliveries.length} destinos)` : ''}
      </div>
    </button>
  `).firstElementChild;
  el.addEventListener('click', () => openOperation(op.id));
  return el;
}

/* --------------------------- alta de pais ------------------------------- */

function renderNewCountry() {
  state.screen = 'new-country';
  setHeader('Nuevo pais', 'Agrega un destino que aun no existe', true);
  view.innerHTML = '';
  view.append(h(`
    <form class="panel" id="nc-form">
      <h2>Datos del pais</h2>
      <div class="field">
        <label for="nc-name">Nombre</label>
        <input id="nc-name" required placeholder="Ej: Argentina">
      </div>
      <div class="row">
        <div class="field">
          <label for="nc-emoji">Bandera</label>
          <input id="nc-emoji" value="🌎" maxlength="4">
        </div>
        <div class="field">
          <label for="nc-cur">Moneda</label>
          <input id="nc-cur" required placeholder="ARS" maxlength="5" style="text-transform:uppercase">
        </div>
      </div>
      <div class="field">
        <label for="nc-chat">Chat ID del grupo de Telegram</label>
        <input id="nc-chat" placeholder="-1001234567890" inputmode="text">
        <div class="hint">Opcional. Sin esto, la operacion usa el grupo de respaldo.
        Para obtenerlo: agrega el bot al grupo y mira Ajustes › Telegram.</div>
      </div>
      <div class="field">
        <label for="nc-color">Color del circulo</label>
        <input id="nc-color" type="color" value="#3f51b5" style="min-height:48px;padding:4px">
      </div>
      <button class="btn" type="submit">GUARDAR PAIS</button>
    </form>
  `));
  $('#nc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/countries', {
        method: 'POST',
        body: {
          name: $('#nc-name').value,
          emoji: $('#nc-emoji').value,
          currency: $('#nc-cur').value,
          telegram_chat_id: $('#nc-chat').value,
          color: $('#nc-color').value,
        },
      });
      await refreshCatalog();
      toast('Pais agregado', 'ok');
      renderHome();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

/* =========================== asistente de envio ========================== */

function startOperation(countryId) {
  state.draft = newDraft(countryId);
  state.calc = null;
  state.savedOp = null;
  state.step = 1;
  renderWizard();
}

function stepsBar(n) {
  return `<div class="steps">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;
}

function renderWizard() {
  state.screen = 'wizard';
  const country = state.catalog.countries.find((c) => c.id === state.draft.origin_country_id);
  const titles = {
    1: 'Monto y tasa', 2: 'Como se entrega', 3: 'Destinos', 4: 'USDT y cliente', 5: 'Revisar y enviar',
  };
  setHeader(`${country.emoji} ${country.name}`.trim(), `${state.draft.op_date} · paso ${state.step} de 5 · ${titles[state.step]}`, true);
  view.innerHTML = '';
  ({ 1: stepAmount, 2: stepDelivery, 3: stepDestinations, 4: stepExtras, 5: stepReview })[state.step]();
  window.scrollTo({ top: 0 });
}

/* ---- paso 1: monto y tasa (el total lo calcula el sistema) ------------- */

function stepAmount() {
  const d = state.draft;
  const destOptions = state.catalog.countries
    .filter((c) => Number(c.is_destination) === 1)
    .map((c) => `<option value="${esc(c.id)}" ${c.id === d.dest_country_id ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)} (${esc(c.currency)})</option>`)
    .join('');

  view.append(h(`
    ${stepsBar(1)}
    <div class="panel">
      <h2>Lo que entrega el cliente</h2>
      <div class="field">
        <label for="f-amount">Monto (${esc(d.origin_currency)})</label>
        <input id="f-amount" value="${esc(d.origin_amount)}" placeholder="10.000">
        <div class="hint">Escribelo como quieras: el campo separa los miles solo.</div>
      </div>
      <div class="field">
        <label for="f-rate">Tasa</label>
        <input id="f-rate" value="${esc(d.rate)}" placeholder="1.000">
      </div>
      <div class="field">
        <label for="f-mode">Operacion</label>
        <select id="f-mode">
          <option value="MULTIPLY" ${d.rate_mode === 'MULTIPLY' ? 'selected' : ''}>Multiplicar (monto × tasa)</option>
          <option value="DIVIDE" ${d.rate_mode === 'DIVIDE' ? 'selected' : ''}>Dividir (monto ÷ tasa)</option>
        </select>
      </div>
      <div class="field">
        <label for="f-dest">Pais de pago</label>
        <select id="f-dest">${destOptions}</select>
      </div>
    </div>

    <div class="calc empty" id="calc">
      <div class="label">Monto a pagar</div>
      <div class="value">—</div>
      <div class="formula">Escribe el monto y la tasa</div>
    </div>

    <button class="btn" id="next" disabled>SIGUIENTE</button>
  `));

  const amountEl = attachAmountInput($('#f-amount'), decimalsOf(d.origin_currency));
  const rateEl = attachAmountInput($('#f-rate'), 8);

  let timer;
  const recalc = () => {
    d.origin_amount = amountEl.value;
    d.rate = rateEl.value;
    d.rate_mode = $('#f-mode').value;
    d.dest_country_id = $('#f-dest').value;
    d.dest_currency = state.catalog.countries.find((c) => c.id === d.dest_country_id).currency;
    clearTimeout(timer);
    timer = setTimeout(runPreview, 220);
  };

  // El calculo va con retardo, asi que puede llegar cuando el operador ya
  // paso de pantalla. En ese caso se descarta: si no, borraria el total ya
  // calculado y el reparto se quedaria sin referencia.
  const stillHere = () => state.screen === 'wizard' && state.step === 1 && $('#calc');

  async function runPreview() {
    if (!stillHere()) return;
    const box = $('#calc');
    if (!parseAmount(d.origin_amount) || !parseAmount(d.rate)) {
      state.calc = null;
      box.className = 'calc empty';
      box.innerHTML = '<div class="label">Monto a pagar</div><div class="value">—</div><div class="formula">Escribe el monto y la tasa</div>';
      $('#next').disabled = true;
      return;
    }
    try {
      const calc = await api('/operations/preview', { method: 'POST', body: d });
      if (!stillHere()) return;
      state.calc = calc;
      box.className = 'calc';
      box.innerHTML = `
        <div class="label">Monto a pagar</div>
        <div class="value">${esc(calc.dest_amount_display)} ${esc(calc.dest_currency)}</div>
        <div class="formula">${esc(calc.origin_amount_display)} ${esc(calc.origin_currency)}
          ${calc.rate_mode === 'DIVIDE' ? '÷' : '×'} ${esc(calc.rate)}</div>`;
      $('#next').disabled = false;
    } catch (err) {
      if (!stillHere()) return;
      state.calc = null;
      box.className = 'calc empty';
      box.innerHTML = `<div class="label">Monto a pagar</div><div class="value">—</div><div class="formula">${esc(err.message)}</div>`;
      $('#next').disabled = true;
    }
  }

  for (const el of [amountEl, rateEl, $('#f-mode'), $('#f-dest')]) {
    el.addEventListener('input', recalc);
    el.addEventListener('change', recalc);
  }
  if (d.origin_amount && d.rate) recalc();

  $('#next').addEventListener('click', () => {
    // Cambiar de moneda destino invalida los montos ya repartidos.
    if (state.draft.destinations.some((x) => x.currency && x.currency !== d.dest_currency)) {
      state.draft.destinations = [];
    }
    state.step = 2;
    renderWizard();
  });
}

/* ---- paso 2: transferencia o efectivo ---------------------------------- */

function stepDelivery() {
  const d = state.draft;
  view.append(h(`
    ${stepsBar(2)}
    <div class="calc">
      <div class="label">Monto a pagar</div>
      <div class="value">${esc(state.calc.dest_amount_display)} ${esc(state.calc.dest_currency)}</div>
      <div class="formula">${esc(state.calc.origin_amount_display)} ${esc(state.calc.origin_currency)}
        ${state.calc.rate_mode === 'DIVIDE' ? '÷' : '×'} ${esc(state.calc.rate)}</div>
    </div>
    <div class="panel">
      <h2>Como se entrega</h2>
      <div class="choices">
        <button class="choice" type="button" data-t="TRANSFER" aria-pressed="${d.delivery_type === 'TRANSFER'}">
          <span class="ico">🏦</span><span class="t">TRANSFERENCIA</span>
        </button>
        <button class="choice" type="button" data-t="CASH" aria-pressed="${d.delivery_type === 'CASH'}">
          <span class="ico">💵</span><span class="t">EFECTIVO</span>
        </button>
      </div>
      <div class="hint mt">La transferencia pide banco y cuenta. El efectivo pide ciudad y punto de entrega.</div>
    </div>
  `));

  for (const btn of view.querySelectorAll('.choice')) {
    btn.addEventListener('click', () => {
      const type = btn.dataset.t;
      if (d.delivery_type && d.delivery_type !== type) d.destinations = [];
      d.delivery_type = type;
      if (d.destinations.length === 0) d.destinations = [blankDestination(true)];
      state.step = 3;
      renderWizard();
    });
  }
}

function blankDestination(full) {
  const decimals = decimalsOf(state.draft.dest_currency);
  const { rest } = full ? { rest: destTotalScaled() } : splitState();
  return {
    beneficiary_name: '', doc_type: '', doc_number: '', bank_name: '',
    account_number: '', account_type: 'AHORROS',
    city: '', address: '', contact_name: '', contact_phone: '', scheduled_at: '',
    reference: '',
    currency: state.draft.dest_currency,
    // Se precarga con lo que falta por repartir: en el caso normal (una sola
    // cuenta) queda el total completo y el operador no escribe nada.
    amount: rest !== null && rest > 0n ? toDecimalString(rest, decimals) : '',
  };
}

/* ---- paso 3: destinos, con fraccionamiento controlado ------------------ */

const DOC_TYPES = {
  colombia: ['CC', 'CE', 'NIT', 'PAS', 'PPT'],
  peru: ['DNI', 'CE', 'RUC', 'PAS'],
  chile: ['RUT', 'PAS'],
  brasil: ['CPF', 'CNPJ', 'PAS'],
  mexico: ['CURP', 'RFC', 'INE', 'PAS'],
  venezuela: ['V', 'E', 'J', 'PAS'],
  ecuador: ['CI', 'RUC', 'PAS'],
};
const ACCOUNT_TYPES = ['AHORROS', 'CORRIENTE', 'DIGITAL'];

function docTypesFor(countryId) {
  return DOC_TYPES[countryId] || ['CC', 'DNI', 'PAS', 'OTRO'];
}

function stepDestinations() {
  const d = state.draft;
  const isTransfer = d.delivery_type === 'TRANSFER';
  const banks = state.catalog.banks[d.dest_country_id] || [];

  view.append(h(`
    ${stepsBar(3)}
    <div class="panel">
      <h2>${isTransfer ? 'Cuentas de destino' : 'Puntos de entrega'}</h2>
      <div id="dest-list"></div>
      <div class="btnrow">
        <button class="btn ghost sm" id="add-dest" type="button">＋ ${isTransfer ? 'Otra cuenta' : 'Otra entrega'}</button>
        <button class="btn ghost sm" id="split-even" type="button">Repartir igual</button>
      </div>
      <div class="hint mt">Si el cliente pide el dinero en varias cuentas, agrega las que necesites.
      La suma debe cuadrar exacto con el monto a pagar.</div>
    </div>
    <div class="splitbar" id="splitbar"></div>
    <button class="btn" id="next" type="button">SIGUIENTE</button>
  `));

  const list = $('#dest-list');

  function renderList() {
    list.innerHTML = '';
    d.destinations.forEach((dest, i) => list.append(destCard(dest, i, isTransfer, banks)));
    updateSplitBar();
  }

  function destCard(dest, i, transfer, bankList) {
    const many = d.destinations.length > 1;
    const docs = docTypesFor(d.dest_country_id);
    const el = h(`
      <div class="dest">
        <div class="dest-head">
          <span>${transfer ? 'Cuenta' : 'Entrega'} ${i + 1}${many ? ` de ${d.destinations.length}` : ''}</span>
          ${many ? '<button class="del" type="button">Quitar</button>' : ''}
        </div>
        ${transfer ? `
          <div class="field">
            <label>Nombre del titular</label>
            <input data-k="beneficiary_name" value="${esc(dest.beneficiary_name)}" placeholder="Nombre completo">
          </div>
          <div class="row">
            <div class="field">
              <label>Documento</label>
              <select data-k="doc_type">
                <option value="">—</option>
                ${docs.map((t) => `<option ${dest.doc_type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Numero</label>
              <input data-k="doc_number" value="${esc(dest.doc_number)}" inputmode="numeric">
            </div>
          </div>
          <div class="field">
            <label>Banco</label>
            <input data-k="bank_name" value="${esc(dest.bank_name)}" list="banks-${i}" placeholder="Escribe o elige">
            <datalist id="banks-${i}">${bankList.map((b) => `<option value="${esc(b)}"></option>`).join('')}</datalist>
          </div>
          <div class="row">
            <div class="field">
              <label>Numero de cuenta</label>
              <input data-k="account_number" value="${esc(dest.account_number)}" inputmode="numeric">
            </div>
            <div class="field">
              <label>Tipo de cuenta</label>
              <select data-k="account_type">
                ${ACCOUNT_TYPES.map((t) => `<option ${dest.account_type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
              </select>
            </div>
          </div>
        ` : `
          <div class="field">
            <label>Ciudad</label>
            <input data-k="city" value="${esc(dest.city)}" placeholder="Ej: Bogota">
          </div>
          <div class="field">
            <label>Punto o direccion de entrega</label>
            <input data-k="address" value="${esc(dest.address)}" placeholder="Barrio, direccion, referencia">
          </div>
          <div class="row">
            <div class="field">
              <label>Quien recibe</label>
              <input data-k="contact_name" value="${esc(dest.contact_name)}">
            </div>
            <div class="field">
              <label>Telefono</label>
              <input data-k="contact_phone" value="${esc(dest.contact_phone)}" inputmode="tel">
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>Documento</label>
              <select data-k="doc_type">
                <option value="">—</option>
                ${docs.map((t) => `<option ${dest.doc_type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Numero</label>
              <input data-k="doc_number" value="${esc(dest.doc_number)}" inputmode="numeric">
            </div>
          </div>
          <div class="field">
            <label>Hora acordada</label>
            <input data-k="scheduled_at" value="${esc(dest.scheduled_at)}" placeholder="Ej: hoy 3:00 pm">
          </div>
        `}
        <div class="field">
          <label>Monto (${esc(d.dest_currency)})</label>
          <input data-k="amount" class="amount">
        </div>
        <div class="field">
          <label>Referencia / nota</label>
          <input data-k="reference" value="${esc(dest.reference)}" placeholder="Opcional">
        </div>
      </div>
    `).firstElementChild;

    const decimals = decimalsOf(d.dest_currency);
    const amountEl = el.querySelector('.amount');
    amountEl.value = dest.amount ? fmt(parseAmount(dest.amount), decimals) : '';
    attachAmountInput(amountEl, decimals);

    el.addEventListener('input', (e) => {
      const key = e.target.dataset.k;
      if (!key) return;
      dest[key] = e.target.value;
      if (key === 'amount') updateSplitBar();
    });
    el.addEventListener('change', (e) => {
      const key = e.target.dataset.k;
      if (key) dest[key] = e.target.value;
    });
    el.querySelector('.del')?.addEventListener('click', () => {
      d.destinations.splice(i, 1);
      renderList();
    });
    return el;
  }

  function updateSplitBar() {
    const { total, assigned, rest, decimals } = splitState();
    const bar = $('#splitbar');
    const cls = rest === 0n ? 'done' : rest < 0n ? 'over' : 'short';
    bar.className = `splitbar ${cls}`;
    bar.innerHTML = `
      <div><div class="k">Total</div><div class="v">${esc(fmt(total, decimals))}</div></div>
      <div><div class="k">Repartido</div><div class="v">${esc(fmt(assigned, decimals))}</div></div>
      <div><div class="k">${rest < 0n ? 'Sobrante' : 'Restante'}</div>
           <div class="v rest">${esc(fmt(rest < 0n ? -rest : rest, decimals))}</div></div>`;
    $('#next').disabled = rest !== 0n;
    $('#next').textContent = rest === 0n ? 'SIGUIENTE' : (rest > 0n ? 'FALTA REPARTIR' : 'TE PASASTE DEL TOTAL');
  }

  $('#add-dest').addEventListener('click', () => {
    d.destinations.push(blankDestination(false));
    renderList();
  });

  /** Reparte el total en partes iguales y ajusta el sobrante en la ultima. */
  $('#split-even').addEventListener('click', () => {
    const total = destTotalScaled();
    const n = BigInt(d.destinations.length);
    if (!total || n === 0n) return;
    const decimals = decimalsOf(d.dest_currency);
    const step = 10n ** (8n - BigInt(decimals));
    const units = total / step;
    const base = units / n;
    const extra = units % n;
    d.destinations.forEach((dest, i) => {
      const u = base + (BigInt(i) < extra ? 1n : 0n);
      dest.amount = toDecimalString(u * step, decimals);
    });
    renderList();
  });

  $('#next').addEventListener('click', () => {
    state.step = 4;
    renderWizard();
  });

  renderList();
}

/* ---- paso 4: venta de USDT, cliente y notas ---------------------------- */

function stepExtras() {
  const d = state.draft;
  view.append(h(`
    ${stepsBar(4)}
    <div class="panel">
      <h2>Venta de USDT (opcional)</h2>
      <div id="usdt-list"></div>
      <button class="btn ghost sm" id="add-usdt" type="button">＋ Agregar venta de USDT</button>
      <div class="hint mt">Queda dentro de la misma operacion, sale en el mensaje de Telegram y suma en el informe.</div>
    </div>
    <div class="panel">
      <h2>Cliente y notas</h2>
      <div class="row">
        <div class="field">
          <label for="f-client">Cliente</label>
          <input id="f-client" value="${esc(d.client_name)}" placeholder="Opcional">
        </div>
        <div class="field">
          <label for="f-contact">Contacto</label>
          <input id="f-contact" value="${esc(d.client_contact)}" placeholder="Opcional">
        </div>
      </div>
      <div class="field">
        <label for="f-notes">Notas</label>
        <textarea id="f-notes" placeholder="Observaciones de la operacion">${esc(d.notes)}</textarea>
      </div>
    </div>
    <button class="btn" id="next" type="button">REVISAR</button>
  `));

  const list = $('#usdt-list');

  function renderUsdt() {
    list.innerHTML = '';
    d.usdt_sales.forEach((sale, i) => {
      const currencyOptions = state.catalog.currencies
        .map((c) => `<option value="${esc(c.code)}" ${sale.currency === c.code ? 'selected' : ''}>${esc(c.code)}</option>`)
        .join('');
      const el = h(`
        <div class="dest">
          <div class="dest-head">
            <span>Venta ${i + 1}</span>
            <button class="del" type="button">Quitar</button>
          </div>
          <div class="row">
            <div class="field">
              <label>Cantidad USDT</label>
              <input data-k="quantity" class="qty">
            </div>
            <div class="field">
              <label>Precio por USDT</label>
              <input data-k="unit_price" class="price">
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>Moneda de cobro</label>
              <select data-k="currency">${currencyOptions}</select>
            </div>
            <div class="field">
              <label>Red</label>
              <select data-k="network">
                ${['', 'TRON', 'BSC', 'ETH', 'POLYGON', 'SOLANA'].map((n) => `<option value="${esc(n)}" ${sale.network === n ? 'selected' : ''}>${esc(n || '—')}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field">
            <label>Contraparte</label>
            <input data-k="counterparty" value="${esc(sale.counterparty || '')}" placeholder="Ej: Binance / nombre">
          </div>
          <div class="field">
            <label>Wallet / referencia</label>
            <input data-k="wallet" value="${esc(sale.wallet || '')}" placeholder="Opcional">
          </div>
          <div class="calc" style="margin-bottom:0">
            <div class="label">Total de la venta</div>
            <div class="value total">—</div>
          </div>
        </div>
      `).firstElementChild;

      const qty = el.querySelector('.qty');
      const price = el.querySelector('.price');
      qty.value = sale.quantity || '';
      price.value = sale.unit_price || '';
      attachAmountInput(qty, 2);
      attachAmountInput(price, 8);

      const recalcTotal = () => {
        const q = parseAmount(sale.quantity);
        const p = parseAmount(sale.unit_price);
        const cur = sale.currency || 'COP';
        const dec = decimalsOf(cur);
        el.querySelector('.total').textContent = (q && p)
          ? `${fmt(roundScaled((q * p) / FACTOR, dec), dec)} ${cur}`
          : '—';
      };

      el.addEventListener('input', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        sale[k] = e.target.value;
        recalcTotal();
      });
      el.addEventListener('change', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        sale[k] = e.target.value;
        recalcTotal();
      });
      el.querySelector('.del').addEventListener('click', () => {
        d.usdt_sales.splice(i, 1);
        renderUsdt();
      });
      recalcTotal();
      list.append(el);
    });
  }

  $('#add-usdt').addEventListener('click', () => {
    d.usdt_sales.push({
      quantity: '', unit_price: '', currency: d.dest_currency,
      network: '', wallet: '', counterparty: '', reference: '',
    });
    renderUsdt();
  });

  $('#next').addEventListener('click', () => {
    d.client_name = $('#f-client').value;
    d.client_contact = $('#f-contact').value;
    d.notes = $('#f-notes').value;
    state.step = 5;
    renderWizard();
  });

  renderUsdt();
}

/* ---- paso 5: revisar, guardar y enviar --------------------------------- */

function stepReview() {
  const d = state.draft;
  const dd = decimalsOf(d.dest_currency);
  const rows = d.destinations.map((x, i) => {
    const who = d.delivery_type === 'TRANSFER'
      ? `${x.beneficiary_name || '(sin nombre)'} · ${x.bank_name || 's/banco'} ${x.account_number || ''}`
      : `${x.city || '(sin ciudad)'} · ${x.address || ''}`;
    return `<div class="line"><span class="k">${i + 1}. ${esc(who)}</span>
            <span class="v">${esc(fmt(parseAmount(x.amount), dd))}</span></div>`;
  }).join('');

  const usdtRows = d.usdt_sales.filter((s) => s.quantity && s.unit_price).map((s) => {
    const dec = decimalsOf(s.currency);
    const q = parseAmount(s.quantity);
    const p = parseAmount(s.unit_price);
    return `<div class="line"><span class="k">${esc(fmt(q, 2))} USDT × ${esc(s.unit_price)}</span>
            <span class="v">${esc(fmt(roundScaled((q * p) / FACTOR, dec), dec))} ${esc(s.currency)}</span></div>`;
  }).join('');

  view.append(h(`
    ${stepsBar(5)}
    <div class="calc">
      <div class="label">Monto a pagar</div>
      <div class="value">${esc(state.calc.dest_amount_display)} ${esc(state.calc.dest_currency)}</div>
      <div class="formula">${esc(state.calc.origin_amount_display)} ${esc(state.calc.origin_currency)}
        ${state.calc.rate_mode === 'DIVIDE' ? '÷' : '×'} ${esc(state.calc.rate)}</div>
    </div>
    <div class="panel">
      <h2>Resumen</h2>
      <div class="summary">
        <div class="line"><span class="k">Fecha</span><span class="v">${esc(d.op_date)}</span></div>
        <div class="line"><span class="k">Tipo</span><span class="v">${d.delivery_type === 'CASH' ? 'Efectivo' : 'Transferencia'}</span></div>
        ${d.client_name ? `<div class="line"><span class="k">Cliente</span><span class="v">${esc(d.client_name)}</span></div>` : ''}
        ${rows}
        ${usdtRows}
      </div>
    </div>
    <div class="panel">
      <h2>Mensaje que llegara a Telegram</h2>
      <pre class="tg" id="tg-preview">Calculando vista previa…</pre>
    </div>
    <div class="btnrow">
      <button class="btn ghost" id="save" type="button">GUARDAR</button>
      <button class="btn ok" id="send" type="button">ENVIAR ▸</button>
    </div>
    <div class="spacer"></div>
  `));

  // Muestra ya el mensaje exacto que se va a enviar, sin guardar nada todavia.
  api('/operations/preview-message', { method: 'POST', body: d })
    .then((pv) => { $('#tg-preview').textContent = pv.text.replace(/<[^>]+>/g, ''); })
    .catch((err) => { $('#tg-preview').textContent = err.message; });

  async function save() {
    const payload = { ...d, destinations: d.destinations, usdt_sales: d.usdt_sales };
    const op = state.savedOp
      ? await api(`/operations/${state.savedOp.id}`, { method: 'PUT', body: payload })
      : await api('/operations', { method: 'POST', body: payload });
    state.savedOp = op;
    const pv = await api(`/operations/${op.id}/preview-message`);
    $('#tg-preview').textContent = pv.text.replace(/<[^>]+>/g, '');
    return op;
  }

  $('#save').addEventListener('click', async () => {
    try {
      const op = await save();
      toast(`Guardada como ${op.folio}`, 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('#send').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'ENVIANDO…';
    try {
      const op = await save();
      const r = await api(`/operations/${op.id}/send`, { method: 'POST', body: { resend: true } });
      state.savedOp = r.operation;
      toast('Enviado al grupo de Telegram', 'ok');
      openOperation(r.operation.id);
    } catch (err) {
      toast(err.message, 'bad');
      if (err.data?.text) $('#tg-preview').textContent = err.data.text.replace(/<[^>]+>/g, '');
      btn.disabled = false;
      btn.textContent = 'ENVIAR ▸';
    }
  });
}

/* --------------------------- detalle de operacion ----------------------- */

async function openOperation(id) {
  try {
    const op = await api(`/operations/${id}`);
    const pv = await api(`/operations/${id}/preview-message`).catch(() => ({ text: '' }));
    state.screen = 'operation';
    state.savedOp = op;
    setHeader(op.folio, `${op.op_date} · ${op.status}`, true);
    const dd = decimalsOf(op.dest_currency);
    const od = decimalsOf(op.origin_currency);
    const dests = op.delivery_type === 'TRANSFER' ? op.transfers : op.cash_deliveries;

    view.innerHTML = '';
    view.append(h(`
      <div class="calc">
        <div class="label">Monto a pagar</div>
        <div class="value">${esc(fmt(parseAmount(op.dest_amount), dd))} ${esc(op.dest_currency)}</div>
        <div class="formula">${esc(fmt(parseAmount(op.origin_amount), od))} ${esc(op.origin_currency)}
          ${op.rate_mode === 'DIVIDE' ? '÷' : '×'} ${esc(op.rate)}</div>
      </div>
      <div class="panel">
        <h2>Detalle <span class="pill ${op.status}">${esc(op.status)}</span></h2>
        <div class="summary">
          <div class="line"><span class="k">Origen</span><span class="v">${esc(op.origin_country_id)}</span></div>
          <div class="line"><span class="k">Destino</span><span class="v">${esc(op.dest_country_id)}</span></div>
          <div class="line"><span class="k">Tipo</span><span class="v">${op.delivery_type === 'CASH' ? 'Efectivo' : 'Transferencia'}</span></div>
          ${op.client_name ? `<div class="line"><span class="k">Cliente</span><span class="v">${esc(op.client_name)}</span></div>` : ''}
          ${dests.map((x, i) => `<div class="line"><span class="k">${i + 1}. ${esc(x.beneficiary_name || x.city || '')}</span>
             <span class="v">${esc(fmt(parseAmount(x.amount), dd))}</span></div>`).join('')}
          ${op.usdt_sales.map((u) => `<div class="line"><span class="k">USDT ${esc(fmt(parseAmount(u.quantity), 2))} × ${esc(u.unit_price)}</span>
             <span class="v">${esc(fmt(parseAmount(u.gross_amount), decimalsOf(u.currency)))} ${esc(u.currency)}</span></div>`).join('')}
          <div class="line"><span class="k">Operador</span><span class="v">${esc(op.created_by)}</span></div>
        </div>
      </div>
      <div class="panel">
        <h2>Mensaje de Telegram</h2>
        <pre class="tg">${esc((pv.text || '').replace(/<[^>]+>/g, ''))}</pre>
      </div>
      <div class="btnrow">
        <button class="btn ghost" id="resend" type="button">${op.status === 'SENT' ? 'REENVIAR' : 'ENVIAR'}</button>
        <button class="btn ok" id="complete" type="button">MARCAR PAGADA</button>
      </div>
      <div class="spacer"></div>
      <button class="btn bad" id="cancel-op" type="button">ANULAR OPERACION</button>
    `));

    $('#resend').addEventListener('click', async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        await api(`/operations/${id}/send`, { method: 'POST', body: { resend: true } });
        toast('Enviado', 'ok');
        openOperation(id);
      } catch (err) {
        toast(err.message, 'bad');
        ev.currentTarget.disabled = false;
      }
    });
    $('#complete').addEventListener('click', async () => {
      await api(`/operations/${id}/status`, { method: 'POST', body: { status: 'COMPLETED' } });
      toast('Marcada como pagada', 'ok');
      openOperation(id);
    });
    $('#cancel-op').addEventListener('click', async () => {
      if (!confirm('Anular esta operacion? No sumara en el informe.')) return;
      await api(`/operations/${id}/status`, { method: 'POST', body: { status: 'CANCELLED' } });
      toast('Operacion anulada');
      renderHome();
    });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/* -------------------------------- informe ------------------------------- */

async function renderReport() {
  state.screen = 'report';
  setHeader('Informe', 'Resumen contable', true);
  const today = state.catalog.today;
  const first = `${today.slice(0, 8)}01`;

  view.innerHTML = '';
  view.append(h(`
    <div class="panel">
      <h2>Rango</h2>
      <div class="row">
        <div class="field"><label for="r-from">Desde</label><input type="date" id="r-from" value="${esc(first)}"></div>
        <div class="field"><label for="r-to">Hasta</label><input type="date" id="r-to" value="${esc(today)}"></div>
      </div>
      <div class="field">
        <label for="r-country">Pais</label>
        <select id="r-country">
          <option value="">Todos</option>
          ${state.catalog.countries.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="btnrow">
        <button class="btn" id="r-go" type="button">VER</button>
        <button class="btn ghost" id="r-csv" type="button">CSV</button>
      </div>
    </div>
    <div id="r-out"><div class="muted small center">Elige un rango y toca VER.</div></div>
  `));

  const query = () => {
    const p = new URLSearchParams();
    if ($('#r-from').value) p.set('from', $('#r-from').value);
    if ($('#r-to').value) p.set('to', $('#r-to').value);
    if ($('#r-country').value) p.set('country', $('#r-country').value);
    return p.toString();
  };

  $('#r-go').addEventListener('click', async () => {
    const out = $('#r-out');
    out.innerHTML = '<div class="muted small center">Calculando…</div>';
    try {
      const rep = await api(`/report?${query()}`);
      const t = rep.totals;
      out.innerHTML = '';
      out.append(h(`
        <div class="stats">
          <div class="stat"><div class="k">Operaciones</div><div class="v">${t.operations}</div></div>
          <div class="stat"><div class="k">Destinos</div><div class="v">${t.transfers + t.cash_deliveries}</div></div>
          <div class="stat"><div class="k">Transferencias</div><div class="v">${t.by_delivery.TRANSFER || 0}</div></div>
          <div class="stat"><div class="k">Efectivo</div><div class="v">${t.by_delivery.CASH || 0}</div></div>
        </div>
        <div class="panel">
          <h2>Recibido del cliente</h2>
          <div class="summary">${t.received.length ? t.received.map((r) => `
            <div class="line"><span class="k">${esc(r.currency)}</span><span class="v">${esc(r.display)}</span></div>`).join('')
            : '<div class="muted small">Sin datos</div>'}</div>
        </div>
        <div class="panel">
          <h2>Pagado</h2>
          <div class="summary">${t.paid.length ? t.paid.map((r) => `
            <div class="line"><span class="k">${esc(r.currency)}</span><span class="v">${esc(r.display)}</span></div>`).join('')
            : '<div class="muted small">Sin datos</div>'}</div>
        </div>
        ${t.usdt.gross.length ? `
        <div class="panel">
          <h2>Venta de USDT</h2>
          <div class="summary">
            <div class="line"><span class="k">Cantidad</span><span class="v">${esc(t.usdt.quantity_display)} USDT</span></div>
            ${t.usdt.gross.map((r) => `<div class="line"><span class="k">Cobrado ${esc(r.currency)}</span><span class="v">${esc(r.display)}</span></div>`).join('')}
          </div>
        </div>` : ''}
        <div class="panel">
          <h2>Por pais</h2>
          <div class="summary">${rep.by_country.map((c) => `
            <div class="line">
              <span class="k">${esc(c.emoji)} ${esc(c.name)} · ${c.operations} ops</span>
              <span class="v">${c.received.map((r) => `${esc(r.display)} ${esc(r.currency)}`).join('<br>')}</span>
            </div>`).join('') || '<div class="muted small">Sin datos</div>'}</div>
        </div>
        <div class="panel">
          <h2>Operaciones</h2>
          <div class="oplist" id="r-ops"></div>
        </div>
      `));
      const box = $('#r-ops');
      for (const op of rep.operations) box.append(opCard(op));
    } catch (err) {
      out.innerHTML = `<div class="alert bad">${esc(err.message)}</div>`;
    }
  });

  $('#r-csv').addEventListener('click', () => {
    window.location.href = `/api/report.csv?${query()}`;
  });

  $('#r-go').click();
}

/* -------------------------------- ajustes ------------------------------- */

async function renderSettings() {
  state.screen = 'settings';
  setHeader('Ajustes', 'Telegram y plantilla', true);
  view.innerHTML = '<div class="muted small center">Cargando…</div>';

  const [status, tpl] = await Promise.all([
    api('/telegram/status').catch((e) => ({ ok: false, reason: e.message, countries: [] })),
    api('/settings/template'),
  ]);

  view.innerHTML = '';
  view.append(h(`
    <div class="panel">
      <h2>Bot de Telegram</h2>
      ${status.ok
        ? `<div class="alert" style="background:#1f3b2a;border-color:var(--ok);color:#b6f0cd">
             Conectado como <b>@${esc(status.bot.username)}</b></div>`
        : `<div class="alert bad">${esc(status.reason || 'Sin conexion')}</div>`}
      <div class="hint">Para obtener el chat ID de un grupo: agrega el bot al grupo, escribe un mensaje
      y abre <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code>. El id de un grupo
      empieza por <code>-100</code>.</div>
    </div>

    <div class="panel">
      <h2>Grupo por pais</h2>
      <div id="chats"></div>
    </div>

    <div class="panel">
      <h2>Formato del mensaje</h2>
      <div class="choices">
        <button class="choice" type="button" id="p-mejorado">
          <span class="ico">✨</span><span class="t">MEJORADO</span>
        </button>
        <button class="choice" type="button" id="p-clasico">
          <span class="ico">📄</span><span class="t">COMO HOY</span>
        </button>
      </div>
      <div class="hint mt"><b>Mejorado</b> agrega referencia, tasa, moneda y total, y pone cuentas y
      documentos en modo copiar-de-un-toque. <b>Como hoy</b> deja el mensaje exactamente igual al que
      llega ahora a los grupos.</div>
    </div>

    <div class="panel">
      <h2>Vista previa</h2>
      <div class="btnrow" style="margin-bottom:10px">
        <button class="btn ghost sm" id="pv-simple" type="button">1 cuenta</button>
        <button class="btn ghost sm" id="pv-split" type="button">3 cuentas + USDT</button>
      </div>
      <pre class="tg" id="tpl-preview">Cargando…</pre>
    </div>

    <div class="panel">
      <h2>Plantilla</h2>
      <div class="field">
        <textarea id="tpl" style="min-height:230px;font-family:ui-monospace,monospace;font-size:.82rem">${esc(tpl.template)}</textarea>
        <div class="hint">Marcadores: {{folio}} {{fecha}} {{fecha_hora}} {{hora}} {{pais}}
        {{pais_destino}} {{monto_origen}} {{monto_origen_num}} {{moneda_origen}} {{tasa}}
        {{monto_destino}} {{monto_destino_num}} {{moneda_destino}} {{tipo}} {{cliente}}
        {{destinos}} {{destinos_simple}} {{usdt}} {{notas}} {{operador}}.
        Acepta HTML de Telegram (&lt;b&gt;, &lt;code&gt;).</div>
      </div>
      <div class="btnrow">
        <button class="btn" id="tpl-save" type="button">GUARDAR</button>
        <button class="btn ghost" id="tpl-reset" type="button">RESTAURAR</button>
      </div>
    </div>
  `));

  // La vista previa se refresca sola mientras se edita la plantilla.
  let splitSample = false;
  let pvTimer;
  async function refreshPreview() {
    try {
      const r = await api('/settings/template/preview', {
        method: 'POST', body: { template: $('#tpl').value, split: splitSample },
      });
      $('#tpl-preview').textContent = r.text.replace(/<[^>]+>/g, '');
    } catch (err) {
      $('#tpl-preview').textContent = err.message;
    }
  }
  const queuePreview = () => { clearTimeout(pvTimer); pvTimer = setTimeout(refreshPreview, 250); };

  $('#tpl').addEventListener('input', queuePreview);
  $('#pv-simple').addEventListener('click', () => { splitSample = false; refreshPreview(); });
  $('#pv-split').addEventListener('click', () => { splitSample = true; refreshPreview(); });
  $('#p-mejorado').addEventListener('click', () => { $('#tpl').value = tpl.presets.mejorado; refreshPreview(); });
  $('#p-clasico').addEventListener('click', () => { $('#tpl').value = tpl.presets.clasico; refreshPreview(); });
  refreshPreview();

  const chats = $('#chats');
  for (const c of state.catalog.countries) {
    const row = h(`
      <div class="field">
        <label>${esc(c.emoji)} ${esc(c.name)}</label>
        <input value="${esc(c.telegram_chat_id || '')}" placeholder="-100… (vacio = grupo de respaldo)">
      </div>
    `).firstElementChild;
    const input = row.querySelector('input');
    input.addEventListener('change', async () => {
      try {
        await api(`/countries/${c.id}`, { method: 'PATCH', body: { telegram_chat_id: input.value } });
        await refreshCatalog();
        toast(`${c.name}: grupo actualizado`, 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    chats.append(row);
  }

  $('#tpl-save').addEventListener('click', async () => {
    try {
      await api('/settings/template', { method: 'PUT', body: { template: $('#tpl').value } });
      toast('Plantilla guardada', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  $('#tpl-reset').addEventListener('click', () => {
    $('#tpl').value = tpl.default;
  });
}

/* ------------------------------ navegacion ------------------------------ */

function goBack() {
  if (state.screen === 'wizard' && state.step > 1) {
    state.step -= 1;
    renderWizard();
    return;
  }
  renderHome();
}

$('#btn-back').addEventListener('click', goBack);
$('#btn-report').addEventListener('click', () => renderReport());
$('#btn-settings').addEventListener('click', () => renderSettings().catch((e) => toast(e.message, 'bad')));

async function refreshCatalog() {
  state.catalog = await api('/catalog');
}

async function boot() {
  try {
    const me = await api('/auth/me');
    state.user = me.user;
    state.authRequired = me.auth_required !== false;
  } catch {
    renderLogin();
    return;
  }
  await refreshCatalog();
  renderHome();
}

boot();
