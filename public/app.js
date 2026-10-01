/* Фронтенд дашборда. Ходит только на свой бэкенд (/api/...),
   ключей и токенов в этом файле нет и быть не должно. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { mode: 'count', data: null, currency: '₸' };

  /* Авторизация пользователя живёт в httpOnly-cookie, которую бэкенд выдал
     при открытии места встраивания. Скрипт её не видит и не хранит токенов. */
  function request(path) {
    return fetch(path, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || payload.success === false) {
          var error = new Error((payload.error && payload.error.message) || 'Не удалось получить данные');
          error.code = payload.error && payload.error.code;
          throw error;
        }
        return payload.data;
      });
    });
  }

  function money(value) {
    return Math.round(value).toLocaleString('ru-RU') + ' ' + state.currency;
  }
  function count(value) {
    return Number(value).toLocaleString('ru-RU');
  }
  function iso(date) {
    return date.toISOString().slice(0, 10);
  }
  function text(node, value) {
    node.textContent = value;
  }
  function showError(message) {
    var box = $('alert');
    if (!message) { box.hidden = true; return; }
    box.hidden = false;
    text(box, message);
  }

  /* ---------- отрисовка ---------- */

  var COLORS = { progress: 'var(--blue)', success: 'var(--green)', failure: 'var(--red)' };

  function renderChart() {
    var chart = $('chart');
    var labels = $('labels');
    chart.innerHTML = '';
    labels.innerHTML = '';

    var stages = (state.data && state.data.stages) || [];
    if (!stages.length) {
      chart.innerHTML = '<div class="empty">По выбранным фильтрам стадий не найдено</div>';
      return;
    }

    var values = stages.map(function (s) { return state.mode === 'sum' ? s.sum : s.count; });
    var max = Math.max.apply(null, values.concat([1]));

    stages.forEach(function (stage, index) {
      var value = values[index];
      var column = document.createElement('div');
      column.className = 'col';
      column.style.setProperty('--c', COLORS[stage.kind] || COLORS.progress);

      var label = document.createElement('div');
      label.className = 'v';
      label.textContent = state.mode === 'sum' ? money(value) : count(value);

      var bar = document.createElement('div');
      bar.className = 'b';
      bar.style.height = Math.max(6, Math.round((value / max) * 190)) + 'px';
      bar.title = stage.name + ': ' + (state.mode === 'sum' ? money(value) : count(value) + ' сделок');

      column.appendChild(label);
      column.appendChild(bar);
      chart.appendChild(column);

      var caption = document.createElement('div');
      caption.textContent = stage.name;
      labels.appendChild(caption);
    });
  }

  function renderKpi() {
    var kpi = (state.data && state.data.kpi) || { openAmount: 0, wonCount: 0, avgWonAmount: 0 };
    text($('kpiOpen'), money(kpi.openAmount));
    text($('kpiWon'), count(kpi.wonCount));
    text($('kpiAvg'), money(kpi.avgWonAmount));
  }

  function renderDeals() {
    var body = $('dealsBody');
    body.innerHTML = '';
    var deals = (state.data && state.data.deals) || [];

    if (!deals.length) {
      var row = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'empty';
      cell.textContent = 'По выбранным фильтрам сделок не найдено';
      row.appendChild(cell);
      body.appendChild(row);
      text($('dealsTotal'), money(0));
      text($('dealsHint'), '');
      return;
    }

    var total = 0;
    deals.forEach(function (deal) {
      total += deal.amount;
      var row = document.createElement('tr');

      var title = document.createElement('td');
      title.className = 'l';
      title.textContent = deal.title;

      var stage = document.createElement('td');
      var chip = document.createElement('span');
      chip.className = 'chip ' + (deal.stageKind || 'progress');
      chip.textContent = deal.stage;
      stage.appendChild(chip);

      var responsible = document.createElement('td');
      responsible.textContent = deal.responsible;

      var amount = document.createElement('td');
      amount.className = 'n';
      amount.textContent = money(deal.amount);

      row.appendChild(title);
      row.appendChild(stage);
      row.appendChild(responsible);
      row.appendChild(amount);
      body.appendChild(row);
    });

    text($('dealsTotal'), money(total));
    text($('dealsHint'), 'показано сделок: ' + deals.length);
  }

  function renderUpdated() {
    if (!state.data) return;
    var when = new Date(state.data.updatedAt);
    text($('updated'), 'обновлено ' + when.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }));
  }

  /* ---------- данные ---------- */

  function currentQuery() {
    var params = new URLSearchParams();
    if ($('categoryId').value !== '') params.set('categoryId', $('categoryId').value);
    if ($('assignedById').value) params.set('assignedById', $('assignedById').value);
    if ($('dateFrom').value) params.set('dateFrom', $('dateFrom').value);
    if ($('dateTo').value) params.set('dateTo', $('dateTo').value);
    return params.toString();
  }

  function load() {
    $('apply').disabled = true;
    showError('');
    return request('/api/dashboard?' + currentQuery())
      .then(function (data) {
        state.data = data;
        state.currency = data.currency || '₸';
        renderKpi();
        renderChart();
        renderDeals();
        renderUpdated();
      })
      .catch(function (error) {
        showError(error.code === 'NO_USER_SESSION'
          ? 'Приложение открыто вне портала. Запустите его из меню Битрикс24 — данные показываются по правам вашей учётной записи.'
          : error.message);
      })
      .then(function () {
        $('apply').disabled = false;
      });
  }

  function fillSelect(select, items, placeholder) {
    select.innerHTML = '';
    if (placeholder) {
      var first = document.createElement('option');
      first.value = '';
      first.textContent = placeholder;
      select.appendChild(first);
    }
    items.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.appendChild(option);
    });
  }

  function defaultDates() {
    var now = new Date();
    $('dateFrom').value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    $('dateTo').value = iso(now);
  }

  function init() {
    defaultDates();

    $('modeCount').addEventListener('click', function () { setMode('count'); });
    $('modeSum').addEventListener('click', function () { setMode('sum'); });
    $('apply').addEventListener('click', load);
    $('reset').addEventListener('click', function () {
      defaultDates();
      $('assignedById').value = '';
      if ($('categoryId').options.length) $('categoryId').selectedIndex = 0;
      load();
    });

    request('/api/meta')
      .then(function (meta) {
        fillSelect($('categoryId'), meta.funnels, meta.funnels.length > 1 ? 'Все воронки' : null);
        fillSelect($('assignedById'), meta.users, 'Все ответственные');
        if (meta.funnels.length) $('categoryId').value = meta.funnels[0].id;
      })
      .catch(function (error) {
        showError('Не удалось загрузить справочники: ' + error.message);
      })
      .then(load);
  }

  function setMode(mode) {
    state.mode = mode;
    $('modeCount').setAttribute('aria-pressed', String(mode === 'count'));
    $('modeSum').setAttribute('aria-pressed', String(mode === 'sum'));
    renderChart();
  }

  init();
})();
