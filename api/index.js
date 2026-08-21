'use strict';

/**
 * Punto de entrada para Vercel.
 *
 * Vercel invoca este archivo como funcion serverless; Express se encarga del
 * resto. Los archivos de `public/` los sirve la CDN de Vercel directamente
 * (ver vercel.json), asi que aqui solo llegan la API y las rutas de la app.
 */
module.exports = require('../src/server');
