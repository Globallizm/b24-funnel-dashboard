#!/usr/bin/env node
// Привязка приложения к местам встраивания портала.
//
//   VIBECODE_API_KEY=... APP_URL=https://app-xxx.vibecode.bitrix24.tech \
//     node scripts/bind-placements.js            # показать доступные места
//     node scripts/bind-placements.js --bind     # привязать меню и вкладку CRM
//     node scripts/bind-placements.js --list     # показать уже привязанные
//
// Ключ читается из окружения и в репозиторий не попадает.

import { availablePlacements, boundPlacements, bindPlacement } from '../src/placements.js';

const appUrl = process.env.APP_URL;
const sessionToken = process.env.VIBECODE_SESSION_TOKEN || undefined;
const mode = process.argv[2] || '--available';

// Предпочитаемые места: левое меню портала и вкладка в карточке сделки.
// Коды сверяются с живым списком — хардкодить их платформа не рекомендует.
const WANTED = [
  { match: /^(LEFT_MENU|MENU)/i, title: 'Дашборд воронки продаж' },
  { match: /^CRM_DEAL_DETAIL_TAB$/i, title: 'Аналитика воронки' },
];

function fail(message) {
  console.error('Ошибка: ' + message);
  process.exit(1);
}

const available = await availablePlacements(sessionToken).catch((error) => fail(error.message));
const codes = available.map((item) => (typeof item === 'string' ? item : item.code || item.placement));

if (mode === '--available') {
  console.log('Доступные места встраивания:\n' + codes.map((c) => '  ' + c).join('\n'));
  console.log('\nДля привязки: node scripts/bind-placements.js --bind');
  process.exit(0);
}

if (mode === '--list') {
  const bound = await boundPlacements(sessionToken).catch((error) => fail(error.message));
  console.log(JSON.stringify(bound, null, 2));
  process.exit(0);
}

if (mode === '--bind') {
  if (!appUrl) fail('не задана переменная APP_URL с адресом приложения');

  const targets = WANTED
    .map((wanted) => ({ code: codes.find((code) => wanted.match.test(code)), title: wanted.title }))
    .filter((target) => target.code);

  if (!targets.length) fail('на портале не нашлось подходящих мест встраивания');

  for (const target of targets) {
    await bindPlacement({
      placement: target.code,
      handler: appUrl,
      title: target.title,
      description: 'Аналитика сделок по стадиям воронки',
      sessionToken,
    })
      .then(() => console.log(`Привязано: ${target.code} → ${appUrl}`))
      .catch((error) => console.error(`Не удалось привязать ${target.code}: ${error.message}`));
  }
  process.exit(0);
}

fail(`неизвестный режим ${mode}`);
