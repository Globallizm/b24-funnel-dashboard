// Сбор данных дашборда: справочники, сводка по стадиям, показатели, последние сделки.

import { createHash } from 'node:crypto';

import { config } from './config.js';
import { list } from './vibecode.js';

const cache = new Map();

/**
 * Кэш разделяется по пользователям: права на сделки у сотрудников разные,
 * и выборка одного не должна попасть другому. В ключ идёт только хэш токена.
 */
function scope(sessionToken) {
  if (!sessionToken) return 'anon';
  return createHash('sha256').update(sessionToken).digest('hex').slice(0, 16);
}

function cached(key, ttl, producer) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = Promise.resolve()
    .then(producer)
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const pick = (object, ...keys) => {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }
  return undefined;
};

/** Семантика стадии: success | failure | progress. */
function stageKind(stage) {
  const semantics = String(pick(stage, 'semantics', 'semantic', 'SEMANTICS') || '').toUpperCase();
  if (semantics === 'S' || semantics === 'SUCCESS') return 'success';
  if (semantics === 'F' || semantics === 'FAILURE' || semantics === 'FAIL') return 'failure';
  const id = String(pick(stage, 'statusId', 'stageId', 'id') || '');
  const tail = id.includes(':') ? id.split(':').pop() : id;
  if (tail === 'WON') return 'success';
  if (tail === 'LOSE' || tail === 'LOST' || tail === 'APOLOGY') return 'failure';
  return 'progress';
}

/**
 * Справочник стадий одной воронки.
 *
 * Идентификаторы стадий в дополнительных воронках имеют префикс ("C20:WON"),
 * и число в префиксе не обязано совпадать с идентификатором воронки. Поэтому
 * принадлежность стадии не вычисляется из её кода, а запрашивается у портала:
 * общая воронка — entityId "DEAL_STAGE", остальные — "DEAL_STAGE_<id воронки>".
 */
async function stagesOfFunnel(funnelId, sessionToken) {
  const entityId = funnelId === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${funnelId}`;
  const statuses = await list('statuses', {
    filter: { entityId },
    limit: 500,
    sessionToken,
  }).catch(() => []);

  return statuses
    .map((s) => ({
      id: String(pick(s, 'statusId', 'stageId', 'id')),
      name: pick(s, 'name', 'NAME') || String(pick(s, 'statusId', 'id')),
      sort: num(pick(s, 'sort', 'SORT')),
      categoryId: funnelId,
      kind: stageKind(s),
    }))
    .sort((a, b) => a.sort - b.sort);
}

/** Справочники: воронки, стадии, сотрудники. Кэшируются на несколько минут. */
export function loadMeta(sessionToken) {
  return cached(`meta:${scope(sessionToken)}`, config.metaCacheTtl, async () => {
    const [categories, users] = await Promise.all([
      list('deal-categories', { limit: 200, sessionToken }).catch(() => []),
      list('users', {
        filter: { active: true },
        select: ['id', 'name', 'lastName', 'secondName', 'title'],
        limit: 500,
        sessionToken,
      }).catch(() => []),
    ]);

    // Названия воронок берём как они заданы на портале, включая общую (id 0).
    const fromPortal = categories.map((c) => ({
      id: String(pick(c, 'id', 'ID')),
      name: pick(c, 'name', 'NAME') || 'Без названия',
    }));
    const funnels = fromPortal.some((f) => f.id === '0')
      ? fromPortal
      : [{ id: '0', name: 'Общая воронка' }].concat(fromPortal);

    const seen = new Set();
    const uniqueFunnels = funnels.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));

    // Стадии каждой воронки — отдельным запросом, параллельно.
    const perFunnel = await Promise.all(
      uniqueFunnels.map((f) => stagesOfFunnel(f.id, sessionToken))
    );
    const stages = perFunnel.flat();

    const people = users
      .map((u) => ({
        id: String(pick(u, 'id', 'ID')),
        name: [pick(u, 'lastName', 'LAST_NAME'), pick(u, 'name', 'NAME'), pick(u, 'secondName')]
          .filter(Boolean)
          .join(' ')
          .trim() || `Пользователь #${pick(u, 'id', 'ID')}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    return { funnels: uniqueFunnels, stages, users: people };
  });
}

