// Сбор данных дашборда: справочники, сводка по стадиям, показатели, последние сделки.

import { createHash } from 'node:crypto';

import { config } from './config.js';
import { list, aggregate, ApiError } from './vibecode.js';

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

/**
 * Сводка по стадиям: количество сделок и сумма по каждой stageId.
 *
 * Один запрос POST /v1/deals/aggregate с группировкой по stageId:
 *   количество — groups[].count,
 *   сумма      — groups[].aggregates.amount.sum.
 * Записи сделок при этом не выгружаются.
 *
 * Полнота ответа:
 * - data.meta.truncated === true — числовые агрегаты посчитаны по части записей
 *   (платформа читает не больше 5000). Проверяется ЗНАЧЕНИЕ поля: оно приходит
 *   всегда и в полном ответе равно false. Дополнительно смотрим метки truncated
 *   на группах и на самом агрегате.
 * - 422 AGGREGATION_LIMIT_EXCEEDED — сделок под фильтр больше 5000 и группировку
 *   платформа не строит вовсе. Тогда берём точное общее количество запросом
 *   count без groupBy (он не читает записи и работает на любом объёме),
 *   а разбивку по стадиям и суммы помечаем недоступными.
 */
async function stageSummary(filter, stages, sessionToken) {
  let data;
  try {
    data = await aggregate(
      'deals',
      {
        filter,
        groupBy: ['stageId'],
        aggregate: [
          { field: '*', function: 'count' },
          { field: 'amount', function: 'sum' },
        ],
      },
      sessionToken
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AGGREGATION_LIMIT_EXCEEDED') {
      const total = await countOnly(filter, sessionToken);
      return {
        limitExceeded: true,
        truncated: false,
        total,
        stages: stages.map((stage) => ({ ...stage, count: null, sum: null })),
      };
    }
    throw error;
  }

  const groups = Array.isArray(data.groups) ? data.groups : [];
  const byStage = new Map();
  let groupTruncated = false;

  for (const group of groups) {
    const stageId = String(pick(group, 'stageId', 'STAGE_ID') ?? '');
    const amount = group.aggregates?.amount;
    if (group.truncated === true || amount?.truncated === true) groupTruncated = true;
    byStage.set(stageId, {
      count: num(group.count),
      sum: num(amount?.sum),
    });
  }

  return {
    limitExceeded: false,
    truncated: data.meta?.truncated === true || groupTruncated,
    total: num(data.count),
    // Стадии без сделок в groups не приходят — достраиваем нулями
    // из полного списка стадий, чтобы воронка читалась целиком.
    stages: stages.map((stage) => ({
      ...stage,
      count: byStage.get(stage.id)?.count ?? 0,
      sum: byStage.get(stage.id)?.sum ?? 0,
    })),
  };
}

/** Точное количество сделок под фильтр: count без groupBy не читает записи. */
async function countOnly(filter, sessionToken) {
  const data = await aggregate(
    'deals',
    { filter, aggregate: [{ field: '*', function: 'count' }] },
    sessionToken
  );
  return num(data.count);
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
    const userNames = new Map(meta.users.map((u) => [u.id, u.name]));
    const stageNames = new Map(meta.stages.map((s) => [s.id, s]));

    // Показатели выводятся из тех же групп агрегации, что и диаграмма.
    // При превышении лимита агрегации разбивки нет — показатели не считаем.
    let kpi = { openAmount: null, wonCount: null, avgWonAmount: null };
    if (!summaryResult.limitExceeded) {
      const inProgress = summary.filter((s) => s.kind === 'progress');
      const won = summary.filter((s) => s.kind === 'success');
      const wonCount = won.reduce((total, s) => total + s.count, 0);
      const wonSum = won.reduce((total, s) => total + s.sum, 0);
      kpi = {
        openAmount: inProgress.reduce((total, s) => total + s.sum, 0),
        wonCount,
        avgWonAmount: wonCount > 0 ? Math.round(wonSum / wonCount) : 0,
      };
    }

    return {
      updatedAt: new Date().toISOString(),
      currency: config.currency,
      truncated: summaryResult.truncated,
      limitExceeded: summaryResult.limitExceeded,
      total: summaryResult.total,
      kpi,
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
