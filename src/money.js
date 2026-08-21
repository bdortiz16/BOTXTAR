'use strict';

/**
 * Aritmetica de dinero exacta.
 *
 * Todo importe se maneja internamente como BigInt escalado a 8 decimales.
 * Nunca usamos Number para operar: 10000 * 1000 en punto flotante es exacto,
 * pero 0.1 + 0.2 no lo es, y las tasas suelen traer decimales.
 */

const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);

/** Redondeo half-up sobre un entero escalado, hacia `decimals` decimales. */
function roundScaled(scaled, decimals) {
  if (decimals >= SCALE) return scaled;
  const step = 10n ** BigInt(SCALE - decimals);
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const rem = abs % step;
  let out = abs - rem;
  if (rem * 2n >= step) out += step;
  return neg ? -out : out;
}

/**
 * Convierte texto escrito por una persona a BigInt escalado.
 *
 * Acepta las formas que se usan en LATAM y las que salen de un teclado
 * numerico: "10000", "10.000.000", "10,000.50", "1.234,56", "3500.75".
 *
 * Reglas de desambiguacion:
 *  - Si aparecen "." y "," juntos, el ultimo es el separador decimal.
 *  - Si un separador aparece varias veces, es separador de miles.
 *  - Si aparece una sola vez y deja exactamente 3 digitos a la derecha, se
 *    interpreta como separador de miles (convencion local: "1.000" = mil).
 *  - En cualquier otro caso es separador decimal.
 */
function parseAmount(input) {
  if (typeof input === 'bigint') return input;
  if (input === null || input === undefined) return null;

  let s = String(input).trim();
  if (s === '') return null;

  // Quita simbolos de moneda, espacios (incl. NBSP) y apostrofes de miles.
  s = s.replace(/[\s  '’]/g, '').replace(/[^\d.,\-+]/g, '');
  if (s === '') return null;

  let sign = 1n;
  if (s.startsWith('-')) { sign = -1n; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (/[+\-]/.test(s)) return null;

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;

  let decimalSep = null;
  if (dots > 0 && commas > 0) {
    decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  } else if (dots > 0 || commas > 0) {
    const sep = dots > 0 ? '.' : ',';
    const count = dots > 0 ? dots : commas;
    const tail = s.slice(s.lastIndexOf(sep) + 1);
    const head = s.slice(0, s.indexOf(sep));
    if (count === 1 && tail.length === 3 && head.length > 0) decimalSep = null; // miles
    else if (count > 1) decimalSep = null; // miles
    else decimalSep = sep;
  }

  let intPart;
  let fracPart = '';
  if (decimalSep) {
    const idx = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, idx).replace(/[.,]/g, '');
    fracPart = s.slice(idx + 1).replace(/[.,]/g, '');
  } else {
    intPart = s.replace(/[.,]/g, '');
  }

  if (intPart === '' && fracPart === '') return null;
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;

  fracPart = fracPart.slice(0, SCALE).padEnd(SCALE, '0');
  const value = BigInt(intPart || '0') * FACTOR + BigInt(fracPart);
  return sign * value;
}

/** Igual que parseAmount pero lanza un error legible en vez de devolver null. */
function requireAmount(input, field) {
  const v = parseAmount(input);
  if (v === null) throw new ValidationError(`"${field}" no es un numero valido: ${JSON.stringify(input)}`);
  return v;
}

/** BigInt escalado -> string canonico "10000000.00" (para guardar en BD). */
function toDecimalString(scaled, decimals = 2) {
  const rounded = roundScaled(scaled, decimals);
  const neg = rounded < 0n;
  const abs = neg ? -rounded : rounded;
  const intPart = abs / FACTOR;
  const fracPart = (abs % FACTOR).toString().padStart(SCALE, '0').slice(0, decimals);
  const body = decimals > 0 ? `${intPart}.${fracPart}` : `${intPart}`;
  return neg ? `-${body}` : body;
}

/** Multiplicacion exacta de dos escalados. */
function multiply(a, b) {
  return (a * b) / FACTOR;
}

/** Division exacta de dos escalados (half-up al 8vo decimal). */
function divide(a, b) {
  if (b === 0n) throw new ValidationError('Division por cero: la tasa no puede ser 0');
  const neg = (a < 0n) !== (b < 0n);
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const num = absA * FACTOR;
  const q = num / absB;
  const rem = num % absB;
  const out = rem * 2n >= absB ? q + 1n : q;
  return neg ? -out : out;
}

function sum(list) {
  return list.reduce((acc, v) => acc + v, 0n);
}

function isZero(scaled) { return scaled === 0n; }
function isPositive(scaled) { return scaled > 0n; }

/** Formatea para mostrar/enviar a Telegram: "10.000.000" / "3.500,75". */
function formatAmount(scaled, decimals = 2, { groupSep = '.', decimalSep = ',' } = {}) {
  const canonical = toDecimalString(scaled, decimals);
  const neg = canonical.startsWith('-');
  const body = neg ? canonical.slice(1) : canonical;
  const [int, frac] = body.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const out = frac ? `${grouped}${decimalSep}${frac}` : grouped;
  return neg ? `-${out}` : out;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

module.exports = {
  SCALE,
  FACTOR,
  parseAmount,
  requireAmount,
  toDecimalString,
  formatAmount,
  roundScaled,
  multiply,
  divide,
  sum,
  isZero,
  isPositive,
  ValidationError,
};
