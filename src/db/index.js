'use strict';

const config = require('../config');
const { createSqlite } = require('./sqlite');
const { createPostgres } = require('./postgres');
const { SEED_COUNTRIES, SEED_BANKS } = require('./schema');

/**
 * Elige el motor segun el entorno:
 *
 *  - Con POSTGRES_URL o DATABASE_URL definido, usa Postgres. Es lo que hace
 *    falta en Vercel, donde el disco del contenedor se borra en cada
 *    despliegue y un archivo SQLite se perderia con todas las operaciones.
 *  - Sin esas variables, usa el SQLite que trae Node. Asi el entorno local y
 *    las pruebas no necesitan instalar ni levantar nada.
 */
const db = config.databaseUrl
  ? createPostgres(config.databaseUrl)
  : createSqlite(config.dbFile);

async function seed() {
  const now = new Date().toISOString();

  for (const c of SEED_COUNTRIES) {
    await db.run(
      `INSERT INTO countries (id, name, emoji, currency, color, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.name, c.emoji, c.currency, c.color, c.sort_order, now]
    );
  }

  // Corrige la ortografia de los nombres iniciales sin pisar los que alguien
  // haya renombrado a mano.
  for (const [id, viejo, nuevo] of [['peru', 'Peru', 'Perú'], ['mexico', 'Mexico', 'México']]) {
    await db.run('UPDATE countries SET name = ? WHERE id = ? AND name = ?', [nuevo, id, viejo]);
  }

  /**
   * Los nombres de banco pasaron a llevar acentos. Una base creada antes tiene
   * la version sin acentos, y una insercion a secas dejaria las dos. Se
   * renombra primero, y si por lo que sea ya conviven las dos, se borra la
   * vieja. La busqueda del formulario ignora acentos, asi que escribir
   * "bogota" sigue encontrando "Banco de Bogotá".
   */
  const sinAcentos = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  for (const [countryId, names] of Object.entries(SEED_BANKS)) {
    for (const name of names) {
      const viejo = sinAcentos(name);
      if (viejo !== name) {
        await db.run(
          `DELETE FROM banks WHERE country_id = ? AND name = ?
             AND EXISTS (SELECT 1 FROM banks b2 WHERE b2.country_id = ? AND b2.name = ?)`,
          [countryId, viejo, countryId, name]
        );
        await db.run('UPDATE banks SET name = ? WHERE country_id = ? AND name = ?',
          [name, countryId, viejo]);
      }
      await db.run(
        `INSERT INTO banks (country_id, name) VALUES (?, ?)
         ON CONFLICT (country_id, name) DO NOTHING`,
        [countryId, name]
      );
    }
  }
}

let initPromise = null;

/**
 * Crea el esquema y los datos iniciales. Es idempotente y se ejecuta una sola
 * vez por instancia: en Vercel cada arranque en frio la llama de nuevo.
 */
function init() {
  initPromise ||= (async () => {
    await db.createSchema();
    await seed();
    return db;
  })().catch((err) => {
    initPromise = null; // permite reintentar en la proxima peticion
    throw err;
  });
  return initPromise;
}

module.exports = { db, init, seed, SEED_COUNTRIES, SEED_BANKS };
