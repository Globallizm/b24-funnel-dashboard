// Сессии встроенного приложения.
//
// Битрикс24 открывает место встраивания POST-запросом и передаёт в теле
// параметр AUTH_ID — токен сессии текущего сотрудника. Токен сразу убирается
// из адресной строки в httpOnly-cookie: так он не попадает в историю браузера,
// в реферер и в логи прокси, и недоступен скриптам страницы.
//
// Хранилище — в памяти процесса. Токены живут 24 часа без продления
// (ограничение платформы), на диск ничего не пишется.

import { randomUUID, randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'b24_dashboard_sid';

const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expires <= now) sessions.delete(id);
  }
}

/** Создать сессию по данным из места встраивания. */
export function createSession({ token, memberId, placement, userId }) {
  sweep();
  const id = randomUUID() + randomBytes(8).toString('hex');
  sessions.set(id, {
    token,
    memberId,
    placement,
    userId,
    expires: Date.now() + TOKEN_TTL_MS,
  });
  return id;
}

/** Получить живую сессию по идентификатору из cookie. */
export function getSession(id) {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expires <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function cookieHeader(sessionId) {
  // SameSite=None обязателен: страница открывается во фрейме портала.
  return [
    `${COOKIE_NAME}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
  ].join('; ');
}

export function sessionIdFromCookies(cookieString) {
  if (!cookieString) return null;
  for (const part of String(cookieString).split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

export { COOKIE_NAME };
