// Конфигурация читается ТОЛЬКО из переменных окружения.
// В репозитории нет и не должно быть ключей, токенов и вебхуков.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Не задана переменная окружения ${name}. ` +
      `Передайте её в блоке "env" при деплое в Вайбкоде.`
    );
  }
  return value;
}

export const config = {
  // Ключ Вайбкода: vibe_app_… (встраиваемое приложение) или vibe_api_… (личный ключ).
  // Значение живёт только в окружении сервера и никогда не уходит в браузер.
  apiKey: required('VIBECODE_API_KEY'),

  // Базовый адрес API Вайбкода.
  apiBase: (process.env.VIBECODE_API_BASE || 'https://vibecode.bitrix24.tech').replace(/\/+$/, ''),

  // Порт: в Чёрной дыре Вайбкода туннель проксирует ровно 3000.
  port: Number(process.env.PORT || 3000),

  // Валюта портала для подписей сумм.
  currency: process.env.DASHBOARD_CURRENCY || '₸',

  // Сколько последних сделок показывать в таблице.
  recentLimit: Number(process.env.DASHBOARD_RECENT_LIMIT || 20),

  // Время жизни кэша справочников (воронки, стадии, сотрудники), мс.
  metaCacheTtl: Number(process.env.DASHBOARD_META_TTL_MS || 5 * 60 * 1000),

  // Время жизни кэша данных дашборда, мс.
  dataCacheTtl: Number(process.env.DASHBOARD_DATA_TTL_MS || 30 * 1000),
};

export const isAppKey = config.apiKey.startsWith('vibe_app_');
