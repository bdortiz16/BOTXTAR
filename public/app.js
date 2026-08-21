'use strict';

/* ==========================================================================
   BOTXTAR — asistente de envios
   Flujo: fecha -> pais -> monto y tasa -> tipo -> destinos -> USDT -> enviar
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);

/** Los estados se muestran con palabra, no solo con color. */
const STATUS_LABEL = {
  DRAFT: 'Borrador',
  SENT: 'Enviada',
  COMPLETED: 'Pagada',
  CANCELLED: 'Anulada',
};
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

/* --------------------------- selector con busqueda ---------------------- */

let comboId = 0;

/**
 * Campo de texto con lista de sugerencias filtrada.
 *
 * Reemplaza al `datalist` del navegador, que Safari en iPhone no implementa:
 * ahi el campo quedaba como texto libre y el banco se escribia a mano, con
 * las erratas que eso trae. Sigue admitiendo un valor que no este en la
 * lista, y ofrece guardarlo para la proxima.
 */
function attachCombo(input, opciones, { onAdd } = {}) {
  const id = `combo-${++comboId}`;
  const caja = document.createElement('div');
  caja.className = 'combo';
  input.parentNode.insertBefore(caja, input);
  caja.appendChild(input);

  const lista = document.createElement('ul');
  lista.className = 'combo-list';
  lista.id = id;
  lista.setAttribute('role', 'listbox');
  lista.hidden = true;
  caja.appendChild(lista);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');

  let activo = -1;
  let visibles = [];

  const normaliza = (t) => String(t || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  function cerrar() {
    lista.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activo = -1;
  }

  function elegir(valor) {
    input.value = valor;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    cerrar();
  }

  function pintar() {
    const q = normaliza(input.value);
    visibles = q
      ? opciones.filter((o) => normaliza(o).includes(q)).slice(0, 8)
      : opciones.slice(0, 8);

    const exacto = opciones.some((o) => normaliza(o) === q);
    lista.innerHTML = '';

    for (const o of visibles) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = o;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); elegir(o); });
      lista.appendChild(li);
    }

    // Un banco que no esta en la lista se puede usar igual y guardar.
    if (q && !exacto && onAdd) {
      const li = document.createElement('li');
      li.className = 'combo-add';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = `Usar y guardar «${input.value.trim()}»`;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const valor = input.value.trim();
        elegir(valor);
        onAdd(valor);
      });
      lista.appendChild(li);
    }

    const hay = lista.children.length > 0;
    lista.hidden = !hay;
    input.setAttribute('aria-expanded', String(hay));
    activo = -1;
  }

  function marcar(i) {
    const items = [...lista.children];
    items.forEach((el, n) => {
      el.classList.toggle('active', n === i);
      el.setAttribute('aria-selected', String(n === i));
    });
    if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', pintar);
  input.addEventListener('input', pintar);
  input.addEventListener('blur', () => setTimeout(cerrar, 120));
  input.addEventListener('keydown', (e) => {
    const items = [...lista.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (lista.hidden) { pintar(); return; }
      e.preventDefault();
      activo = e.key === 'ArrowDown'
        ? Math.min(activo + 1, items.length - 1)
        : Math.max(activo - 1, 0);
      marcar(activo);
    } else if (e.key === 'Enter' && !lista.hidden && activo >= 0) {
      e.preventDefault();
      items[activo].dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true }));
    } else if (e.key === 'Escape') {
      cerrar();
    }
  });

  return input;
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

/**
 * El acceso vive en la pagina publica, para no mantener dos pantallas de
 * login distintas. Aqui solo se redirige con la ventana ya abierta.
 */
function renderLogin() {
  state.screen = 'login';
  window.location.href = '/?login=1';
}

/* -------------------------------- inicio -------------------------------- */

/** Iniciales para el avatar, a partir del nombre o del usuario. */
function initials(name, username) {
  const fuente = (name || username || '?').trim();
  const partes = fuente.split(/[\s._@-]+/).filter(Boolean);
  const letras = partes.length >= 2
    ? partes[0][0] + partes[1][0]
    : fuente.slice(0, 2);
  return letras.toUpperCase();
}

