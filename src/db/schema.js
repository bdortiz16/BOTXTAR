'use strict';

/**
 * Esquema unico para SQLite y Postgres.
 *
 * Lo unico que cambia entre motores es como se declara la clave primaria
 * autoincremental, asi que se pasa como parametro y el resto del DDL es
 * identico. Se usa INTEGER (no BIGINT) a proposito: Postgres devuelve bigint
 * como texto, y eso obligaria a convertir ids en todo el codigo.
 */
function ddl({ pk }) {
  return [
    `CREATE TABLE IF NOT EXISTS countries (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      emoji              TEXT NOT NULL DEFAULT '',
      currency           TEXT NOT NULL,
      telegram_chat_id   TEXT NOT NULL DEFAULT '',
      telegram_thread_id TEXT NOT NULL DEFAULT '',
      color              TEXT NOT NULL DEFAULT '#3f51b5',
      is_origin          INTEGER NOT NULL DEFAULT 1,
      is_destination     INTEGER NOT NULL DEFAULT 1,
      active             INTEGER NOT NULL DEFAULT 1,
      sort_order         INTEGER NOT NULL DEFAULT 100,
      created_at         TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS banks (
      id         ${pk},
      country_id TEXT NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      UNIQUE (country_id, name)
    )`,

    `CREATE TABLE IF NOT EXISTS operations (
      id                  ${pk},
      folio               TEXT NOT NULL UNIQUE,
      op_date             TEXT NOT NULL,
      origin_country_id   TEXT NOT NULL REFERENCES countries(id),
      origin_currency     TEXT NOT NULL,
      origin_amount       TEXT NOT NULL,
      rate                TEXT NOT NULL,
      rate_mode           TEXT NOT NULL DEFAULT 'MULTIPLY',
      dest_country_id     TEXT NOT NULL REFERENCES countries(id),
      dest_currency       TEXT NOT NULL,
      dest_amount         TEXT NOT NULL,
      delivery_type       TEXT NOT NULL,
      client_name         TEXT NOT NULL DEFAULT '',
      client_contact      TEXT NOT NULL DEFAULT '',
      notes               TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'DRAFT',
      created_by          TEXT NOT NULL DEFAULT '',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      sent_at             TEXT,
      telegram_chat_id    TEXT NOT NULL DEFAULT '',
      telegram_message_id TEXT NOT NULL DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_operations_date    ON operations(op_date)',
    'CREATE INDEX IF NOT EXISTS idx_operations_country ON operations(origin_country_id)',
    'CREATE INDEX IF NOT EXISTS idx_operations_status  ON operations(status)',

    `CREATE TABLE IF NOT EXISTS transfers (
      id               ${pk},
      operation_id     INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL DEFAULT 1,
      beneficiary_name TEXT NOT NULL,
      doc_type         TEXT NOT NULL DEFAULT '',
      doc_number       TEXT NOT NULL DEFAULT '',
      bank_name        TEXT NOT NULL DEFAULT '',
      account_number   TEXT NOT NULL DEFAULT '',
      account_type     TEXT NOT NULL DEFAULT '',
      amount           TEXT NOT NULL,
      currency         TEXT NOT NULL,
      reference        TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL DEFAULT 'PENDING'
    )`,
    'CREATE INDEX IF NOT EXISTS idx_transfers_op ON transfers(operation_id)',

    `CREATE TABLE IF NOT EXISTS cash_deliveries (
      id            ${pk},
      operation_id  INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL DEFAULT 1,
      city          TEXT NOT NULL DEFAULT '',
      address       TEXT NOT NULL DEFAULT '',
      contact_name  TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      doc_type      TEXT NOT NULL DEFAULT '',
      doc_number    TEXT NOT NULL DEFAULT '',
      scheduled_at  TEXT NOT NULL DEFAULT '',
      amount        TEXT NOT NULL,
      currency      TEXT NOT NULL,
      reference     TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'PENDING'
    )`,
    'CREATE INDEX IF NOT EXISTS idx_cash_op ON cash_deliveries(operation_id)',

    `CREATE TABLE IF NOT EXISTS usdt_sales (
      id           ${pk},
      operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      position     INTEGER NOT NULL DEFAULT 1,
      quantity     TEXT NOT NULL,
      unit_price   TEXT NOT NULL,
      currency     TEXT NOT NULL,
      gross_amount TEXT NOT NULL,
      network      TEXT NOT NULL DEFAULT '',
      wallet       TEXT NOT NULL DEFAULT '',
      counterparty TEXT NOT NULL DEFAULT '',
      reference    TEXT NOT NULL DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_usdt_op ON usdt_sales(operation_id)',

    `CREATE TABLE IF NOT EXISTS users (
      id            ${pk},
      username      TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'OPERATOR',
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      last_login_at TEXT
    )`,

    `CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS audit_log (
      id           ${pk},
      at           TEXT NOT NULL,
      actor        TEXT NOT NULL DEFAULT '',
      action       TEXT NOT NULL,
      operation_id INTEGER,
      detail       TEXT NOT NULL DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_audit_op ON audit_log(operation_id)',
  ];
}

/** Paises iniciales: los grupos que ya existen mas los destinos habituales. */
const SEED_COUNTRIES = [
  { id: 'colombia',  name: 'Colombia',  emoji: '🇨🇴', currency: 'COP',  color: '#f9a825', sort_order: 10 },
  { id: 'peru',      name: 'Peru',      emoji: '🇵🇪', currency: 'PEN',  color: '#d32f2f', sort_order: 20 },
  { id: 'chile',     name: 'Chile',     emoji: '🇨🇱', currency: 'CLP',  color: '#1976d2', sort_order: 30 },
  { id: 'brasil',    name: 'Brasil',    emoji: '🇧🇷', currency: 'BRL',  color: '#2e7d32', sort_order: 40 },
  { id: 'mexico',    name: 'Mexico',    emoji: '🇲🇽', currency: 'MXN',  color: '#00695c', sort_order: 50 },
  { id: 'venezuela', name: 'Venezuela', emoji: '🇻🇪', currency: 'VES',  color: '#fbc02d', sort_order: 60 },
  { id: 'ecuador',   name: 'Ecuador',   emoji: '🇪🇨', currency: 'USD',  color: '#0288d1', sort_order: 70 },
  { id: 'usdt',      name: 'USDT',      emoji: '🪙', currency: 'USDT', color: '#26a17b', sort_order: 80 },
];

/** Bancos mas usados por pais, para que el operador no tenga que escribirlos. */
const SEED_BANKS = {
  colombia: ['Bancolombia', 'Nequi', 'Daviplata', 'Davivienda', 'BBVA', 'Banco de Bogota',
             'Banco de Occidente', 'Banco Caja Social', 'Scotiabank Colpatria', 'Itau',
             'AV Villas', 'Banco Agrario', 'Banco Falabella', 'Lulo Bank', 'Nu', 'Movii'],
  peru: ['BCP', 'BBVA', 'Interbank', 'Scotiabank', 'BanBif', 'Banco de la Nacion',
         'Yape', 'Plin', 'Caja Arequipa', 'Caja Huancayo'],
  chile: ['Banco de Chile', 'BancoEstado', 'Santander', 'BCI', 'Itau', 'Scotiabank',
          'Banco Falabella', 'Mercado Pago', 'Tenpo'],
  brasil: ['Nubank', 'Banco do Brasil', 'Itau', 'Bradesco', 'Caixa', 'Santander',
           'Inter', 'C6 Bank', 'PicPay', 'PIX'],
  mexico: ['BBVA', 'Banorte', 'Santander', 'Banamex', 'HSBC', 'Scotiabank', 'Azteca',
           'Nu', 'Spin', 'Mercado Pago', 'STP'],
  venezuela: ['Banesco', 'Mercantil', 'Provincial', 'Venezuela', 'BNC', 'Bancamiga',
              'Pago Movil', 'Zelle'],
  ecuador: ['Pichincha', 'Guayaquil', 'Produbanco', 'Pacifico', 'Bolivariano', 'JEP'],
  usdt: ['Binance', 'Bybit', 'OKX', 'Wallet propia'],
};

module.exports = { ddl, SEED_COUNTRIES, SEED_BANKS };
