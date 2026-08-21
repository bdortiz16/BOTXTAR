'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ddl } = require('./schema');

/**
 * Motor para desarrollo local y pruebas: el SQLite que ya trae Node, sin
 * compilar nada. La interfaz es asincrona aunque por debajo sea sincrona,
 * para que el resto del codigo no sepa contra que motor esta hablando.
 */
function createSqlite(file) {
  // Se carga aqui y no arriba para que el despliegue con Postgres no dependa
  // de que el Node del servidor traiga el modulo sqlite.
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const norm = (row) => (row ? { ...row } : row);

  return {
    dialect: 'sqlite',

    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map(norm);
    },

    async get(sql, params = []) {
      return norm(db.prepare(sql).get(...params));
    },

    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: Number(info.changes), rowid: Number(info.lastInsertRowid) };
    },

    /** SQLite es de un solo escritor: basta con BEGIN/COMMIT sobre la conexion. */
    async tx(fn) {
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
      for (const stmt of ddl({ pk: 'INTEGER PRIMARY KEY AUTOINCREMENT' })) db.exec(stmt);
    },

    async close() {
      db.close();
    },
  };
}

module.exports = { createSqlite };
