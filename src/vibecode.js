// Тонкий клиент API Вайбкода.
// Ключ подставляется здесь, на сервере. Браузер к API напрямую не обращается.

import { config, isAppKey } from './config.js';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Запрос к API Вайбкода с повторами при 429/5xx и уважением заголовка Retry-After.
 *
 * @param {string} path      путь вида '/v1/deals'
 * @param {object} options   { method, query, body, sessionToken }
 */
export async function apiFetch(path, options = {}) {
  const { method = 'GET', query, body, sessionToken } = options;

  const url = new URL(config.apiBase + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    'Accept': 'application/json',
    'X-Api-Key': config.apiKey,
  };
  if (body) headers['Content-Type'] = 'application/json';
  // Для ключей vibe_app_… запросы идут от имени пользователя — нужен токен сессии.
  if (isAppKey && sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

  const maxAttempts = 4;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = new ApiError(`Сеть недоступна: ${error.message}`, 503, 'NETWORK');
      if (attempt === maxAttempts) throw lastError;
      await sleep(backoff(attempt));
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      lastError = new ApiError(
        `API вернуло ${response.status}`,
        response.status,
        response.status === 429 ? 'QUEUE_OVERFLOW' : 'UPSTREAM'
      );
      if (attempt === maxAttempts) throw lastError;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok || (payload && payload.success === false)) {
      const code = payload?.error?.code || payload?.code || 'API_ERROR';
      const message = payload?.error?.message || payload?.message || `Ошибка API (${response.status})`;
      throw new ApiError(message, response.status, code);
    }

    return payload?.data !== undefined ? payload : { success: true, data: payload, meta: {} };
  }

  throw lastError;
}

// Экспоненциальная задержка с джиттером.
function backoff(attempt) {
  const base = 400 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 250);
}

/** Список сущностей с выборкой полей. */
export async function list(entity, { filter, select, order, limit, sessionToken } = {}) {
  const query = {};
  if (filter) query.filter = JSON.stringify(filter);
  if (select) query.select = select.join(',');
  if (order) query.order = JSON.stringify(order);
  if (limit) query.limit = limit;
  const result = await apiFetch(`/v1/${entity}`, { query, sessionToken });
  return Array.isArray(result.data) ? result.data : (result.data?.items ?? []);
}

/** Агрегация: группировка и подсчёт без выгрузки записей. */
export async function aggregate(entity, body, sessionToken) {
  const result = await apiFetch(`/v1/${entity}/aggregate`, { method: 'POST', body, sessionToken });
  const data = result.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.groups)) return data.groups;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}
