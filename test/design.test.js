'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

/* ----------------------- utilidades de color ---------------------------- */

function parseColor(value) {
  const v = String(value).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return [r, g, b, 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  return null;
}

/** Compone un color con alfa sobre su fondo, que es lo que ve el ojo. */
function flatten(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
}

function relativeLuminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fgRaw, bgRaw) {
  const bg = parseColor(bgRaw);
  const fgParsed = parseColor(fgRaw);
  const fg = fgParsed[3] < 1 ? flatten(fgParsed, bg) : fgParsed;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* --------------------- lectura de los tokens del CSS -------------------- */

function tokensFrom(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** El primer `:root {}` del archivo es el tema claro. */
const lightBlock = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('@media (prefers-color-scheme: dark)'));
const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = CSS.slice(darkStart, CSS.indexOf('}\n}', darkStart));

const light = tokensFrom(lightBlock);
const dark = { ...light, ...tokensFrom(darkBlock) };

const TEMAS = [['claro', light], ['oscuro', dark]];

/* ------------------------------ contraste ------------------------------- */

/**
 * Minimos de las guias: 4.5:1 para texto de hasta 17pt, 3:1 de 18pt en
 * adelante. Todo lo que se comprueba aqui es texto pequeño, asi que se exige
 * 4.5:1 salvo donde se indique.
 */
const PARES = [
  ['--label',    '--bg',          4.5, 'texto principal sobre el fondo'],
  ['--label',    '--bg-elevated', 4.5, 'texto principal sobre una tarjeta'],
  ['--label-2',  '--bg-elevated', 4.5, 'texto secundario sobre una tarjeta'],
  ['--label-2',  '--bg',          4.5, 'texto secundario sobre el fondo'],
  ['--label',    '--fill',        4.5, 'texto dentro de un campo'],
  ['--label-2',  '--fill',        4.5, 'etiqueta dentro de un campo'],
  ['--on-accent', '--accent-fill', 4.5, 'texto del boton principal'],
  ['--accent',   '--bg-elevated', 4.5, 'icono o enlace sobre una tarjeta'],
  ['--accent',   '--accent-soft', 4.5, 'estado seleccionado'],
  ['--green',    '--bg-elevated', 4.5, 'cifra en verde'],
  ['--red',      '--bg-elevated', 4.5, 'texto de error'],
  ['--amber',    '--amber-soft',  4.5, 'aviso'],
  ['--red',      '--red-soft',    4.5, 'aviso grave'],
];

for (const [nombre, tokens] of TEMAS) {
  test(`tema ${nombre}: el texto cumple el contraste minimo`, () => {
    for (const [fg, bg, minimo, que] of PARES) {
      assert.ok(tokens[fg], `falta ${fg} en el tema ${nombre}`);
      assert.ok(tokens[bg], `falta ${bg} en el tema ${nombre}`);
      const ratio = contrast(tokens[fg], tokens[bg]);
      assert.ok(
        ratio >= minimo,
        `${que} (${fg} sobre ${bg}) da ${ratio.toFixed(2)}:1 en tema ${nombre}, `
        + `por debajo de ${minimo}:1`
      );
    }
  });
}

test('el tema oscuro redefine todo lo que hace falta', () => {
  // Un color definido solo en claro se veria mal al cambiar de tema.
  const soloClaro = Object.keys(light).filter((k) => /^--(bg|label|separator|accent|green|red|amber|fill|glass)/.test(k));
  const enOscuro = tokensFrom(tokensFrom ? darkBlock : '');
  for (const k of soloClaro) {
    assert.ok(k in enOscuro, `${k} no tiene variante oscura`);
  }
});

/* --------------------------- areas tactiles ----------------------------- */

test('el area tactil minima es de 44pt', () => {
  const m = /--tap:\s*(\d+)px/.exec(CSS);
  assert.ok(m, 'no se define --tap');
  assert.ok(Number(m[1]) >= 44, `--tap es ${m[1]}px y el minimo en movil es 44`);
});

test('ningun control se queda por debajo del area tactil', () => {
  // Los controles pequeños reducen el texto, nunca el area donde se toca.
  const controles = ['.btn', '.btn.sm', '.iconbtn', '.dest-head .del', '.opcard', 'input, select, textarea'];
  for (const sel of controles) {
    const i = CSS.indexOf(sel + ' {');
    assert.ok(i > 0, `no se encuentra la regla ${sel}`);
    const bloque = CSS.slice(i, CSS.indexOf('}', i));
    assert.ok(
      /(min-height|height|width):\s*var\(--tap\)/.test(bloque),
      `${sel} no usa var(--tap) para su area tactil`
    );
  }
});

test('ningun tamaño de texto baja del minimo legible', () => {
  const MIN_REM = 11 / 16;  // 11pt es el minimo en movil
  const escala = Object.entries(light).filter(([k]) => k.startsWith('--t-'));
  assert.ok(escala.length >= 8, 'la escala tipografica esta incompleta');
  for (const [k, v] of escala) {
    const rem = parseFloat(v);
    assert.ok(rem >= MIN_REM, `${k} vale ${v}, por debajo de los 11pt minimos`);
  }
});

test('el cuerpo de texto se queda en 17pt', () => {
  // Por debajo de 17px los navegadores moviles hacen zoom al enfocar un campo.
  assert.strictEqual(light['--t-body'], '1.0625rem');
  const i = CSS.indexOf('input, select, textarea {');
  const bloque = CSS.slice(i, CSS.indexOf('}', i));
  assert.match(bloque, /font-size:\s*var\(--t-body\)/,
    'los campos deben usar el tamaño de cuerpo o el navegador hara zoom');
});

/* ------------------------- convenciones visuales ------------------------ */

test('la interfaz no grita: nada de texto en mayusculas forzadas', () => {
  const mayusculas = [...CSS.matchAll(/text-transform:\s*uppercase/g)];
  assert.strictEqual(mayusculas.length, 0,
    'las guias piden texto en oracion, no en mayusculas');
});

test('el material translucido solo se usa en la capa funcional', () => {
  // Las barras y el aviso flotante son capa funcional; las tarjetas y los
  // campos son contenido y deben quedarse opacos.
  const conBlur = [...CSS.matchAll(/([^{}]+)\{[^}]*backdrop-filter:\s*saturate/g)]
    .map((m) => m[1].trim().split('\n').pop().trim());
  assert.ok(conBlur.length > 0, 'no se aplica el material a ninguna barra');
  const permitidos = ['.topbar', '.splitbar', '.toast'];
  for (const sel of conBlur) {
    assert.ok(
      permitidos.some((p) => sel.startsWith(p)),
      `${sel} usa material translucido y no es capa funcional`
    );
  }
});

test('hay alternativa cuando no se puede desenfocar o la persona lo desactivo', () => {
  assert.match(CSS, /@supports not \(\(backdrop-filter/,
    'falta el respaldo para navegadores sin backdrop-filter');
  assert.match(CSS, /@media \(prefers-reduced-transparency: reduce\)/,
    'falta respetar la preferencia de reducir transparencia');
});

test('se respeta la preferencia de reducir movimiento', () => {
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
});

test('el diseño respeta las areas seguras del telefono', () => {
  assert.match(CSS, /env\(safe-area-inset-top\)/, 'la barra superior ignora la muesca');
  assert.match(CSS, /env\(safe-area-inset-bottom\)/, 'el contenido ignora el indicador de inicio');
});
