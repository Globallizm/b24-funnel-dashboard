// Тесты сервера дашборда. Запуск: npm test (node --test, без зависимостей).
//
// Сервер стартует отдельным процессом — так же, как на платформе, — и ходит
// в локальный мок API Вайбкода. Поэтому проверяется и падение процесса:
// если он завершится, следующий запрос не получит ответа и тест упадёт.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const SESSION = { 'X-Vibe-Authorization': 'Bearer vibe_session_test' };

// ---------- мок API Вайбкода ----------

const mock = {
  aggregateMode: 'ok', // ok | truncated | limit
  aggregateBodies: [],
};

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
  });
}

const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const filter = url.searchParams.get('filter') ? JSON.parse(url.searchParams.get('filter')) : {};
  const ok = (data) => json(res, 200, { success: true, data, meta: {} });

  if (url.pathname === '/v1/deal-categories') {
    return ok([{ id: 0, name: 'Основные продажи' }, { id: 2, name: 'Продажа лицензий' }]);
  }
  if (url.pathname === '/v1/statuses') {
    if (filter.entityId === 'DEAL_STAGE_2') {
      // Префикс C20 намеренно не совпадает с id воронки (2) — как на реальном портале.
      return ok([
        { statusId: 'C20:NEW', name: 'Заявка', sort: 10 },
        { statusId: 'C20:INVOICE', name: 'Счёт выставлен', sort: 20 },
        { statusId: 'C20:WON', name: 'Сделка успешна', sort: 30, semantics: 'S' },
        { statusId: 'C20:LOSE', name: 'Сделка провалена', sort: 40, semantics: 'F' },
      ]);
    }
    return ok([]);
  }
  if (url.pathname === '/v1/users') {
    return ok([{ id: 1, name: 'Илья', lastName: 'Пудовкин' }]);
  }
  if (url.pathname === '/v1/deals') {
    return ok([{ id: 7, title: 'Лицензия', amount: 120000, stageId: 'C20:WON', assignedById: 1 }]);
  }
  if (url.pathname === '/v1/deals/aggregate' && req.method === 'POST') {
    const body = await readJson(req);
    mock.aggregateBodies.push(body);

    // Запрос count без groupBy — точное общее количество.
    if (!body.groupBy) return ok({ count: 12345, aggregates: {}, meta: { truncated: false } });

    if (mock.aggregateMode === 'limit') {
      return json(res, 422, {
        success: false,
        error: { code: 'AGGREGATION_LIMIT_EXCEEDED', message: 'More than 5000 records' },
      });
    }

    const truncated = mock.aggregateMode === 'truncated';
    return ok({
      count: 14,
      aggregates: { amount: { sum: 1500000 } },
      groups: [
        // C20:INVOICE намеренно отсутствует — пустые стадии не приходят в groups.
        { stageId: 'C20:NEW', count: 3, aggregates: { amount: { sum: 300000 } } },
        { stageId: 'C20:WON', count: 10, aggregates: { amount: { sum: 1100000, ...(truncated && { truncated: true }) } } },
        { stageId: 'C20:LOSE', count: 1, aggregates: { amount: { sum: 100000 } } },
      ],
      meta: { totalRecords: 14, recordsProcessed: 14, truncated },
    });
  }
  json(res, 404, { success: false, error: { code: 'ROUTE_NOT_FOUND' } });
});

// ---------- запуск приложения ----------

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let app;
let appPort;
let appExited = false;

before(async () => {
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  appPort = await freePort();

  app = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      VIBECODE_API_KEY: 'vibe_app_test',
      VIBECODE_API_BASE: `http://127.0.0.1:${mockServer.address().port}`,
      PORT: String(appPort),
      DASHBOARD_DATA_TTL_MS: '0',
      DASHBOARD_META_TTL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.on('exit', () => { appExited = true; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('сервер не запустился за 5 с')), 5000);
    app.stdout.on('data', (chunk) => {
      if (String(chunk).includes('слушает порт')) { clearTimeout(timer); resolve(); }
    });
  });
});

after(() => {
  app?.kill();
  mockServer.close();
});

