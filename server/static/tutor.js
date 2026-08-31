// Страница тьютора: тот же прогресс плюс «кто на какой задаче сидит дольше всех».
// Это единственное место, где время вообще фигурирует, и видит его только тьютор.
// Открывать код ребёнка страница не умеет — по решению заказчика.

(function () {
  'use strict';

  var POLL_MS = 3000;
  var STUCK_SEC = 8 * 60;    // столько сидеть над одной задачей — уже повод подойти
  var IDLE_SEC = 5 * 60;     // столько молчать — скорее всего, ушёл или закрыл вкладку

  var lang = new URLSearchParams(location.search).get('lang') === 'csharp' ? 'csharp' : 'python';

  document.getElementById('tutor-lang').textContent = lang === 'csharp' ? 'c#' : 'python';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function minutes(sec) {
    if (sec === null || sec === undefined) return '—';
    var m = Math.floor(sec / 60);
    if (m < 1) return 'меньше минуты';
    if (m < 60) return m + ' мин';
    return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
  }

  function meterHTML(topics, per) {
    return topics.map(function (done) {
      var cells = '';
      for (var i = 0; i < per; i++) cells += '<i class="tnotch' + (i < done ? ' is-done' : '') + '"></i>';
      return '<span class="tseg">' + cells + '</span>';
    }).join('');
  }

  function renderStuck(data) {
    var host = document.getElementById('tutor-stuck');

    var sitting = data.students.filter(function (s) {
      return s.task_id && s.on_task_sec !== null && (s.idle_sec === null || s.idle_sec < IDLE_SEC);
    }).sort(function (a, b) { return b.on_task_sec - a.on_task_sec; });

    if (!sitting.length) {
      host.innerHTML = '<div class="tutor-quiet">Сейчас никто не работает.</div>';
      return;
    }

    host.innerHTML = sitting.map(function (s) {
      var stuck = s.on_task_sec >= STUCK_SEC;
      var title = data.task_titles[s.task_id] || s.task_id;
      return '<div class="stuck' + (stuck ? ' is-long' : '') + '">' +
        '<span class="stuck-name">' + esc(s.name) + '</span>' +
        '<span class="stuck-task">' + esc(title) + '</span>' +
        '<span class="stuck-time">' + minutes(s.on_task_sec) + '</span>' +
        '</div>';
    }).join('');
  }

  function renderRows(data) {
    var host = document.getElementById('tutor-rows');
    var capacity = data.topics.length * data.tasks_per_topic;

    document.getElementById('tutor-empty').hidden = data.students.length > 0;

    host.innerHTML = data.students.map(function (s) {
      var away = s.idle_sec !== null && s.idle_sec >= IDLE_SEC;
      return '<div class="trow' + (away ? ' is-away' : '') + '">' +
        '<span class="tname">' + esc(s.name) + '</span>' +
        '<span class="tmeter">' + meterHTML(s.topics, data.tasks_per_topic) + '</span>' +
        '<span class="thints">' + (s.hints ? s.hints + ' подск.' : '') + '</span>' +
        '<span class="tcount">' + s.solved + '<span class="tcount-of">/' + capacity + '</span></span>' +
        '</div>';
    }).join('');

    var total = data.students.reduce(function (a, s) { return a + s.solved; }, 0);
    document.getElementById('tutor-total').textContent =
      data.students.length + ' в группе · решено ' + total;
  }

  function renderKeys(data) {
    var host = document.getElementById('tutor-keys');
    if (host.dataset.done === '1') return;
    host.innerHTML = data.topics.map(function (t, i) {
      return '<span class="key"><b>' + (i + 1) + '</b> ' + esc(t.title) + '</span>';
    }).join('');
    host.dataset.done = '1';
  }

  function tick() {
    Net.get('/api/tutor?lang=' + lang).then(function (data) {
      document.getElementById('tutor-status').textContent = '';
      document.getElementById('tutor-status').className = 'board-link';
      document.getElementById('tutor-where').textContent = data.url || location.origin;
      renderKeys(data);
      renderStuck(data);
      renderRows(data);
    }, function () {
      var s = document.getElementById('tutor-status');
      s.textContent = 'Связь с сервером потеряна.';
      s.className = 'board-link is-bad';
    });
  }

  tick();
  setInterval(tick, POLL_MS);
})();
