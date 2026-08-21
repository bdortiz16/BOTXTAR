'use strict';

/**
 * Decimales reales de uso para cada moneda. COP y CLP se operan sin centavos,
 * por eso 10.000.000 COP se muestra sin decimales.
 */
const CURRENCIES = {
  COP: { name: 'Peso colombiano', decimals: 0, symbol: '$' },
  PEN: { name: 'Sol peruano', decimals: 2, symbol: 'S/' },
  CLP: { name: 'Peso chileno', decimals: 0, symbol: '$' },
  BRL: { name: 'Real brasileno', decimals: 2, symbol: 'R$' },
  MXN: { name: 'Peso mexicano', decimals: 2, symbol: '$' },
  USD: { name: 'Dolar', decimals: 2, symbol: 'US$' },
  USDT: { name: 'Tether', decimals: 2, symbol: 'USDT' },
  VES: { name: 'Bolivar', decimals: 2, symbol: 'Bs' },
  ARS: { name: 'Peso argentino', decimals: 2, symbol: '$' },
  BOB: { name: 'Boliviano', decimals: 2, symbol: 'Bs' },
  PYG: { name: 'Guarani', decimals: 0, symbol: 'G$' },
  UYU: { name: 'Peso uruguayo', decimals: 2, symbol: '$' },
  EUR: { name: 'Euro', decimals: 2, symbol: '€' },
  PAB: { name: 'Balboa', decimals: 2, symbol: 'B/.' },
  CRC: { name: 'Colon', decimals: 2, symbol: '₡' },
  DOP: { name: 'Peso dominicano', decimals: 2, symbol: 'RD$' },
  GTQ: { name: 'Quetzal', decimals: 2, symbol: 'Q' },
};

/** Decimales de una moneda; 2 por defecto para monedas agregadas a mano. */
function decimalsFor(code) {
  const c = CURRENCIES[String(code || '').toUpperCase()];
  return c ? c.decimals : 2;
}

function isKnown(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, String(code || '').toUpperCase());
}

function list() {
  return Object.entries(CURRENCIES).map(([code, c]) => ({ code, ...c }));
}

module.exports = { CURRENCIES, decimalsFor, isKnown, list };
