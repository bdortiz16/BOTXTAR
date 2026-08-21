'use strict';

const test = require('node:test');
const assert = require('node:assert');
const money = require('../src/money');

test('interpreta el punto como separador de miles (uso local)', () => {
  assert.strictEqual(money.toDecimalString(money.parseAmount('10.000'), 0), '10000');
  assert.strictEqual(money.toDecimalString(money.parseAmount('10.000.000'), 0), '10000000');
  assert.strictEqual(money.toDecimalString(money.parseAmount('1.000'), 0), '1000');
});

test('interpreta la coma como decimal cuando no hay ambiguedad', () => {
  assert.strictEqual(money.toDecimalString(money.parseAmount('3500,75'), 2), '3500.75');
  assert.strictEqual(money.toDecimalString(money.parseAmount('0,15'), 2), '0.15');
});

test('con los dos separadores, el ultimo manda', () => {
  assert.strictEqual(money.toDecimalString(money.parseAmount('1,234.56'), 2), '1234.56');
  assert.strictEqual(money.toDecimalString(money.parseAmount('1.234,56'), 2), '1234.56');
});

test('acepta numeros escritos sin separadores', () => {
  assert.strictEqual(money.toDecimalString(money.parseAmount('10000'), 0), '10000');
  assert.strictEqual(money.toDecimalString(money.parseAmount('3500.75'), 2), '3500.75');
});

test('rechaza entradas que no son numeros', () => {
  for (const v of ['', '   ', 'abc', null, undefined, '1-2']) {
    assert.strictEqual(money.parseAmount(v), null, `deberia rechazar ${JSON.stringify(v)}`);
  }
});

test('la multiplicacion no pierde centavos', () => {
  const a = money.parseAmount('0.1');
  const b = money.parseAmount('0.2');
  assert.strictEqual(money.toDecimalString(a + b, 2), '0.30');
  const monto = money.parseAmount('1234.56');
  const tasa = money.parseAmount('987.65');
  assert.strictEqual(money.toDecimalString(money.multiply(monto, tasa), 4), '1219313.1840');
});

test('la division redondea half-up', () => {
  assert.strictEqual(money.toDecimalString(money.divide(money.parseAmount('10'), money.parseAmount('3')), 4), '3.3333');
  assert.strictEqual(money.toDecimalString(money.divide(money.parseAmount('1'), money.parseAmount('8')), 3), '0.125');
});

test('formatea con separadores locales', () => {
  assert.strictEqual(money.formatAmount(money.parseAmount('10000000'), 0), '10.000.000');
  assert.strictEqual(money.formatAmount(money.parseAmount('3500.75'), 2), '3.500,75');
});

test('requireAmount explica el campo que fallo', () => {
  assert.throws(() => money.requireAmount('xx', 'TASA'), /TASA/);
});
