// Страница темы: теория с живыми примерами слева, задача с проверкой справа.
// Шаг 1 — без сервера: прогресс лежит в localStorage.

(function () {
  'use strict';

  var TOPIC_ORDER = [
    'basics', 'conditions', 'loops-for', 'loops-while',
    'lists', 'strings', 'functions', 'dicts'
  ];

  var TOPIC_NAMES = {
    'basics': 'Переменные и вывод',
    'conditions': 'Условия',
    'loops-for': 'Цикл for',
    'loops-while': 'Цикл while',
    'lists': 'Списки',
    'strings': 'Строки',
    'functions': 'Функции',
    'dicts': 'Словари'
  };

  var TASKS_PER_TOPIC = 3;
  var REVEAL_MS = 170;  // тесты загораются по одному
  var SCAN_MS = 420;    // проход развёртки при сдаче

  var state = {
    lang: 'python',
    topic: 'conditions',
    data: null,
    topics: null,      // список тем курса, приходит с сервера
    name: '',
    taskIndex: 0,
    editor: null,
    compareEditor: null,
    running: false
  };

  // ---------- хранилище ----------

  function storeKey(kind) { return 'terminal:' + kind + ':' + state.lang; }

  function readStore(kind) {
    try { return JSON.parse(localStorage.getItem(storeKey(kind))) || {}; }
    catch (e) { return {}; }
  }

  function writeStore(kind, obj) {
    try { localStorage.setItem(storeKey(kind), JSON.stringify(obj)); }
    catch (e) { /* приватный режим — работаем без сохранения */ }
  }

  function isSolved(id) { return readStore('solved')[id] === true; }

  function markSolved(id) {
    var s = readStore('solved');
    s[id] = true;
    writeStore('solved', s);
  }

  function savedCode(id) { return readStore('code')[id]; }

  function saveCode(id, code) {
    var c = readStore('code');
    c[id] = code;
    writeStore('code', c);
  }

  function hintsTaken(id) { return readStore('hints')[id] || 0; }

  function takeHint(id, n) {
    var h = readStore('hints');
    h[id] = n;
    writeStore('hints', h);
  }

  function solvedInTopic(topic) {
    var s = readStore('solved');
    return Object.keys(s).filter(function (id) {
      return s[id] === true && id.indexOf(topic + '-') === 0;
    }).length;
  }

  // ---------- мелочи ----------

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // `код` в тексте становится <code>, пустая строка — новым абзацем
  function richText(s) {
    return esc(s)
      .split(/\n{2,}/)
      .map(function (p) {
        return '<p>' + p.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>') + '</p>';
      })
      .join('');
  }

  function inlineCode(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function calmMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Экран класса — 1366x768. Показания прибора должны быть видны
  // в тот момент, когда они меняются, иначе весь смысл теряется.
  function bringIntoView(node, block) {
    node.scrollIntoView({ behavior: calmMotion() ? 'auto' : 'smooth', block: block });
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function cmBase(extra) {
    var opts = {
      mode: state.lang === 'csharp' ? 'text/x-csharp' : 'python',
      theme: 'kiber',
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      styleActiveLine: true,
      matchBrackets: true
    };
    for (var k in extra) opts[k] = extra[k];
    return opts;
  }

  // Один запускаемый пример. lang задаёт и подсветку, и способ запуска.
  function makeExample(host, code, lang) {
    var example = document.createElement('div');
    example.className = 'example';

    var tag = document.createElement('div');
    tag.className = 'example-lang';
    tag.textContent = lang === 'csharp' ? 'C#' : 'Python';
    example.appendChild(tag);

    var ta = document.createElement('textarea');
    example.appendChild(ta);

    var bar = document.createElement('div');
    bar.className = 'example-bar';
    var runBtn = document.createElement('button');
    runBtn.className = 'btn btn-sm';
    runBtn.type = 'button';
    runBtn.textContent = 'Запустить';
    var note = document.createElement('span');
    note.className = 'bar-note';
    note.textContent = lang === 'csharp' ? 'считает сервер' : 'код можно менять';
    bar.appendChild(runBtn);
    bar.appendChild(note);

    var out = document.createElement('pre');
    out.className = 'example-out';

    example.appendChild(bar);
    example.appendChild(out);
    host.appendChild(example);

    var cm = CodeMirror.fromTextArea(ta, cmBase({
      lineNumbers: false,
      viewportMargin: Infinity,
      mode: lang === 'csharp' ? 'text/x-csharp' : 'python'
    }));
    cm.setValue(code);

    runBtn.addEventListener('click', function () {
      runBtn.disabled = true;
      runBtn.textContent = 'Идёт…';
      out.className = 'example-out';
      out.textContent = '';

      var done = function (text, bad) {
        out.className = 'example-out' + (bad ? ' is-error' : '');
        out.textContent = text;
        runBtn.disabled = false;
        runBtn.textContent = 'Запустить';
      };

      if (lang === 'csharp') {
        // Пример теории — это цельная программа, а не решение задачи,
        // поэтому идёт на сервер без task_id.
        Net.send('/api/run', { lang: 'csharp', code: cm.getValue() }).then(function (data) {
          if (data.compile_errors) {
            return done(data.compile_errors.map(function (e) {
              return (e.line ? 'Строка ' + e.line + ': ' : '') + (e.hint || e.message);
            }).join('\n'), true);
          }
          if (data.error) return done(data.error, true);
          done(data.printed || 'Программа ничего не напечатала.', false);
        }, function (e) {
          done(e.rejected ? e.message : 'Сервер не отвечает — C# считается на нём.', true);
        });
        return;
      }

      Runner.runSnippet(cm.getValue()).then(function (res) {
        if (res.ok) return done(res.output || 'Программа ничего не напечатала.', false);
        done((res.output ? res.output + '\n' : '') + errorPlain(res.error), true);
      });
    });

    return cm;
  }

  function errorLine(err) {
    return err.line ? { head: 'Строка ' + err.line + ':', body: err.text } : { head: '', body: err.text };
  }

  function errorPlain(err) {
    var e = errorLine(err);
    return (e.head ? e.head + ' ' : '') + e.body;
  }

  // ---------- загрузка контента ----------

  // Под сервером — /api/content/..., при открытии через простой
  // статический сервер — файл из соседней папки content/.
  function loadContent(lang, topic) {
    var api = '/api/content/' + lang + '/' + topic + '.json';
    var rel = '../../content/' + lang + '/' + topic + '.json';
    return fetch(api)
      .then(function (r) { if (!r.ok) throw new Error('нет'); return r.json(); })
      .catch(function () {
        return fetch(rel).then(function (r) {
          if (!r.ok) throw new Error('файл темы не найден по пути ' + rel);
          return r.json();
        });
      });
  }

  // ---------- запуск решения ----------
  //
  // Python считается в браузере, C# — на машине тьютора. Наружу оба
  // выглядят одинаково: на входе код, на выходе результат по каждому тесту.

  function runTests(code, task) {
    return state.lang === 'csharp' ? runCsharp(code, task) : runPython(code, task);
  }

  function runPython(code, task) {
    var results = [];
    var printed = '';
    var chain = Promise.resolve();

    // Каждый тест выполняется в свежем модуле: один тест не влияет
    // на другой, и лимит времени отсчитывается заново.
    task.tests.forEach(function (tc, i) {
      chain = chain.then(function () {
        if (results.fatal) return;
        return Runner.callEntry(code, task.entry, tc.args).then(function (res) {
          if (res.output) printed += res.output;
          if (!res.ok) {
            results[i] = { pass: false, error: res.error };
            // Ошибка, из-за которой остальные тесты бессмысленны.
            if (res.error.line === null && /нет функции|не функция|слишком долго/.test(res.error.text)) {
              results.fatal = res.error;
            }
            return;
          }
          results[i] = { pass: Runner.deepEqual(res.value, tc.expect), got: res.value };
        });
      });
    });

    return chain.then(function () { return { results: results, printed: printed }; });
  }

  function runCsharp(code, task) {
    return Net.send('/api/run', { lang: 'csharp', task_id: task.id, code: code })
      .then(function (data) {
        if (data.compile_errors) {
          return { results: [], printed: '', compile: data.compile_errors };
        }
        if (data.error) {
          return { results: [], printed: '', fatal: { line: null, text: data.error } };
        }
        var results = (data.tests || []).map(function (r) {
          if (r.error) return { pass: false, error: { line: null, text: r.error } };
          return { pass: r.pass, got: r.got };
        });
        return { results: results, printed: data.printed || '', buildSec: data.build_sec };
      }, function (e) {
        // Отказ сервера (нет SDK) и пропажа связи — разные вещи, и сказать
        // о них надо по-разному.
        return {
          results: [], printed: '',
          fatal: {
            line: null,
            text: e.rejected ? e.message
              : 'Сервер не отвечает, а C# считается на нём. Python-версия работает и без сервера.'
          }
        };
      });
  }

  // ---------- сервер ----------
  //
  // Сервер нужен только общей таблице. Если он молчит, Net складывает
  // отправку в очередь, а ребёнок ничего не замечает и решает дальше.

  function reportActivity() {
    if (!state.name) return;
    Net.push('/api/activity', {
      name: state.name,
      lang: state.lang,
      task_id: currentTask().id
    });
  }

  function reportProgress(task, solved) {
    if (!state.name) return;
    Net.push('/api/progress', {
      name: state.name,
      lang: state.lang,
      task_id: task.id,
      solved: !!solved,
      hints: hintsTaken(task.id),
      code: state.editor ? state.editor.getValue().slice(0, 20000) : ''
    });
  }

  // ---------- верхняя шина ----------

  function renderRail() {
    el('rail-topic').innerHTML = '<b>' + esc(state.data.title) + '</b>' +
      (state.data.subtitle ? ' · ' + esc(state.data.subtitle) : '');
    el('mark-lang').textContent = state.lang === 'csharp' ? 'c#' : 'python';

    var meter = el('course');
    meter.innerHTML = '';
    var total = 0;

    // Темы идут по порядку: открыта каждая до первой недорешённой
    // включительно. Вернуться к пройденной можно всегда.
    var counts = TOPIC_ORDER.map(function (t) { return Math.min(solvedInTopic(t), TASKS_PER_TOPIC); });
    var frontier = counts.length - 1;
    for (var k = 0; k < counts.length; k++) {
      if (counts[k] < TASKS_PER_TOPIC) { frontier = k; break; }
    }

    TOPIC_ORDER.forEach(function (t, idx) {
      var done = counts[idx];
      total += done;

      var info = topicInfo(t);
      var ready = info ? info.ready : (t === state.topic);
      // Тема, на которой ребёнок сейчас, открыта всегда — иначе он видит
      // «закрыто» на странице, которую уже читает.
      var open = ready && (idx <= frontier || t === state.topic);

      var seg = document.createElement(open ? 'button' : 'div');
      seg.className = 'seg';
      if (open) seg.type = 'button';
      if (!ready) seg.dataset.soon = '1';
      else if (!open) seg.dataset.locked = '1';
      if (t === state.topic) seg.dataset.current = '1';
      seg.dataset.topic = t;

      var title = (info && info.title) || TOPIC_NAMES[t];
      seg.title = !ready
        ? title + ' — тема ещё не готова'
        : (open ? title + ' — ' + done + ' из ' + TASKS_PER_TOPIC
                : title + ' — откроется, когда закончишь предыдущую');

      for (var i = 0; i < TASKS_PER_TOPIC; i++) {
        var n = document.createElement('div');
        n.className = 'notch' + (i < done ? ' is-done' : '');
        n.dataset.index = String(i);
        seg.appendChild(n);
      }
      if (open && t !== state.topic) {
        seg.addEventListener('click', function () {
          location.href = '/topic?lang=' + state.lang + '&topic=' + t;
        });
      }
      meter.appendChild(seg);
    });

    el('course-count').innerHTML = '<b>' + total + '</b>/' + (TOPIC_ORDER.length * TASKS_PER_TOPIC);
  }

  function topicInfo(topic) {
    if (!state.topics) return null;
    for (var i = 0; i < state.topics.length; i++) {
      if (state.topics[i].topic === topic) return state.topics[i];
    }
    return null;
  }

  // Вспышка новой насечки: жёлтая — «сейчас», потом оседает в бирюзу.
  function latchNotch() {
    var done = Math.min(solvedInTopic(state.topic), TASKS_PER_TOPIC);
    var seg = el('course').querySelector('[data-topic="' + state.topic + '"]');
    if (!seg) return;
    var notch = seg.querySelector('.notch[data-index="' + (done - 1) + '"]');
    if (!notch) return;
    notch.classList.add('is-latching');
    setTimeout(function () {
      notch.classList.remove('is-latching');
      notch.classList.add('is-done');
    }, 620);
  }

  // ---------- теория ----------

  function renderTheory() {
    var cards = state.data.theory || [];
    var host = el('theory');
    host.innerHTML = '';
    el('theory-note').textContent = cards.length + ' ' + plural(cards.length, 'карточка', 'карточки', 'карточек');

    cards.forEach(function (card, i) {
      var li = document.createElement('li');
      li.className = 'card rise';
      li.style.animationDelay = (40 * i) + 'ms';
      li.dataset.open = i === 0 ? '1' : '0';

      var head = document.createElement('button');
      head.className = 'card-head';
      head.type = 'button';
      head.setAttribute('aria-expanded', i === 0 ? 'true' : 'false');
      head.innerHTML =
        '<span class="card-idx">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="card-title">' + esc(card.title) + '</span>' +
        '<span class="card-chevron">&#9654;</span>';

      var body = document.createElement('div');
      body.className = 'card-body';

      var text = document.createElement('div');
      text.className = 'card-text';
      text.innerHTML = richText(card.text);

      body.appendChild(text);

      // В C#-версии тот же пример показан на двух языках рядом: это и есть
      // ответ на вопрос «чем языки отличаются».
      var editors = [];
      editors.push(makeExample(body, card.code, state.lang));
      if (card.code_python) {
        editors.push(makeExample(body, card.code_python, 'python'));
      }

      li.appendChild(head);
      li.appendChild(body);
      host.appendChild(li);

      head.addEventListener('click', function () {
        var open = li.dataset.open === '1';
        li.dataset.open = open ? '0' : '1';
        head.setAttribute('aria-expanded', String(!open));
        if (!open) editors.forEach(function (cm) { cm.refresh(); });
      });

      if (i === 0) setTimeout(function () {
        editors.forEach(function (cm) { cm.refresh(); });
      }, 0);
    });
  }

  // ---------- задача ----------

  function currentTask() { return state.data.tasks[state.taskIndex]; }

  function nextUnsolvedIndex() {
    for (var i = 0; i < state.data.tasks.length; i++) {
      if (!isSolved(state.data.tasks[i].id)) return i;
    }
    return -1;
  }

  function renderTaskNav(callIndex) {
    var nav = el('tasknav');
    nav.innerHTML = '';
    state.data.tasks.forEach(function (task, i) {
      var b = document.createElement('button');
      b.className = 'tasknav-btn' + (i === callIndex ? ' is-next' : '');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === state.taskIndex));
      b.innerHTML = '<span class="pip' + (isSolved(task.id) ? ' is-done' : '') + '"></span>' + (i + 1);
      b.title = task.title;
      b.addEventListener('click', function () { goToTask(i); });
      nav.appendChild(b);
    });
  }

  function goToTask(i) {
    if (i === state.taskIndex || i < 0 || i >= state.data.tasks.length) return;
    state.taskIndex = i;
    renderTask();
    renderTaskNav();
    el('tasknav').closest('.col').scrollTop = 0;
  }

  function renderTask() {
    var task = currentTask();

    el('task-title').textContent = task.title;
    el('task-statement').innerHTML = inlineCode(task.statement);

    if (state.editor) {
      state.editor.toTextArea();
      state.editor = null;
    }
    document.body.dataset.lang = state.lang;
    el('editor').value = savedCode(task.id) || task.starter;

    state.editor = CodeMirror.fromTextArea(el('editor'), cmBase({
      lineNumbers: true,
      extraKeys: { 'Ctrl-Enter': check, 'Cmd-Enter': check }
    }));
    state.editor.on('change', function (cm) { saveCode(task.id, cm.getValue()); });
    setTimeout(function () { state.editor.refresh(); }, 0);

    clearVerdict();
    el('latch').classList.remove('is-on');
    el('tests-panel').classList.remove('is-solved');
    el('stdout-panel').hidden = true;

    renderHints();
    renderTests(null);
    reportActivity();
    renderCompare(task);

    // Уже решённую задачу открываем со штампом — прогресс никуда не делся.
    if (isSolved(task.id)) showLatch(task, true);
  }

  function clearVerdict() {
    var v = el('verdict');
    v.textContent = '';
    v.innerHTML = '';
  }

  // C#-занятие: рядом с пустым редактором — своё решение той же задачи
  // на Python, написанное неделю назад. Если его нет, показываем эталон
  // с честной пометкой «пример».
  function renderCompare(task) {
    var panel = el('compare-panel');
    if (state.lang !== 'csharp') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    el('compare-note').textContent = 'ищу…';

    if (state.compareEditor) {
      state.compareEditor.toTextArea();
      state.compareEditor = null;
    }

    var show = function (code, note) {
      el('compare-note').textContent = note;
      el('compare-code').value = code;
      state.compareEditor = CodeMirror.fromTextArea(el('compare-code'), cmBase({
        mode: 'python',
        lineNumbers: false,
        readOnly: 'nocursor',
        viewportMargin: Infinity
      }));
      // Высота по содержимому: короткое решение не должно оставлять пустоту.
      state.compareEditor.setSize(null, 'auto');
    };

    Net.get('/api/solution/python/' + encodeURIComponent(task.id) +
            '?name=' + encodeURIComponent(state.name))
      .then(function (data) {
        if (data.found && data.code) return show(data.code, 'твоё решение с прошлого занятия');
        return fallbackCompare(task);
      }, function () { return fallbackCompare(task); });

    function fallbackCompare(t) {
      // Ребёнок пропустил занятие или не дошёл до темы — показываем эталон.
      return loadContent('python', state.topic).then(function (py) {
        var same = py.tasks.filter(function (x) { return x.id === t.id; })[0];
        show(same ? same.solution : '', 'пример: у тебя этой задачи на Python нет');
      }, function () {
        show('', 'решение на Python недоступно');
      });
    }
  }

  function renderHints() {
    var task = currentTask();
    var box = el('hints');
    box.innerHTML = '';
    var taken = hintsTaken(task.id);
    var total = (task.hints || []).length;

    for (var i = 0; i < taken && i < total; i++) {
      var d = document.createElement('div');
      d.className = 'hint';
      d.innerHTML = '<span class="hint-num">' + (i + 1) + '</span><span>' + inlineCode(task.hints[i]) + '</span>';
      box.appendChild(d);
    }

    var btn = el('hint-btn');
    btn.disabled = taken >= total;
    btn.textContent = taken >= total ? 'Подсказок больше нет' : 'Подсказка';
    el('hint-cost').textContent = taken > 0
      ? 'взято ' + taken + ' из ' + total
      : total + ' ' + plural(total, 'подсказка', 'подсказки', 'подсказок') + ', каждая стоит балл';
  }

  // Часть задач требует вызвать собственную функцию, а не написать всё заново.
  // Проверяется по исходнику: это единственное требование, которое тестами
  // по результату не поймать.
  function callsOwn(code, task) {
    var need = task.must_call || [];
    if (!need.length) return null;
    var missing = need.filter(function (fn) {
      // Объявление функции тоже даёт совпадение, поэтому вызов — это второе.
      var declared = code.indexOf('def ' + fn + '(') !== -1 ||
                     new RegExp('\b' + fn + '\s*\([^)]*\)\s*(\{|$)', 'm').test(code);
      var hits = code.split(fn + '(').length - 1;
      return hits < (declared ? 2 : 1);
    });
    return { need: need, missing: missing, pass: missing.length === 0 };
  }

  // Значения показываются так, как их пишут в этом языке: в C# урок про
  // true и false, а не про True и False.
  function repr(value) {
    if (state.lang !== 'csharp') return Runner.pyRepr(value);
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return '"' + value.replace(/"/g, '\\"') + '"';
    if (Array.isArray(value)) return '[' + value.map(repr).join(', ') + ']';
    if (typeof value === 'object') {
      return '{' + Object.keys(value).map(function (k) {
        return '"' + k + '": ' + repr(value[k]);
      }).join(', ') + '}';
    }
    return String(value);
  }

  function testCallText(task, tc) {
    var args = tc.args.map(repr).join(', ');
    return esc(task.entry) + '(' + esc(args) + ')' +
      '<span class="arrow">&rarr;</span>' +
      '<span class="want">' + esc(repr(tc.expect)) + '</span>';
  }

  // results === null — состояние до запуска
  function renderTests(results) {
    var task = currentTask();
    var host = el('tests');
    host.innerHTML = '';

    task.tests.forEach(function (tc, i) {
      var row = document.createElement('div');
      row.className = 'test';
      row.dataset.state = 'idle';

      var mark = document.createElement('div');
      mark.className = 'test-mark';
      mark.textContent = '·';

      var body = document.createElement('div');
      body.className = 'test-body';

      if (!tc.hidden || (results && results[i])) {
        body.innerHTML = '<div class="test-call">' + testCallText(task, tc) + '</div>';
      } else {
        body.innerHTML = '<div class="test-hidden">Скрытый тест. Откроется после проверки — в нём граничный случай.</div>';
      }

      row.appendChild(mark);
      row.appendChild(body);
      host.appendChild(row);
    });

    if (task.must_call && task.must_call.length) {
      var row = document.createElement('div');
      row.className = 'test test-req';
      row.dataset.state = 'idle';
      row.innerHTML = '<div class="test-mark">·</div><div class="test-body">' +
        '<div class="test-call">вызывает ' +
        task.must_call.map(function (f) { return esc(f) + '(...)'; }).join(', ') +
        '</div></div>';
      host.appendChild(row);
    }

    el('tests-score').innerHTML = task.tests.length + ' ' +
      plural(task.tests.length, 'тест', 'теста', 'тестов');
  }

  // ---------- проверка ----------

  function check() {
    if (state.running) return;
    state.running = true;

    var task = currentTask();
    var code = state.editor.getValue();
    var btn = el('check-btn');
    btn.disabled = true;
    btn.textContent = 'Проверяю';

    clearVerdict();
    el('latch').classList.remove('is-on');
    el('tests-panel').classList.remove('is-solved');
    el('stdout-panel').hidden = true;
    el('build-time').hidden = true;
    renderTests(null);
    bringIntoView(el('tests-panel'), 'end');

    var own = callsOwn(code, task);
    if (state.lang === 'csharp') btn.textContent = 'Компилирую';

    runTests(code, task).then(function (out) {
      if (out.compile) {
        showCompileErrors(out.compile);
        reportProgress(task, false);
        return null;
      }
      var results = out.results;
      if (out.fatal) results.fatal = out.fatal;
      return reveal(task, results, headlineError(task, results))
        .then(function () { return revealRequirement(task, own); })
        .then(function () { return finish(task, results, out.printed, own, out.buildSec); });
    }).then(function () {
      state.running = false;
      btn.disabled = false;
      btn.textContent = 'Проверить';
    });
  }

  // Одна ошибка на все тесты показывается только сверху, в разборе:
  // повторять её в каждой красной строке — шум.
  function headlineError(task, results) {
    if (results.fatal) return results.fatal;
    for (var i = 0; i < task.tests.length; i++) {
      if (results[i] && !results[i].pass) return results[i].error || null;
    }
    return null;
  }

  // Тесты загораются по одному — так заметно приятнее, чем показать разом.
  function reveal(task, results, headline) {
    var rows = el('tests').children;
    var chain = Promise.resolve();

    task.tests.forEach(function (tc, i) {
      chain = chain.then(function () {
        var row = rows[i];
        var r = results[i];

        if (!r) {
          row.dataset.state = 'skip';
          return;
        }

        row.classList.add('is-revealed');
        row.dataset.state = r.pass ? 'pass' : 'fail';
        row.querySelector('.test-mark').textContent = r.pass ? '✓' : '✕';

        var body = row.querySelector('.test-body');
        body.innerHTML = '<div class="test-call">' + testCallText(task, tc) + '</div>';

        if (!r.pass) {
          var same = r.error && headline && errorPlain(r.error) === errorPlain(headline);
          if (!same) {
            var line = document.createElement('div');
            line.className = 'test-got';
            line.textContent = r.error ? errorPlain(r.error) : 'получилось ' + repr(r.got);
            body.appendChild(line);
          }
        }
        return sleep(REVEAL_MS);
      });
    });

    return chain;
  }

  function revealRequirement(task, own) {
    if (!own) return Promise.resolve();
    var rows = el('tests').children;
    var row = rows[task.tests.length];
    if (!row) return Promise.resolve();
    row.classList.add('is-revealed');
    row.dataset.state = own.pass ? 'pass' : 'fail';
    row.querySelector('.test-mark').textContent = own.pass ? '✓' : '✕';
    if (!own.pass) {
      var note = document.createElement('div');
      note.className = 'test-got';
      note.textContent = 'в теле ' + task.entry + ' нет вызова ' +
        own.missing.join(', ') + ' — эта задача про то, чтобы переиспользовать свою функцию';
      row.querySelector('.test-body').appendChild(note);
    }
    return sleep(REVEAL_MS);
  }

  // Компилятор отказался собирать программу. Показываем его сообщения
  // с номерами строк в коде ребёнка, а не в сгенерированной обёртке.
  function showCompileErrors(errors) {
    var v = el('verdict');
    v.innerHTML = errors.slice(0, 4).map(function (e) {
      var head = e.line ? 'Строка ' + e.line + ':' : 'Компилятор:';
      var code = e.code ? ' <span class="cs-code">' + esc(e.code) + '</span>' : '';
      var body = e.hint ? esc(e.hint) : esc(e.message);
      var raw = e.hint && e.message ? '<div class="cs-raw">' + esc(e.message) + '</div>' : '';
      return '<div class="cs-error"><span class="verdict-line">' + esc(head) + '</span>' +
        body + code + raw + '</div>';
    }).join('');

    var rows = el('tests').children;
    for (var i = 0; i < rows.length; i++) rows[i].dataset.state = 'skip';
  }

  function finish(task, results, printed, own, buildSec) {
    var passed = 0;
    for (var i = 0; i < task.tests.length; i++) if (results[i] && results[i].pass) passed++;
    if (own && !own.pass) {
      reportProgress(task, false);
      var v = el('verdict');
      v.innerHTML = 'Тесты сошлись, но задача не решена: в теле <code>' + esc(task.entry) +
        '</code> нет вызова <code>' + esc(own.missing.join(', ')) +
        '</code>. Смысл задачи — переиспользовать свою функцию, а не написать всё заново.';
      return Promise.resolve();
    }

    if (printed) {
      el('stdout-panel').hidden = false;
      el('stdout').textContent = printed.length > 4000 ? printed.slice(0, 4000) + '\n…' : printed;
    }

    if (buildSec !== undefined && buildSec !== null) {
      el('build-time').textContent = 'сборка ' + buildSec + ' с';
      el('build-time').hidden = false;
    }

    if (passed === task.tests.length) {
      var wasSolved = isSolved(task.id);
      markSolved(task.id);
      reportProgress(task, true);
      return solvedScene(task, wasSolved);
    }

    reportProgress(task, false);
    showVerdict(task, results, passed);
    return Promise.resolve();
  }

  // Момент сдачи: развёртка проходит по панели, рамка защёлкивается,
  // наверху загорается новая насечка курса. Одна собранная секунда.
  function solvedScene(task, wasSolved) {
    var scan = el('scan');
    scan.classList.remove('is-running');
    void scan.offsetWidth; // перезапуск анимации
    scan.classList.add('is-running');

    return sleep(SCAN_MS).then(function () {
      scan.classList.remove('is-running');
      el('tests-panel').classList.add('is-solved');
      showLatch(task, false);

      if (!wasSolved) {
        renderRail();
        latchNotch();
      }

      var next = nextUnsolvedIndex();
      renderTaskNav(next);
      bringIntoView(el('latch'), 'start');
      return sleep(120);
    });
  }

  function showLatch(task, quiet) {
    var latch = el('latch');
    var taken = hintsTaken(task.id);
    var next = nextUnsolvedIndex();

    var parts = [task.tests.length + ' ' + plural(task.tests.length, 'тест сошёлся', 'теста сошлись', 'тестов сошлись')];
    if (taken > 0) parts.push('подсказок взято: ' + taken);
    el('latch-sub').textContent = parts.join(' · ');

    var btn = el('latch-next');
    if (next >= 0) {
      btn.hidden = false;
      btn.textContent = 'Задача ' + (next + 1);
      btn.onclick = function () { goToTask(next); };
    } else {
      btn.hidden = false;
      btn.textContent = 'Тема закрыта';
      btn.disabled = true;
      btn.onclick = null;
    }

    if (quiet) {
      latch.style.animation = 'none';
      latch.classList.add('is-on');
      void latch.offsetWidth;
      latch.style.animation = '';
    } else {
      latch.classList.add('is-on');
    }
  }

  function showVerdict(task, results, passed) {
    var v = el('verdict');
    var err = headlineError(task, results);
    if (err) {
      var parts = errorLine(err);
      v.innerHTML = (parts.head ? '<span class="verdict-line">' + esc(parts.head) + '</span>' : '') +
        inlineCode(parts.body);
      return;
    }

    v.textContent = 'Сошлось ' + passed + ' из ' + task.tests.length +
      '. Открой первый красный тест — там видно, что вернул твой код.';
  }

  // ---------- запуск страницы ----------

  function wire() {
    el('check-btn').addEventListener('click', check);

    el('reset-btn').addEventListener('click', function () {
      state.editor.setValue(currentTask().starter);
      state.editor.focus();
    });

    el('hint-btn').addEventListener('click', function () {
      var task = currentTask();
      var taken = hintsTaken(task.id);
      if (taken >= (task.hints || []).length) return;
      takeHint(task.id, taken + 1);
      renderHints();
    });
  }

  function boot() {
    var q = new URLSearchParams(location.search);
    state.lang = q.get('lang') === 'csharp' ? 'csharp' : 'python';
    state.topic = q.get('topic') || 'conditions';
    state.name = Net.name();

    if (!state.name) {
      location.replace('/');
      return;
    }

    Net.mountStatus(el('rail-status'));
    Net.flush();

    // Список тем нужен для перехода между темами. Без сервера остаётся
    // текущая тема — решать это не мешает.
    var topics = Net.get('/api/topics/' + state.lang).then(
      function (d) { return d.topics; },
      function () { return null; }
    );

    Promise.all([loadContent(state.lang, state.topic), topics]).then(function (both) {
      var data = both[0];
      state.topics = both[1];
      state.data = data;

      // Открываем на первой нерешённой задаче темы.
      var first = nextUnsolvedIndex();
      state.taskIndex = first < 0 ? 0 : first;

      el('who').hidden = false;
      el('who').textContent = state.name;

      el('boot').hidden = true;
      el('page').hidden = false;

      renderRail();
      renderTheory();
      renderTaskNav();
      renderTask();
      wire();
    }).catch(function (e) {
      var b = el('boot');
      b.className = 'boot is-fatal';
      b.textContent = 'Тема не загрузилась: ' + e.message;
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
