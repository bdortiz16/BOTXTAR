'use strict';

/* Pagina publica: ventana de acceso y de alta de cuenta. */

const $ = (sel) => document.querySelector(sel);

const modal = $('#modal');
const tabLogin = $('#tab-login');
const tabRegister = $('#tab-register');
const formLogin = $('#form-login');
const formRegister = $('#form-register');
const msgBox = $('#msg');

let signupState = null;

function message(text, kind) {
  msgBox.innerHTML = '';
  if (!text) return;
  const el = document.createElement('div');
  el.className = `msg ${kind || ''}`;
  el.textContent = text;
  msgBox.appendChild(el);
}

function showTab(which) {
  const login = which === 'login';
  tabLogin.setAttribute('aria-selected', String(login));
  tabRegister.setAttribute('aria-selected', String(!login));
  formLogin.hidden = !login;
  formRegister.hidden = login;
  message('');
  if (!login) loadSignupState();
  setTimeout(() => (login ? $('#li-user') : $('#re-name')).focus(), 60);
}

function open(which) {
  showTab(which);
  if (!modal.open) modal.showModal();
}

/**
 * Pregunta al servidor si el registro esta abierto y si pedira codigo, para no
 * mostrar un campo que no hace falta ni dejar que alguien llene el formulario
 * completo antes de enterarse de que necesita una invitacion.
 */
async function loadSignupState() {
  const hint = $('#reg-hint');
  const codeField = $('#code-field');
  try {
    if (!signupState) {
      const res = await fetch('/api/auth/signup-state');
      signupState = await res.json();
    }
    codeField.hidden = !signupState.code_required;
    $('#re-code').required = Boolean(signupState.code_required);

    if (signupState.first_account) {
      hint.textContent = 'Esta sera la primera cuenta: queda como administrador.';
    } else if (signupState.code_required) {
      hint.textContent = 'Necesitas el código de invitación de tu empresa.';
    } else {
      hint.textContent = 'El registro está cerrado. Pídele acceso al administrador.';
      formRegister.querySelector('button[type=submit]').disabled = true;
    }
  } catch {
    hint.textContent = 'No se pudo comprobar el estado del registro.';
  }
}

async function submit(form, url, body) {
  const button = form.querySelector('button[type=submit]');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Un momento…';
  message('');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Algunos errores traen el detalle aparte; sin esto solo se veia el
      // titulo y no habia forma de saber que arreglar.
      const detalle = Array.isArray(data.problemas) ? data.problemas.join(' ') : '';
      throw new Error([data.error, detalle].filter(Boolean).join(' — ')
        || `Error ${res.status}`);
    }
    message('Listo, entrando…', 'ok');
    window.location.href = '/app';
  } catch (err) {
    message(err.message, 'bad');
    button.disabled = false;
    button.textContent = original;
  }
}

formLogin.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(formLogin, '/api/auth/login', {
    user: $('#li-user').value,
    password: $('#li-pass').value,
  });
});

formRegister.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(formRegister, '/api/auth/register', {
    user: $('#re-user').value,
    password: $('#re-pass').value,
    name: $('#re-name').value,
    code: $('#re-code').value,
  });
});

tabLogin.addEventListener('click', () => showTab('login'));
tabRegister.addEventListener('click', () => showTab('register'));

for (const btn of document.querySelectorAll('[data-open]')) {
  btn.addEventListener('click', () => open(btn.dataset.open));
}
for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => modal.close());
}

// Cerrar al tocar fuera de la ventana.
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});

// Si alguien llega desde la app sin sesion, se abre el acceso de una vez.
if (new URLSearchParams(window.location.search).has('login')) open('login');
