// Регистрация мест встраивания в портале Битрикс24.
// Используется скриптом scripts/bind-placements.js, в рантайме не вызывается.

import { apiFetch } from './vibecode.js';

/** Доступные на портале коды мест встраивания. */
export async function availablePlacements(sessionToken) {
  const result = await apiFetch('/v1/placements/available', { sessionToken });
  const data = result.data;
  return Array.isArray(data) ? data : (data?.items ?? []);
}

/** Уже привязанные места. */
export async function boundPlacements(sessionToken) {
  const result = await apiFetch('/v1/placements', { sessionToken });
  const data = result.data;
  return Array.isArray(data) ? data : (data?.items ?? []);
}

/**
 * Привязать место встраивания.
 * @param {object} params { placement, handler, title, description, sessionToken }
 */
export async function bindPlacement({ placement, handler, title, description, sessionToken }) {
  return apiFetch('/v1/placements/bind', {
    method: 'POST',
    body: { placement, handler, title, description },
    sessionToken,
  });
}

export async function unbindPlacement({ placement, handler, sessionToken }) {
  return apiFetch('/v1/placements/unbind', {
    method: 'POST',
    body: { placement, handler },
    sessionToken,
  });
}
