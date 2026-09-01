// Таблица группы для проектора.
//
// Считается только прогресс. Время решения не учитывается и не показывается:
// если считать скорость, через двадцать минут трое уедут вперёд, а остальные
// перестанут стараться. При подсчёте по прогрессу цифра растёт у каждого.

(function () {
  'use strict';

  var POLL_MS = 3000;   // обычный опрос, WebSocket здесь не нужен

  var lang = new URLSearchParams(location.search).get('lang') === 'csharp' ? 'csharp' : 'python';
  var previous = {};    // имя -> сколько решено на прошлом опросе
  var known = false;

  var rowsHost = document.getElementById('board-rows');
  var emptyBox = document.getElementById('board-empty');
  var statusBox = document.getElementById('board-status');

  document.getElementById('board-lang').textContent = lang === 'csharp' ? 'c#' : 'python';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function renderLegend(data) {
    var host = document.getElementById('board-legend');
    if (host.dataset.done === '1') return;
    host.innerHTML = '<div class="board-name-col"></div>' +
      '<div class="board-meter-col">' +
      data.topics.map(function (t, i) {
        return '<span class="legend-seg' + (t.ready ? '' : ' is-soon') + '" title="' +
          esc(t.title) + '">' + (i + 1) + '</span>';
      }).join('') +
      '</div><div class="board-count-col">решено</div>';
    host.dataset.done = '1';

    document.getElementById('board-keys').innerHTML =
      data.topics.map(function (t, i) {
        return '<span class="key"><b>' + (i + 1) + '</b> ' + esc(t.title) + '</span>';
      }).join('');
  }

  function meterHTML(topics, per) {
    return topics.map(function (done) {
      var cells = '';
      for (var i = 0; i < per; i++) {
        cells += '<i class="bnotch' + (i < done ? ' is-done' : '') + '"></i>';
      }
      return '<span class="bseg">' + cells + '</span>';
    }).join('');
  }

  function render(data) {
    renderLegend(data);

    var where = data.url || location.origin;
    document.getElementById('board-where').textContent = where;
    document.getElementById('board-empty-sub').textContent = 'Дети открывают ' + where;

    var totalDone = data.students.reduce(function (a, s) { return a + s.solved; }, 0);
    var capacity = data.topics.length * data.tasks_per_topic;
    document.getElementById('board-total').innerHTML =
      '<b>' + totalDone + '</b> ' + plural(totalDone, 'задача', 'задачи', 'задач') + ' решено';

    emptyBox.hidden = data.students.length > 0;
    rowsHost.hidden = data.students.length === 0;

    rowsHost.innerHTML = data.students.map(function (s) {
      var grew = known && previous[s.name] !== undefined && s.solved > previous[s.name];
      return '<div class="brow' + (grew ? ' is-grown' : '') + '">' +
        '<div class="board-name-col bname">' + esc(s.name) + '</div>' +
        '<div class="board-meter-col bmeter">' + meterHTML(s.topics, data.tasks_per_topic) + '</div>' +
        '<div class="board-count-col bcount">' + s.solved +
          '<span class="bcount-of">/' + capacity + '</span></div>' +
        '</div>';
    }).join('');

    data.students.forEach(function (s) { previous[s.name] = s.solved; });
    known = true;
  }

  function tick() {
    Net.get('/api/board?lang=' + lang).then(function (data) {
      statusBox.textContent = '';
      statusBox.className = 'board-link';
      render(data);
    }, function (e) {
      if (e.unauthorized) return location.reload();   // вход протух — форма пароля
      statusBox.textContent = 'Связь с сервером потеряна — таблица не обновляется. Дети продолжают решать.';
      statusBox.className = 'board-link is-bad';
    });
  }

  tick();
  setInterval(tick, POLL_MS);
})();
