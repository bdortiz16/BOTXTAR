'use strict';

const { db } = require('./db');
const telegram = require('./telegram');

/**
 * Vinculacion de grupos de Telegram.
 *
 * La API de bots NO permite crear grupos: eso solo lo puede hacer una cuenta
 * de persona. Lo que si se puede automatizar es todo lo demas. Cuando alguien
 * agrega el bot a un grupo, Telegram avisa con una actualizacion
 * `my_chat_member`; aqui se registra ese grupo y, si el nombre menciona un
 * pais que no tenga grupo todavia, se vincula solo.
 *
 * Asi el trabajo manual se reduce a crear el grupo y agregar el bot.
 */

function normaliza(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Busca en el nombre del grupo un pais del catalogo. */
async function countryFromTitle(title) {
  const t = normaliza(title);
  if (!t) return null;
  const paises = await db.all('SELECT id, name FROM countries WHERE active = 1');

  // Se prueba primero el nombre mas largo, para que "Colombia" no le gane a
  // un pais cuyo nombre lo contenga.
  const candidatos = paises
    .map((p) => ({ ...p, clave: normaliza(p.name) }))
    .sort((a, b) => b.clave.length - a.clave.length);

  for (const p of candidatos) {
    const re = new RegExp(`(^|[^a-z0-9])${p.clave}([^a-z0-9]|$)`);
    if (re.test(t)) return p;
  }
  // El identificador tambien sirve: un grupo llamado "peru-pagos".
  for (const p of candidatos) {
    const re = new RegExp(`(^|[^a-z0-9])${normaliza(p.id)}([^a-z0-9]|$)`);
    if (re.test(t)) return p;
  }
  return null;
}

async function rememberChat({ id, title, type }, { status = 'MEMBER' } = {}) {
  const ahora = new Date().toISOString();
  const existente = await db.get('SELECT chat_id FROM telegram_chats WHERE chat_id = ?', [String(id)]);
  if (existente) {
    await db.run(
      'UPDATE telegram_chats SET title = ?, type = ?, status = ?, updated_at = ? WHERE chat_id = ?',
      [String(title || ''), String(type || ''), status, ahora, String(id)]
    );
  } else {
    await db.run(
      `INSERT INTO telegram_chats (chat_id, title, type, status, detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(id), String(title || ''), String(type || ''), status, ahora, ahora]
    );
  }
}

/**
 * Asigna un grupo a un pais, manteniendo la relacion uno a uno en las dos
 * direcciones.
 *
 * Las dos limpiezas son necesarias: sin la primera, el pais que antes usaba
 * este grupo seguiria apuntando a el y sus envios acabarian en el grupo de
 * otro pais. Sin la segunda, un pais quedaria con dos grupos registrados.
 */
async function linkChat(chatId, countryId) {
  const ahora = new Date().toISOString();
  const id = String(chatId);

  // Un grupo no puede servir a dos paises.
  await db.run(
    "UPDATE countries SET telegram_chat_id = '' WHERE telegram_chat_id = ? AND id <> ?",
    [id, countryId]
  );
  // Un pais no puede tener dos grupos.
  await db.run(
    'UPDATE telegram_chats SET country_id = NULL, updated_at = ? WHERE country_id = ? AND chat_id <> ?',
    [ahora, countryId, id]
  );

  await db.run('UPDATE telegram_chats SET country_id = ?, updated_at = ? WHERE chat_id = ?',
    [countryId, ahora, id]);
  await db.run('UPDATE countries SET telegram_chat_id = ? WHERE id = ?', [id, countryId]);
}

async function unlinkChat(chatId) {
  const fila = await db.get('SELECT country_id FROM telegram_chats WHERE chat_id = ?', [String(chatId)]);
  if (fila?.country_id) {
    await db.run("UPDATE countries SET telegram_chat_id = '' WHERE id = ? AND telegram_chat_id = ?",
      [fila.country_id, String(chatId)]);
  }
  await db.run('UPDATE telegram_chats SET country_id = NULL, updated_at = ? WHERE chat_id = ?',
    [new Date().toISOString(), String(chatId)]);
}

async function listChats() {
  return db.all(`
    SELECT c.*, p.name AS country_name, p.emoji AS country_emoji
    FROM telegram_chats c
    LEFT JOIN countries p ON p.id = c.country_id
    ORDER BY c.detected_at DESC
  `);
}

/**
 * Procesa una actualizacion de Telegram.
 *
 * Devuelve un resumen de lo que hizo, que se usa en las pruebas y en el
 * registro. Nunca lanza: una actualizacion rara no puede tumbar el webhook,
 * porque Telegram reintentaria en bucle.
 */
async function handleUpdate(update) {
  try {
    if (update?.my_chat_member) return await onMembership(update.my_chat_member);
    if (update?.message?.text) return await onCommand(update.message);
    return { action: 'IGNORADA' };
  } catch (err) {
    console.error('[telegram] error procesando actualizacion:', err.message);
    return { action: 'ERROR', reason: err.message };
  }
}

const GRUPOS = ['group', 'supergroup'];

async function onMembership(evento) {
  const chat = evento.chat || {};
  if (!GRUPOS.includes(chat.type)) return { action: 'IGNORADA', reason: 'no es un grupo' };

  const estado = evento.new_chat_member?.status;
  if (['left', 'kicked'].includes(estado)) {
    await rememberChat(chat, { status: 'LEFT' });
    await unlinkChat(chat.id);
    return { action: 'SALIO', chat_id: String(chat.id) };
  }

  await rememberChat(chat, { status: estado === 'administrator' ? 'ADMIN' : 'MEMBER' });

  // Si ya estaba vinculado, no se toca nada.
  const fila = await db.get('SELECT country_id FROM telegram_chats WHERE chat_id = ?', [String(chat.id)]);
  if (fila?.country_id) {
    return { action: 'YA_VINCULADO', chat_id: String(chat.id), country_id: fila.country_id };
  }

  const pais = await countryFromTitle(chat.title);
  if (pais) {
    const ocupado = await db.get(
      "SELECT id FROM countries WHERE id = ? AND telegram_chat_id <> ''", [pais.id]);
    if (!ocupado) {
      await linkChat(chat.id, pais.id);
      await telegram.notifyChat(chat.id,
        `✅ <b>BOTXTAR conectado</b>\nEste grupo recibira los envios de <b>${telegram.esc(pais.name)}</b>.`);
      return { action: 'VINCULADO', chat_id: String(chat.id), country_id: pais.id, auto: true };
    }
  }

  await telegram.notifyChat(chat.id,
    '👋 <b>BOTXTAR conectado</b>\nFalta decir de que pais es este grupo. '
    + 'Escribe aqui <code>/vincular pais</code> (por ejemplo <code>/vincular brasil</code>), '
    + 'o eligelo desde Ajustes en la app.');
  return { action: 'DETECTADO', chat_id: String(chat.id) };
}

async function onCommand(mensaje) {
  const chat = mensaje.chat || {};
  const texto = String(mensaje.text || '').trim();
  const m = /^\/(vincular|start|estado)(?:@\w+)?(?:\s+(.+))?$/i.exec(texto);
  if (!m) return { action: 'IGNORADA' };

  const comando = m[1].toLowerCase();
  const argumento = (m[2] || '').trim();

  if (!GRUPOS.includes(chat.type)) {
    await telegram.notifyChat(chat.id,
      'Este bot funciona dentro de un grupo. Crea el grupo del pais, agregame y escribe /vincular.');
    return { action: 'IGNORADA', reason: 'no es un grupo' };
  }

  await rememberChat(chat);

  if (comando === 'estado' || (comando === 'start' && !argumento)) {
    const fila = await db.get(`
      SELECT c.country_id, p.name FROM telegram_chats c
      LEFT JOIN countries p ON p.id = c.country_id WHERE c.chat_id = ?`, [String(chat.id)]);
    await telegram.notifyChat(chat.id, fila?.country_id
      ? `Este grupo recibe los envios de <b>${telegram.esc(fila.name)}</b>.`
      : 'Este grupo todavia no esta vinculado a ningun pais. Escribe <code>/vincular pais</code>.');
    return { action: 'ESTADO', chat_id: String(chat.id) };
  }

  const pais = argumento
    ? await countryFromTitle(argumento)
    : await countryFromTitle(chat.title);

  if (!pais) {
    const paises = await db.all('SELECT name FROM countries WHERE active = 1 ORDER BY sort_order');
    await telegram.notifyChat(chat.id,
      'No reconoci ese pais. Prueba con uno de estos:\n'
      + paises.map((p) => `<code>/vincular ${telegram.esc(p.name.toLowerCase())}</code>`).join('\n'));
    return { action: 'PAIS_DESCONOCIDO', chat_id: String(chat.id) };
  }

  await linkChat(chat.id, pais.id);
  await telegram.notifyChat(chat.id,
    `✅ Listo. Este grupo recibira los envios de <b>${telegram.esc(pais.name)}</b>.`);
  return { action: 'VINCULADO', chat_id: String(chat.id), country_id: pais.id, auto: false };
}

module.exports = {
  handleUpdate, countryFromTitle, rememberChat, linkChat, unlinkChat, listChats,
};
