'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const apiRouter = require('./routes/api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));

app.get('/health', (req, res) => res.json({ ok: true, env: config.env }));

app.use('/api', apiRouter);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  extensions: ['html'],
  maxAge: config.env === 'production' ? '1h' : 0,
}));

// La interfaz es una sola pagina: cualquier ruta no-API devuelve el index.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Manejador de errores: los de validacion salen como 400 con texto legible.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err.name === 'ValidationError' ? 400 : 500);
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Error interno' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`BOTXTAR escuchando en http://localhost:${config.port}`);
    if (!config.authEnabled) {
      console.warn('[aviso] Sin ADMIN_PASSWORD/APP_USERS: la app corre SIN clave. No la publiques asi.');
    }
    if (!config.telegramEnabled) {
      console.warn('[aviso] Sin TELEGRAM_BOT_TOKEN: las operaciones se guardan pero no se envian.');
    }
  });
}

module.exports = app;