/**
 * Запрос «как есть»: http.request отправляет путь без нормализации,
 * в отличие от fetch, который превратил бы "//" в "/".
 */
function raw(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: appPort, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function dashboard(query = 'categoryId=2') {
  const res = await raw(`/api/dashboard?${query}`, { headers: SESSION });
  return { status: res.status, payload: JSON.parse(res.body) };
}

// ---------- С2: процесс не падает на битом адресе ----------

test('GET // отвечает 400, процесс продолжает работать', async () => {
  const res = await raw('//');
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'BAD_REQUEST');

  const health = await raw('/healthz');
  assert.equal(health.status, 200);
  assert.equal(appExited, false, 'процесс сервера завершился');
});

test('серия битых адресов не роняет процесс', async () => {
  for (const path of ['//', '///', '//:', '//[', '//%']) {
    const res = await raw(path);
    assert.ok([200, 400].includes(res.status), `${path} → ${res.status}`);
  }
  assert.equal((await raw('/healthz')).status, 200);
  assert.equal(appExited, false, 'процесс сервера завершился');
});

test('без сессии пользователя данные не отдаются', async () => {
  const res = await raw('/api/dashboard');
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'NO_USER_SESSION');
});

// ---------- С1: сводка и показатели из POST /v1/deals/aggregate ----------

test('сводка строится одним запросом агрегации с группировкой по stageId', async () => {
  mock.aggregateMode = 'ok';
  mock.aggregateBodies = [];
  const { status } = await dashboard();
  assert.equal(status, 200);

  assert.equal(mock.aggregateBodies.length, 1);
  const body = mock.aggregateBodies[0];
  assert.deepEqual(body.groupBy, ['stageId']);
  assert.deepEqual(body.aggregate, [
    { field: '*', function: 'count' },
    { field: 'amount', function: 'sum' },
  ]);
  assert.equal(body.filter.categoryId, 2);
});

test('суммы берутся из groups[].aggregates.amount.sum, пустые стадии — нули', async () => {
  mock.aggregateMode = 'ok';
  const { payload } = await dashboard();
  const stages = Object.fromEntries(payload.data.stages.map((s) => [s.id, s]));

  assert.deepEqual([stages['C20:NEW'].count, stages['C20:NEW'].sum], [3, 300000]);
  assert.deepEqual([stages['C20:WON'].count, stages['C20:WON'].sum], [10, 1100000]);
  assert.deepEqual([stages['C20:INVOICE'].count, stages['C20:INVOICE'].sum], [0, 0]);
  assert.equal(payload.data.truncated, false);
  assert.equal(payload.data.limitExceeded, false);
});

test('показатели выводятся из групп агрегации', async () => {
  mock.aggregateMode = 'ok';
  const { payload } = await dashboard();
  // В работе — NEW (300 000) и INVOICE (0); WON и LOSE финальные.
  assert.equal(payload.data.kpi.openAmount, 300000);
  assert.equal(payload.data.kpi.wonCount, 10);
  assert.equal(payload.data.kpi.avgWonAmount, 110000);
});

test('data.meta.truncated = true помечает ответ как неполный', async () => {
  mock.aggregateMode = 'truncated';
  const { status, payload } = await dashboard();
  assert.equal(status, 200);
  assert.equal(payload.data.truncated, true);
  assert.equal(payload.data.limitExceeded, false);
});

test('422 AGGREGATION_LIMIT_EXCEEDED: точное количество, разбивка недоступна', async () => {
  mock.aggregateMode = 'limit';
  mock.aggregateBodies = [];
  const { status, payload } = await dashboard();

  assert.equal(status, 200);
  assert.equal(payload.data.limitExceeded, true);
  assert.equal(payload.data.total, 12345);
  assert.ok(payload.data.stages.every((s) => s.count === null && s.sum === null));
  assert.deepEqual(payload.data.kpi, { openAmount: null, wonCount: null, avgWonAmount: null });

  // Второй запрос — count без groupBy: он не читает записи и работает на любом объёме.
  const fallback = mock.aggregateBodies.at(-1);
  assert.equal(fallback.groupBy, undefined);
  assert.deepEqual(fallback.aggregate, [{ field: '*', function: 'count' }]);
});