function moneyLines(list, vacio = 'Sin movimientos') {
  if (!list || !list.length) return `<div class="muted small">${vacio}</div>`;
  return list.map((r) => `
    <div class="line">
      <span class="k">${esc(r.currency)}</span>
      <span class="v">${esc(r.display)}</span>
    </div>`).join('');
}

/**
 * Pantalla de inicio.
 *
 * Antes se entraba directo a la cuadricula de paises, que responde "que voy a
 * hacer" pero no "como va el dia". Ahora el resumen va primero y el alta de un
 * envio es la accion principal.
 */
async function renderHome() {
  state.screen = 'home';
  state.step = 0;
  $('#btn-report').classList.remove('hidden');
  $('#btn-settings').classList.remove('hidden');
  $('#btn-back').classList.add('hidden');

  const avisos = state.catalog.warnings || [];
  setHeader('Inicio', '', false);
  view.innerHTML = '<div class="muted small center mt">Cargando…</div>';

  let data;
  try {
    data = await api('/dashboard');
  } catch (err) {
    view.innerHTML = '';
    view.append(h(`<div class="alert bad">${esc(err.message)}</div>`));
    return;
  }

  const nombre = data.user.name || data.user.username;
  const hoy = data.today_totals;
  const mes = data.month_totals;
  const pend = data.pending;
  setHeader('Inicio', `${esc(data.today)}`, false);

  view.innerHTML = '';
  view.append(h(`
    <section class="greeting">
      <span class="avatar" aria-hidden="true">${esc(initials(data.user.name, data.user.username))}</span>
      <span class="greeting-text">
        <span class="hi">${esc(data.greeting)},</span>
        <strong>${esc(nombre)}</strong>
      </span>
    </section>

    <div id="avisos"></div>

    <div class="panel">
      <h2>Hoy</h2>
      <div class="stats stats-3">
        <div class="stat">
          <div class="k">Operaciones</div>
          <div class="v">${hoy.operations}</div>
        </div>
        <div class="stat">
          <div class="k">Destinos</div>
          <div class="v">${hoy.transfers + hoy.cash_deliveries}</div>
        </div>
        <div class="stat ${pend.sent_unpaid || pend.drafts ? 'attention' : ''}">
          <div class="k">Por pagar</div>
          <div class="v">${pend.sent_unpaid}</div>
        </div>
      </div>
      <div class="summary mt">
        <div class="sublabel">Recibido de clientes</div>
        ${moneyLines(hoy.received, 'Todavía no hay envíos hoy')}
        <div class="sublabel">Pagado</div>
        ${moneyLines(hoy.paid, '—')}
        ${Number(hoy.usdt.quantity) > 0
          ? `<div class="line"><span class="k">USDT vendidos</span><span class="v">${esc(hoy.usdt.quantity_display)}</span></div>`
          : ''}
      </div>
    </div>

    <button class="btn big-action" id="nueva">
      <span class="ico" aria-hidden="true">＋</span>
      <span class="txt">
        <strong>Nuevo envío</strong>
        <small>Monto, tasa y destinos</small>
      </span>
    </button>

    <div class="tiles">
      <button class="tile" id="t-informe">
        <span class="ico" aria-hidden="true">📊</span>
        <strong>Informe</strong>
        <small>${mes.operations} este mes</small>
      </button>
      <button class="tile" id="t-pendientes">
        <span class="ico" aria-hidden="true">🕒</span>
        <strong>Pendientes</strong>
        <small>${pend.drafts} sin enviar</small>
      </button>
      <button class="tile" id="t-ajustes">
        <span class="ico" aria-hidden="true">⚙️</span>
        <strong>Ajustes</strong>
        <small>Telegram y cuenta</small>
      </button>
    </div>

    ${pend.amount.length ? `
    <div class="panel">
      <h2>Enviado y sin marcar como pagado</h2>
      <div class="summary">${moneyLines(pend.amount)}</div>
      <div class="hint">Marca cada operación como pagada cuando salga del banco, para que el pendiente refleje la realidad.</div>
    </div>` : ''}

    <div class="panel">
      <h2>Últimas operaciones</h2>
      <div class="oplist" id="recent"></div>
    </div>
  `));

  // Los avisos van compactos: informan sin quedarse con la primera pantalla.
  const caja = $('#avisos');
  if (avisos.length) {
    const grave = avisos.some((w) => w.level === 'bad');
    const resumen = h(`
      <details class="notice ${grave ? 'bad' : ''}">
        <summary>
          <span class="dot" aria-hidden="true"></span>
          ${avisos.length === 1 ? 'Hay 1 aviso de configuración' : `Hay ${avisos.length} avisos de configuración`}
        </summary>
        <div class="notice-body">
          ${avisos.map((w) => `<p>${esc(w.text)}</p>`).join('')}
        </div>
      </details>
    `);
    caja.append(resumen);
  }

  $('#nueva').addEventListener('click', renderPickCountry);
  $('#t-informe').addEventListener('click', () => renderReport());
  $('#t-ajustes').addEventListener('click', () => renderSettings().catch((e) => toast(e.message, 'bad')));
  $('#t-pendientes').addEventListener('click', () => renderReport({ status: 'DRAFT' }));

  const lista = $('#recent');
  if (!data.recent.length) {
    lista.append(h('<div class="muted small">Todavía no hay operaciones registradas.</div>'));
  } else {
    for (const op of data.recent) lista.append(opCard(op));
  }
  window.scrollTo({ top: 0 });
}

