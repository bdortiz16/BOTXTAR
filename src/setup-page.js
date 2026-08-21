'use strict';

const config = require('./config');

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Pantalla que se muestra cuando la app esta desplegada pero le falta
 * configuracion. Es preferible a un error crudo: dice exactamente que variable
 * falta y donde ponerla, en vez de dejar a alguien adivinando por que la app
 * "no funciona".
 */
function setupPage(problems) {
  const items = problems.map((p) => `<li>${esc(p)}</li>`).join('');
  const donde = config.serverless
    ? 'Vercel &rsaquo; Settings &rsaquo; Environment Variables'
    : 'el archivo .env del servidor';

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BOTXTAR · falta configurar</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px 16px 48px; background:#1b1d21; color:#f3f4f6;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         font-size:16px; line-height:1.5; }
  .box { max-width:560px; margin:0 auto; }
  h1 { font-size:1.35rem; margin:0 0 6px; }
  .sub { color:#a5acb8; font-size:.9rem; margin:0 0 22px; }
  .panel { background:#34383f; border-radius:16px; padding:18px; margin-bottom:14px; }
  h2 { font-size:.78rem; text-transform:uppercase; letter-spacing:1.2px;
       color:#a5acb8; margin:0 0 12px; }
  ul { margin:0; padding-left:20px; }
  li { margin-bottom:12px; overflow-wrap:anywhere; }
  pre { background:#14161a; border:1px solid #4b515a; border-radius:12px;
        padding:14px; overflow-x:auto; font-size:.82rem; margin:0;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .ok { color:#6ee7a8; }
</style>
</head><body><div class="box">
  <h1>⚙️ Falta configurar BOTXTAR</h1>
  <p class="sub">La app esta desplegada y funcionando. Solo faltan estos datos
  para que pueda guardar operaciones y mantener la sesion abierta.</p>

  <div class="panel">
    <h2>Que falta</h2>
    <ul>${items}</ul>
  </div>

  <div class="panel">
    <h2>Donde ponerlo</h2>
    <p style="margin:0 0 12px">En ${donde}:</p>
    <pre>SESSION_SECRET=&lt;32 bytes en hexadecimal&gt;
APP_USERS=bryan:tu-clave-secreta
TELEGRAM_BOT_TOKEN=&lt;token de BotFather&gt;
TIMEZONE=America/Bogota</pre>
  </div>

  <div class="panel">
    <h2>La base de datos</h2>
    <p style="margin:0">En Vercel: <b>Storage &rsaquo; Create Database &rsaquo; Postgres</b>,
    y conectala a este proyecto. La variable <code>POSTGRES_URL</code> se agrega
    sola. Las tablas y los paises se crean en la primera visita.</p>
  </div>

  <p class="sub">Cuando termines, vuelve a desplegar y esta pantalla desaparece.</p>
</div></body></html>`;
}

module.exports = { setupPage };
