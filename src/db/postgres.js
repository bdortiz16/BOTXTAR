'use strict';

const { ddl } = require('./schema');

/**
 * Motor para produccion en Vercel (Vercel Postgres o Neon).
 *
 * Vercel es serverless: el disco se borra entre ejecuciones, asi que la base
 * tiene que estar fuera del contenedor. El pool se crea una vez por instancia
 * y se reutiliza mientras la instancia siga viva.
 */

/** Traduce los `?` del SQL a la numeracion `$1, $2` que usa Postgres. */
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function sslFor(url) {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  if (local || /sslmode=disable/.test(url)) return false;
  // Escape para proveedores con certificado propio; por defecto se verifica.
  if (process.env.DB_SSL_INSECURE === '1') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

function createPostgres(url) {
  // Se carga aqui y no arriba para que la app siga arrancando en local
  // aunque `pg` no este instalado.
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: Number(process.env.PG_POOL_MAX || 3),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    // Deja que el proceso termine cuando no hay conexiones en uso, en vez de
    // quedarse vivo esperando el timeout del pool.
    allowExitOnIdle: true,
  });
  pool.on('error', (err) => console.error('[postgres] error en el pool:', err.message));

  function wrap(runner) {
    return {
      dialect: 'postgres',

      async all(sql, params = []) {
        const res = await runner.query(toPgParams(sql), params);
        return res.rows;
      },

      async get(sql, params = []) {
        const res = await runner.query(toPgParams(sql), params);
        return res.rows[0];
      },

      async run(sql, params = []) {
        const res = await runner.query(toPgParams(sql), params);
        return { changes: res.rowCount, rowid: res.rows[0]?.id };
      },

      async tx(fn) {
        // Dentro de una transaccion se reutiliza el mismo cliente.
        if (runner !== pool) return fn(this);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn(wrap(client));
          await client.query('COMMIT');
          return out;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { /* conexion perdida */ }
          throw err;
        } finally {
          client.release();
        }
      },

      async createSchema() {
        const client = await pool.connect();
        try {
          // Varias instancias pueden arrancar a la vez; el lock evita que dos
          // creen las mismas tablas y una falle.
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(728311)');
          for (const stmt of ddl({ pk: 'SERIAL PRIMARY KEY' })) await client.query(stmt);
          await client.query('COMMIT');
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { /* conexion perdida */ }
          throw err;
        } finally {
          client.release();
        }
      },

      async close() {
        await pool.end();
      },
    };
  }

  return wrap(pool);
}

module.exports = { createPostgres, toPgParams };
