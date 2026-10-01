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

/** Стадии дополнительных воронок имеют префикс вида "C1:". */
function stageCategoryId(stage) {
  const explicit = pick(stage, 'categoryId', 'entityCategoryId');
  if (explicit !== undefined) return String(explicit);
  const id = String(pick(stage, 'statusId', 'stageId', 'id') || '');
  const match = /^C(\d+):/.exec(id);
  return match ? match[1] : '0';
}

/** Справочники: воронки, стадии, сотрудники. Кэшируются на несколько минут. */
export function loadMeta(sessionToken) {
  return cached(`meta:${scope(sessionToken)}`, config.metaCacheTtl, async () => {
    const [categories, statuses, users] = await Promise.all([
      list('deal-categories', { limit: 200, sessionToken }).catch(() => []),
      list('statuses', { filter: { entityId: 'DEAL_STAGE' }, limit: 500, sessionToken }),
      list('users', {
        filter: { active: true },
        select: ['id', 'name', 'lastName', 'secondName', 'title'],
        limit: 500,
        sessionToken,
      }).catch(() => []),
    ]);

    const funnels = [{ id: '0', name: 'Общая воронка' }].concat(
      categories
        .map((c) => ({ id: String(pick(c, 'id', 'ID')), name: pick(c, 'name', 'NAME') || 'Без названия' }))
        .filter((c) => c.id !== '0')
    );
    // Если у портала воронка ровно одна, дубликат "Общая" убираем.
    const seen = new Set();
    const uniqueFunnels = funnels.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));

    const stages = statuses
      .map((s) => ({
        id: String(pick(s, 'statusId', 'stageId', 'id')),
        name: pick(s, 'name', 'NAME') || String(pick(s, 'statusId', 'id')),
        sort: num(pick(s, 'sort', 'SORT')),
        categoryId: stageCategoryId(s),
        kind: stageKind(s),
      }))
      .sort((a, b) => a.sort - b.sort);

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

/** Сводка по стадиям: количество и сумма. Основной путь — агрегация на стороне API. */
async function stageSummary(filter, stages, sessionToken) {
  try {
    const groups = await aggregate(
      'deals',
      {
        filter,
        groupBy: ['stageId'],
        aggregations: [
          { function: 'count', alias: 'count' },
          { function: 'sum', field: 'amount', alias: 'sum' },
        ],
      },
      sessionToken
    );

    const byStage = new Map();
    for (const group of groups) {
      const stageId = String(pick(group, 'stageId', 'STAGE_ID', 'group', 'key') ?? '');
      byStage.set(stageId, {
        count: num(pick(group, 'count', 'COUNT', 'cnt')),
        sum: num(pick(group, 'sum', 'SUM', 'amountSum', 'sumAmount')),
      });
    }
    // Стадии без сделок в ответе не приходят — дополняем нулями.
    return stages.map((stage) => ({
      ...stage,
      count: byStage.get(stage.id)?.count ?? 0,
      sum: byStage.get(stage.id)?.sum ?? 0,
    }));
  } catch (error) {
    if (error instanceof ApiError && error.status >= 500) throw error;
    // Запасной путь: считаем на своей стороне.
    return stageSummaryFallback(filter, stages, sessionToken);
  }
}

async function stageSummaryFallback(filter, stages, sessionToken) {
  const deals = await list('deals', {
    filter,
    select: ['id', 'stageId', 'amount', 'opportunity'],
    limit: 5000,
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
  return stages.map((stage) => ({
    ...stage,
    count: byStage.get(stage.id)?.count ?? 0,
    sum: byStage.get(stage.id)?.sum ?? 0,
  }));
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

    const [summary, deals] = await Promise.all([
      stageSummary(filter, stages, sessionToken),
      recentDeals(filter, sessionToken),
    ]);

    const inProgress = summary.filter((s) => s.kind === 'progress');
    const won = summary.filter((s) => s.kind === 'success');

    const wonCount = won.reduce((total, s) => total + s.count, 0);
    const wonSum = won.reduce((total, s) => total + s.sum, 0);

    const userNames = new Map(meta.users.map((u) => [u.id, u.name]));
    const stageNames = new Map(meta.stages.map((s) => [s.id, s]));

    return {
      updatedAt: new Date().toISOString(),
      currency: config.currency,
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
