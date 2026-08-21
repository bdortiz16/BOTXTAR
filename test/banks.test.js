'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botxtar-banks-'));
process.env.DB_FILE = path.join(tmp, 'banks.db');

const { db, init, seed } = require('../src/db');
const { SEED_BANKS } = require('../src/db/schema');

test.before(async () => { await init(); });

test('cada pais trae su lista de bancos', async () => {
  for (const [pais, esperados] of Object.entries(SEED_BANKS)) {
    const filas = await db.all('SELECT name FROM banks WHERE country_id = ?', [pais]);
    assert.ok(filas.length >= esperados.length,
      `${pais} tiene ${filas.length} bancos y se esperaban al menos ${esperados.length}`);
  }
});

test('Colombia trae los bancos y billeteras que se usan a diario', async () => {
  const filas = await db.all("SELECT name FROM banks WHERE country_id = 'colombia'");
  const nombres = filas.map((f) => f.name);
  for (const banco of ['Bancolombia', 'Nequi', 'Daviplata', 'Davivienda', 'Banco de Bogotá', 'Nu']) {
    assert.ok(nombres.includes(banco), `falta ${banco}`);
  }
  assert.ok(nombres.length >= 35, `solo hay ${nombres.length} bancos para Colombia`);
});

test('no hay bancos repetidos', async () => {
  const filas = await db.all('SELECT country_id, name FROM banks');
  const vistos = new Set();
  for (const f of filas) {
    const clave = `${f.country_id}|${f.name}`;
    assert.ok(!vistos.has(clave), `${clave} esta repetido`);
    vistos.add(clave);
  }
});

test('renombrar a la version con acentos no duplica la entrada', async () => {
  // Simula una base creada antes del cambio, con las dos formas conviviendo.
  await db.run("DELETE FROM banks WHERE country_id = 'colombia' AND name = 'Banco de Bogotá'");
  await db.run("INSERT INTO banks (country_id, name) VALUES ('colombia', 'Banco de Bogota')");
  await seed();

  const filas = await db.all(
    "SELECT name FROM banks WHERE country_id = 'colombia' AND name IN ('Banco de Bogota', 'Banco de Bogotá')"
  );
  assert.deepStrictEqual(filas.map((f) => f.name), ['Banco de Bogotá'],
    'debe quedar solo la version con acento');

  // Y si ya conviven las dos, tambien se resuelve.
  await db.run("INSERT INTO banks (country_id, name) VALUES ('colombia', 'Banco de Bogota')");
  await seed();
  const despues = await db.all(
    "SELECT name FROM banks WHERE country_id = 'colombia' AND name IN ('Banco de Bogota', 'Banco de Bogotá')"
  );
  assert.strictEqual(despues.length, 1, 'no puede quedar la version vieja');
  assert.strictEqual(despues[0].name, 'Banco de Bogotá');
});

test('un banco agregado a mano sobrevive a volver a sembrar', async () => {
  await db.run("INSERT INTO banks (country_id, name) VALUES ('colombia', 'Banco Mi Barrio')");
  await seed();
  const fila = await db.get(
    "SELECT name FROM banks WHERE country_id = 'colombia' AND name = 'Banco Mi Barrio'"
  );
  assert.ok(fila, 'los bancos agregados por el operador no se pueden perder');
});
