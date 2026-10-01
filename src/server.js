// HTTP-сервер приложения: приём места встраивания, статика и JSON-эндпоинты.
// Паттерн BFF: ключ Вайбкода остаётся на сервере, в браузер уходят только готовые данные.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, isAppKey } from './config.js';
import { loadMeta, loadDashboard } from './dashboard.js';
import { ApiError } from './vibecode.js';
import { createSession, getSession, cookieHeader, sessionIdFromCookies } from './session.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Приложение открывается во фрейме портала Битрикс24.
const FRAME_HEADERS = {
  'Content-Security-Policy': "frame-ancestors https://*.bitrix24.ru https://*.bitrix24.kz https://*.bitrix24.com https://*.bitrix24.by https://*.bitrix24.ua https://*.bitrix24.eu",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...FRAME_HEADERS,
  });
  response.end(body);
}

async function sendFile(response, filePath, extraHeaders = {}) {
  const data = await readFile(filePath);
  response.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    'Content-Length': data.length,
    ...FRAME_HEADERS,
    ...extraHeaders,
  });
  response.end(data);
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError('Слишком большой запрос', 413, 'PAYLOAD_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Токен сессии текущего сотрудника.
 * Основной источник — httpOnly-cookie, выданная при открытии места встраивания.
 * Заголовок Authorization принимается для локальной отладки и проверки.
 */
function sessionTokenFrom(request) {
  const session = getSession(sessionIdFromCookies(request.headers.cookie));
  if (session) return session.token;

  const header = request.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return undefined;
}

/**
 * Во встроенном режиме (ключ vibe_app_…) приложение обязано работать
 * от лица авторизованного сотрудника: без его токена данные не отдаются,
 * иначе все сотрудники видели бы одну и ту же выборку.
 */
function requireUserSession(sessionToken) {
  if (isAppKey && !sessionToken) {
    throw new ApiError(
      'Нет сессии пользователя. Откройте приложение внутри портала Битрикс24.',
      401,
      'NO_USER_SESSION'
    );
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    // Портал открывает место встраивания POST-запросом с параметрами авторизации.
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const body = new URLSearchParams(await readBody(request));
      const token = body.get('AUTH_ID') || body.get('access_token');

      if (!token) {
        return await sendFile(response, join(PUBLIC_DIR, 'index.html'));
      }

      const sessionId = createSession({
        token,
        memberId: body.get('member_id') || undefined,
        placement: body.get('PLACEMENT') || undefined,
        userId: body.get('USER_ID') || undefined,
      });

      // Редирект на GET: токен не остаётся ни в адресной строке, ни в истории.
      response.writeHead(303, {
        Location: '/',
        'Set-Cookie': cookieHeader(sessionId),
        ...FRAME_HEADERS,
      });
      return response.end();
    }

    if (url.pathname === '/healthz') {
      return sendJson(response, 200, { status: 'ok' });
    }

    const sessionToken = sessionTokenFrom(request);

    if (url.pathname === '/api/meta') {
      requireUserSession(sessionToken);
      const meta = await loadMeta(sessionToken);
      return sendJson(response, 200, { success: true, data: meta });
    }

    if (url.pathname === '/api/dashboard') {
      requireUserSession(sessionToken);
      const params = {
        categoryId: url.searchParams.get('categoryId') ?? '',
        assignedById: url.searchParams.get('assignedById') ?? '',
        dateFrom: url.searchParams.get('dateFrom') ?? '',
        dateTo: url.searchParams.get('dateTo') ?? '',
      };
      const data = await loadDashboard(params, sessionToken);
      return sendJson(response, 200, { success: true, data });
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(response, 404, { success: false, error: { message: 'Эндпоинт не найден' } });
    }

    // Статика
    const relative = url.pathname === '/'
      ? 'index.html'
      : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const filePath = join(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(response, 403, { success: false, error: { message: 'Доступ запрещён' } });
    }
    try {
      return await sendFile(response, filePath);
    } catch {
      return await sendFile(response, join(PUBLIC_DIR, 'index.html'));
    }
  } catch (error) {
    const status = error instanceof ApiError ? (error.status >= 400 ? error.status : 502) : 500;
    // В браузер уходит текст ошибки без служебных деталей и без ключей.
    console.error('[dashboard]', error.code || error.name, error.message);
    return sendJson(response, status, {
      success: false,
      error: {
        code: error.code || 'INTERNAL',
        message: error instanceof ApiError ? error.message : 'Внутренняя ошибка приложения',
      },
    });
  }
});

server.listen(config.port, () => {
  console.log(
    `Дашборд воронки продаж слушает порт ${config.port} ` +
    `(режим: ${isAppKey ? 'встроенное приложение, данные от лица пользователя' : 'личный ключ'})`
  );
});
