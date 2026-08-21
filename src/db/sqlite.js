'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ddl } = require('./schema');

/**
 * Motor para desarrollo local y pruebas: el SQLite que ya trae Node, sin
 * compilar nada. La interfaz es asincrona aunque por debajo sea sincrona,
 * para que el resto del codigo no sepa contra que motor esta hablando.
 *
 * El archivo se abre en el primer uso, no al cargar el modulo. Si se abriera
 * antes, un disco de solo lectura (como el de Vercel) tumbaria el modulo
 * entero y la peticion saldria como un 500 sin explicacion, en vez de un
 * error que diga que pasa.
 */
function createSqlite(file) {
  let handle = null;

  function conn() {
    if (handle) return handle;
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    handle = new DatabaseSync(file);
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA foreign_keys = ON');
    return handle;
  }

  const norm = (row) => (row ? { ...row } : row);

  return {
    dialect: 'sqlite',

    async all(sql, params = []) {
      return conn().prepare(sql).all(...params).map(norm);
    },

    async get(sql, params = []) {
      return norm(conn().prepare(sql).get(...params));
    },

    async run(sql, params = []) {
      const info = conn().prepare(sql).run(...params);
      return { changes: Number(info.changes), rowid: Number(info.lastInsertRowid) };
    },

    /** SQLite es de un solo escritor: basta con BEGIN/COMMIT sobre la conexion. */
    async tx(fn) {
      const db = conn();
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(this);
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* la transaccion ya murio */ }
        throw err;
      }
    },

    async createSchema() {
      const db = conn();
      for (const stmt of ddl({ pk: 'INTEGER PRIMARY KEY AUTOINCREMENT' })) db.exec(stmt);
    },

    async close() {
      if (handle) handle.close();
      handle = null;
    },
  };
}

module.exports = { createSqlite };