/** Fecha y cuadricula de paises: el primer paso del alta de un envio. */
function renderPickCountry() {
  state.screen = 'pick-country';
  setHeader('Nuevo envío', 'Elige la fecha y el país', true);

  const countries = state.catalog.countries.filter((c) => Number(c.is_origin) === 1);

  view.innerHTML = '';
  view.append(h(`
    <div class="panel">
      <h2>Fecha de la operación</h2>
      <input type="date" id="op-date" value="${esc(state.catalog.today)}">
      <div class="hint">Todas las operaciones del día quedan bajo esta fecha en el informe.</div>
    </div>

    <span class="badge-title">ENVIOS</span>
    <div class="panel">
      <div class="countries" id="grid"></div>
    </div>
  `));

  const grid = $('#grid');
  for (const c of countries) {
    const missingChat = !c.telegram_chat_id;
    const btn = h(`
      <button class="country" data-id="${esc(c.id)}">
        <span class="dot" style="background:${esc(c.color)}">${esc(c.emoji || '🌎')}${missingChat ? '<span class="warn-dot" role="img" aria-label="Sin grupo de Telegram"></span>' : ''}</span>
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
      <span class="name">Otro país</span>
      <span class="cur">agregar</span>
    </button>
  `).firstElementChild;
  add.addEventListener('click', renderNewCountry);
  grid.append(add);
  window.scrollTo({ top: 0 });
}

function countryName(id) {
  const c = (state.catalog?.countries || []).find((x) => x.id === id);
  return c ? `${c.emoji} ${c.name}`.trim() : id;
}

function opCard(op) {
  const dd = decimalsOf(op.dest_currency);
  const od = decimalsOf(op.origin_currency);
  const el = h(`
    <button class="opcard" data-id="${op.id}">
      <div class="top">
        <span class="folio">${esc(op.folio)} <span class="pill ${op.status}">${esc(STATUS_LABEL[op.status] || op.status)}</span></span>
        <span class="amt">${esc(fmt(parseAmount(op.dest_amount), dd))} <span class="cur">${esc(op.dest_currency)}</span></span>
      </div>
      <div class="meta">
        ${esc(op.op_date)} · ${esc(countryName(op.origin_country_id))} ·
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
  setHeader('Nuevo país', 'Agrega un destino que aún no existe', true);
  view.innerHTML = '';
  view.append(h(`
    <form class="panel" id="nc-form">
      <h2>Datos del país</h2>
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
        <div class="hint">Opcional. Sin esto, la operación usa el grupo de respaldo.
        Para obtenerlo: agrega el bot al grupo y mira Ajustes › Telegram.</div>
      </div>
      <div class="field">
        <label for="nc-color">Color del círculo</label>
        <input id="nc-color" type="color" value="#3f51b5" style="min-height:48px;padding:4px">
      </div>
      <button class="btn" type="submit">Guardar país</button>
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
      toast('País agregado', 'ok');
      renderPickCountry();
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
    1: 'Monto y tasa', 2: 'Cómo se entrega', 3: 'Destinos', 4: 'USDT y cliente', 5: 'Revisar y enviar',
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
        <div class="hint">Escríbelo como quieras: el campo separa los miles solo.</div>
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
        <label for="f-dest">País de pago</label>
        <select id="f-dest">${destOptions}</select>
      </div>
    </div>

    <div class="calc empty" id="calc">
      <div class="label">Monto a pagar</div>
      <div class="value">—</div>
      <div class="formula">Escribe el monto y la tasa</div>
    </div>

    <button class="btn" id="next" disabled>Siguiente</button>
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
      <h2>Cómo se entrega</h2>
      <div class="choices">
        <button class="choice" type="button" data-t="TRANSFER" aria-pressed="${d.delivery_type === 'TRANSFER'}">
          <span class="ico">🏦</span><span class="t">Transferencia</span>
        </button>
        <button class="choice" type="button" data-t="CASH" aria-pressed="${d.delivery_type === 'CASH'}">
          <span class="ico">💵</span><span class="t">Efectivo</span>
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

/** Se guarda en mayusculas, se muestra en oracion. */
const ACCOUNT_LABEL = { AHORROS: 'Ahorros', CORRIENTE: 'Corriente', DIGITAL: 'Digital' };

function docTypesFor(countryId) {
  return DOC_TYPES[countryId] || ['CC', 'DNI', 'PAS', 'OTRO'];
}

function stepDestinations() {
  const d = state.draft;
  const isTransfer = d.delivery_type === 'TRANSFER';
  const banks = [...(state.catalog.banks[d.dest_country_id] || [])]
    .sort((a, b) => a.localeCompare(b, 'es'));

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
    <button class="btn" id="next" type="button">Siguiente</button>
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
              <label>Número</label>
              <input data-k="doc_number" value="${esc(dest.doc_number)}" inputmode="numeric">
            </div>
          </div>
          <div class="field">
            <label>Banco</label>
            <input data-k="bank_name" class="bank" value="${esc(dest.bank_name)}" placeholder="Escribe para buscar">
          </div>
          <div class="row">
            <div class="field">
              <label>Número de cuenta</label>
              <input data-k="account_number" value="${esc(dest.account_number)}" inputmode="numeric">
            </div>
            <div class="field">
              <label>Tipo de cuenta</label>
              <select data-k="account_type">
                ${ACCOUNT_TYPES.map((t) => `<option value="${esc(t)}" ${dest.account_type === t ? 'selected' : ''}>${esc(ACCOUNT_LABEL[t])}</option>`).join('')}
              </select>
            </div>
          </div>
        ` : `
          <div class="field">
            <label>Ciudad</label>
            <input data-k="city" value="${esc(dest.city)}" placeholder="Ej: Bogota">
          </div>
          <div class="field">
            <label>Punto o dirección de entrega</label>
            <input data-k="address" value="${esc(dest.address)}" placeholder="Barrio, direccion, referencia">
          </div>
          <div class="row">
            <div class="field">
              <label>Quién recibe</label>
              <input data-k="contact_name" value="${esc(dest.contact_name)}">
            </div>
            <div class="field">
              <label>Teléfono</label>
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
              <label>Número</label>
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
          <label>Referencia o nota</label>
          <input data-k="reference" value="${esc(dest.reference)}" placeholder="Opcional">
        </div>
      </div>
    `).firstElementChild;

    const bankEl = el.querySelector('.bank');
    if (bankEl) {
      attachCombo(bankEl, bankList, {
        onAdd: async (nombre) => {
          try {
            await api(`/countries/${d.dest_country_id}/banks`, { method: 'POST', body: { name: nombre } });
            await refreshCatalog();
            bankList.push(nombre);
            bankList.sort((a, b) => a.localeCompare(b, 'es'));
            toast(`«${nombre}» queda en la lista`, 'ok');
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      });
    }

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
    $('#next').textContent = rest === 0n ? 'Siguiente' : (rest > 0n ? 'Falta repartir' : 'Te pasaste del total');
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
      <div class="hint mt">Queda dentro de la misma operación, sale en el mensaje de Telegram y suma en el informe.</div>
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
        <textarea id="f-notes" placeholder="Observaciones de la operación">${esc(d.notes)}</textarea>
      </div>
    </div>
    <button class="btn" id="next" type="button">Revisar</button>
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
              <label>Cantidad de USDT</label>
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
            <label>Wallet o referencia</label>
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
      <h2>Mensaje que llegará a Telegram</h2>
      <pre class="tg" id="tg-preview">Calculando vista previa…</pre>
    </div>
    <div class="btnrow">
      <button class="btn ghost" id="save" type="button">Guardar</button>
      <button class="btn ok" id="send" type="button">Enviar</button>
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
    btn.textContent = 'Enviando…';
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
      btn.textContent = 'Enviar';
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
        <h2>Detalle <span class="pill ${op.status}">${esc(STATUS_LABEL[op.status] || op.status)}</span></h2>
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
        <button class="btn ghost" id="resend" type="button">${op.status === 'SENT' ? 'Reenviar' : 'Enviar'}</button>
        <button class="btn ok" id="complete" type="button">Marcar pagada</button>
      </div>
      <div class="spacer"></div>
      <button class="btn bad" id="cancel-op" type="button">Anular operación</button>
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
      if (!confirm('¿Anular esta operación? No sumará en el informe.')) return;
      await api(`/operations/${id}/status`, { method: 'POST', body: { status: 'CANCELLED' } });
      toast('Operación anulada');
      goHome();
    });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/* -------------------------------- informe ------------------------------- */

async function renderReport({ status } = {}) {
  state.screen = 'report';
  setHeader('Informe', status === 'DRAFT' ? 'Operaciones sin enviar' : 'Resumen contable', true);
  const today = state.catalog.today;
  const first = `${today.slice(0, 8)}01`;

  view.innerHTML = '';
  view.append(h(`
    <div class="panel">
      <h2>Rango de fechas</h2>
      <div class="row">
        <div class="field"><label for="r-from">Desde</label><input type="date" id="r-from" value="${esc(first)}"></div>
        <div class="field"><label for="r-to">Hasta</label><input type="date" id="r-to" value="${esc(today)}"></div>
      </div>
      <div class="row">
        <div class="field">
          <label for="r-country">País</label>
          <select id="r-country">
            <option value="">Todos</option>
            ${state.catalog.countries.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="r-status">Estado</label>
          <select id="r-status">
            <option value="">Todos</option>
            ${['DRAFT', 'SENT', 'COMPLETED', 'CANCELLED'].map((st) => `<option value="${st}" ${status === st ? 'selected' : ''}>${esc(STATUS_LABEL[st])}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="btnrow">
        <button class="btn" id="r-go" type="button">Ver</button>
        <button class="btn ghost" id="r-csv" type="button">Exportar CSV</button>
      </div>
    </div>
    <div id="r-out"><div class="muted small center">Elige un rango y toca Ver.</div></div>
  `));

  const query = () => {
    const p = new URLSearchParams();
    if ($('#r-from').value) p.set('from', $('#r-from').value);
    if ($('#r-to').value) p.set('to', $('#r-to').value);
    if ($('#r-country').value) p.set('country', $('#r-country').value);
    if ($('#r-status').value) p.set('status', $('#r-status').value);
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
          <h2>Por país</h2>
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
        : `<div class="alert bad">${esc(status.reason || 'Sin conexión')}</div>`}
      <div class="hint">Para obtener el chat ID de un grupo: agrega el bot al grupo, escribe un mensaje
      y abre <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code>. El id de un grupo
      empieza por <code>-100</code>.</div>
    </div>

    <div class="panel">
      <h2>Conexión automática</h2>
      ${status.ok ? `
        <div class="summary">
          <div class="line">
            <span class="k">Estado</span>
            <span class="v">${status.webhook?.url ? 'Conectado' : 'Sin conectar'}</span>
          </div>
          ${status.webhook?.last_error
            ? `<div class="line"><span class="k">Último error</span><span class="v">${esc(status.webhook.last_error)}</span></div>`
            : ''}
        </div>
        <div class="btnrow mt">
          <button class="btn" id="tg-connect" type="button">${status.webhook?.url ? 'Reconectar' : 'Conectar'}</button>
          ${status.webhook?.url ? '<button class="btn ghost" id="tg-disconnect" type="button">Desconectar</button>' : ''}
        </div>
        <div class="hint">Con esto conectado, el bot detecta solo cuando lo agregas a un grupo.
        Crea el grupo en Telegram, agrega a <b>@${esc(status.bot.username)}</b> y listo: si el nombre
        del grupo dice el país, queda vinculado sin hacer nada más.</div>
      ` : '<div class="hint">Configura primero TELEGRAM_BOT_TOKEN.</div>'}
    </div>

    <div class="panel">
      <h2>Grupos detectados</h2>
      <div id="chats-detectados"></div>
    </div>

    <div class="panel">
      <h2>Grupo por país</h2>
      <div class="hint" style="margin-top:0">Solo hace falta tocar esto si prefieres pegar el ID a mano.</div>
      <div id="chats"></div>
    </div>

    <div class="panel">
      <h2>Formato del mensaje</h2>
      <div class="choices">
        <button class="choice" type="button" id="p-mejorado">
          <span class="ico">✨</span><span class="t">Mejorado</span>
        </button>
        <button class="choice" type="button" id="p-clasico">
          <span class="ico">📄</span><span class="t">Como hoy</span>
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
        <button class="btn" id="tpl-save" type="button">Guardar</button>
        <button class="btn ghost" id="tpl-reset" type="button">Restaurar</button>
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

  // Grupos donde ya esta el bot, con su pais asignado.
  const detectados = $('#chats-detectados');
  const lista = status.chats || [];
  if (!lista.length) {
    detectados.append(h(`<div class="muted small">Todavía no hay ningún grupo.
      Crea uno en Telegram y agrega el bot: aparecerá aquí solo.</div>`));
  } else {
    for (const c of lista) {
      const fila = h(`
        <div class="chat-row">
          <div class="chat-info">
            <strong>${esc(c.title || 'Grupo sin nombre')}</strong>
            <small>${esc(c.chat_id)}${c.status === 'LEFT' ? ' · el bot ya no está' : ''}</small>
          </div>
          <select aria-label="País de ${esc(c.title || c.chat_id)}">
            <option value="">Sin asignar</option>
            ${state.catalog.countries.map((p) => `<option value="${esc(p.id)}" ${p.id === c.country_id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)}</option>`).join('')}
          </select>
        </div>
      `).firstElementChild;
      fila.querySelector('select').addEventListener('change', async (e) => {
        try {
          await api(`/telegram/chats/${encodeURIComponent(c.chat_id)}/link`, {
            method: 'POST', body: { country_id: e.target.value },
          });
          await refreshCatalog();
          toast(e.target.value ? 'Grupo vinculado' : 'Grupo sin asignar', 'ok');
          renderSettings();
        } catch (err) {
          toast(err.message, 'bad');
        }
      });
      detectados.append(fila);
    }
  }

  $('#tg-connect')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api('/telegram/connect', { method: 'POST', body: {} });
      toast('Bot conectado. Ya detecta los grupos solo.', 'ok');
      renderSettings();
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
    }
  });

  $('#tg-disconnect')?.addEventListener('click', async () => {
    try {
      await api('/telegram/disconnect', { method: 'POST', body: {} });
      toast('Bot desconectado');
      renderSettings();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

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

  view.append(h(`
    <div class="panel">
      <h2>Sesión</h2>
      <div class="summary">
        <div class="line"><span class="k">Conectado como</span><span class="v">${esc(state.user)}</span></div>
      </div>
      <button class="btn bad mt" id="logout" type="button">Cerrar sesión</button>
    </div>
  `));
  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  });
}

/* ------------------------------ navegacion ------------------------------ */

function goBack() {
  if (state.screen === 'wizard' && state.step > 1) {
    state.step -= 1;
    renderWizard();
    return;
  }
  // Desde el primer paso se vuelve a elegir pais; desde ahi, al inicio.
  if (state.screen === 'wizard') {
    renderPickCountry();
    return;
  }
  goHome();
}

function goHome() {
  renderHome().catch((err) => toast(err.message, 'bad'));
}

/**
 * Separa la barra superior del contenido solo cuando hay algo desplazado
 * debajo. Es el mismo efecto de borde que usan las barras del sistema: sin
 * contenido detras, la barra se funde con el fondo.
 */
const topbar = document.querySelector('.topbar');
let ticking = false;
window.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    topbar.classList.toggle('scrolled', window.scrollY > 2);
    ticking = false;
  });
}, { passive: true });

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
  await renderHome();
}

boot();
