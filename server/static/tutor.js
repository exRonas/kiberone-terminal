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

  // Ноутбук тьютора нередко общий: выход нужен, чтобы кука не жила там сутки.
  document.getElementById('tutor-logout').addEventListener('click', function () {
    Net.send('/api/logout', {}).then(function () { location.href = '/'; },
                                     function () { location.href = '/'; });
  });

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
      var asking = s.name === pendingDelete;
      return '<div class="trow' + (away ? ' is-away' : '') + (asking ? ' is-asking' : '') + '">' +
        '<span class="tname">' + esc(s.name) + '</span>' +
        '<span class="tmeter">' + meterHTML(s.topics, data.tasks_per_topic) + '</span>' +
        '<span class="thints">' + (s.hints ? s.hints + ' подск.' : '') + '</span>' +
        '<span class="tcount">' + s.solved + '<span class="tcount-of">/' + capacity + '</span></span>' +
        '<span class="tdel">' + (asking
          ? '<button class="btn btn-sm tdel-yes" type="button" data-del="' + esc(s.name) + '">Удалить насовсем</button>'
          : '<button class="btn btn-sm tdel-ask" type="button" data-ask="' + esc(s.name) + '">Удалить</button>') +
        '</span>' +
        '</div>';
    }).join('');

    var total = data.students.reduce(function (a, s) { return a + s.solved; }, 0);
    document.getElementById('tutor-total').textContent =
      data.students.length + ' в группе · решено ' + total;
  }

  // ---------- удаление ребёнка ----------

  // Удаление необратимо, поэтому в два нажатия. Имя, по которому ждём
  // подтверждения, живёт вне разметки: строки перерисовываются каждые
  // три секунды опросом, и вопрос иначе стирало бы на полуслове.
  var pendingDelete = null;
  var pendingTimer = null;
  var lastData = null;    // последний ответ сервера, чтобы перерисовать без запроса
  var noteUntil = 0;      // до какого момента сообщение не затирается опросом

  function repaint() {
    if (lastData) renderRows(lastData);
  }

  function ask(name) {
    pendingDelete = name;
    clearTimeout(pendingTimer);
    // Вопрос не висит вечно: не ответили — кнопка возвращается сама.
    pendingTimer = setTimeout(function () {
      pendingDelete = null;
      repaint();
    }, 6000);
    repaint();
  }

  function remove(name) {
    pendingDelete = null;
    clearTimeout(pendingTimer);
    repaint();

    Net.send('/api/student/delete', { name: name }).then(function () {
      // Сначала обновляем таблицу, потом пишем итог: tick чистит строку
      // состояния сам, и сообщение иначе стёрлось бы в тот же миг.
      tick().then(function () { note(name + ' — удалён из таблицы.', false); });
    }, function (e) {
      if (e.unauthorized) return location.reload();
      note('Не удалось удалить: ' + (e.rejected ? e.message : 'сервер не отвечает.'), true);
    });
  }

  function note(text, bad) {
    var box = document.getElementById('tutor-status');
    box.textContent = text;
    box.className = 'board-link' + (bad ? ' is-bad' : '');
    noteUntil = Date.now() + (bad ? 10000 : 5000);
  }

  document.getElementById('tutor-rows').addEventListener('click', function (ev) {
    var asking = ev.target.closest('[data-ask]');
    if (asking) return ask(asking.getAttribute('data-ask'));

    var doomed = ev.target.closest('[data-del]');
    if (doomed) return remove(doomed.getAttribute('data-del'));
  });

  function renderKeys(data) {
    var host = document.getElementById('tutor-keys');
    if (host.dataset.done === '1') return;
    host.innerHTML = data.topics.map(function (t, i) {
      return '<span class="key"><b>' + (i + 1) + '</b> ' + esc(t.title) + '</span>';
    }).join('');
    host.dataset.done = '1';
  }

  function tick() {
    return Net.get('/api/tutor?lang=' + lang).then(function (data) {
      lastData = data;
      // Опрос идёт раз в три секунды и затирает строку состояния. Свежее
      // сообщение он не трогает — иначе итог удаления гаснет, не успев
      // прочитаться.
      if (Date.now() > noteUntil) {
        document.getElementById('tutor-status').textContent = '';
        document.getElementById('tutor-status').className = 'board-link';
      }
      document.getElementById('tutor-where').textContent = data.url || location.origin;
      renderKeys(data);
      renderStuck(data);
      renderRows(data);
    }, function (e) {
      if (e.unauthorized) return location.reload();   // вход протух — форма пароля
      var s = document.getElementById('tutor-status');
      s.textContent = 'Связь с сервером потеряна.';
      s.className = 'board-link is-bad';
    });
  }

  tick();
  setInterval(tick, POLL_MS);
})();