/** Фильтр сделок из параметров запроса. */
function buildFilter({ categoryId, assignedById, dateFrom, dateTo }) {
  const filter = {};
  if (categoryId !== undefined && categoryId !== '') filter.categoryId = Number(categoryId);
  if (assignedById) filter.assignedById = Number(assignedById);
  if (dateFrom) filter['>=createdAt'] = `${dateFrom}T00:00:00`;
  if (dateTo) filter['<=createdAt'] = `${dateTo}T23:59:59`;
  return filter;
}

const SCAN_LIMIT = 5000;

/**
 * Сводка по стадиям: количество сделок и их сумма.
 *
 * Считается по выборке сделок, а не агрегацией на стороне API: в режиме
 * группировки по стадии платформа возвращает точные количества, но числовые
 * агрегаты при этом приходят пустыми, и суммы получались нулевыми.
 */
async function stageSummary(filter, stages, sessionToken) {
  const deals = await list('deals', {
    filter,
    select: ['id', 'stageId', 'amount', 'opportunity'],
    limit: SCAN_LIMIT,
    sessionToken,
  });

  const byStage = new Map();
  for (const deal of deals) {
    const stageId = String(pick(deal, 'stageId', 'STAGE_ID') ?? '');
    const entry = byStage.get(stageId) || { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += num(pick(deal, 'amount', 'opportunity', 'OPPORTUNITY'));
    byStage.set(stageId, entry);
  }

  // Стадии без сделок в выборке не встречаются — дополняем нулями.
  return {
    // Выборка упёрлась в предел: цифры неполные, интерфейс об этом предупредит.
    truncated: deals.length >= SCAN_LIMIT,
    stages: stages.map((stage) => ({
      ...stage,
      count: byStage.get(stage.id)?.count ?? 0,
      sum: byStage.get(stage.id)?.sum ?? 0,
    })),
  };
}

/** Последние созданные сделки. */
async function recentDeals(filter, sessionToken) {
  return list('deals', {
    filter,
    select: ['id', 'title', 'amount', 'opportunity', 'currencyId', 'stageId', 'assignedById', 'createdAt'],
    order: { createdAt: 'desc' },
    limit: config.recentLimit,
    sessionToken,
  });
}

/** Полные данные дашборда под один запрос фронтенда. */
export async function loadDashboard(params, sessionToken) {
  const key = `dash:${scope(sessionToken)}:${JSON.stringify(params)}`;
  return cached(key, config.dataCacheTtl, async () => {
    const meta = await loadMeta(sessionToken);
    const filter = buildFilter(params);

    // Стадии сравниваем только внутри одной воронки: префиксы у них разные.
    const categoryId = params.categoryId === undefined || params.categoryId === ''
      ? null
      : String(params.categoryId);
    const stages = categoryId === null
      ? meta.stages
      : meta.stages.filter((s) => s.categoryId === categoryId);

    const [summaryResult, deals] = await Promise.all([
      stageSummary(filter, stages, sessionToken),
      recentDeals(filter, sessionToken),
    ]);

    const summary = summaryResult.stages;
    const inProgress = summary.filter((s) => s.kind === 'progress');
    const won = summary.filter((s) => s.kind === 'success');

    const wonCount = won.reduce((total, s) => total + s.count, 0);
    const wonSum = won.reduce((total, s) => total + s.sum, 0);

    const userNames = new Map(meta.users.map((u) => [u.id, u.name]));
    const stageNames = new Map(meta.stages.map((s) => [s.id, s]));

    return {
      updatedAt: new Date().toISOString(),
      currency: config.currency,
      truncated: summaryResult.truncated,
      kpi: {
        openAmount: inProgress.reduce((total, s) => total + s.sum, 0),
        wonCount,
        avgWonAmount: wonCount > 0 ? Math.round(wonSum / wonCount) : 0,
      },
      stages: summary.map((s) => ({ id: s.id, name: s.name, kind: s.kind, count: s.count, sum: s.sum })),
      deals: deals.map((deal) => {
        const stageId = String(pick(deal, 'stageId', 'STAGE_ID') ?? '');
        const assignedId = String(pick(deal, 'assignedById', 'ASSIGNED_BY_ID') ?? '');
        return {
          id: pick(deal, 'id', 'ID'),
          title: pick(deal, 'title', 'TITLE') || 'Без названия',
          amount: num(pick(deal, 'amount', 'opportunity', 'OPPORTUNITY')),
          stage: stageNames.get(stageId)?.name || stageId,
          stageKind: stageNames.get(stageId)?.kind || 'progress',
          responsible: userNames.get(assignedId) || '—',
        };
      }),
    };
  });
}
