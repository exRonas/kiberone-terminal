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
    setPostponed(id, false);   // решена — значит, откладывать больше нечего
  }

  // Отложенная задача. Хранится рядом с решёнными, но это разные вещи:
  // отложенная не засчитывается и никуда не пропадает.
  function isPostponed(id) { return readStore('postponed')[id] === true; }

  function setPostponed(id, on) {
    var p = readStore('postponed');
    if (on) p[id] = true;
    else delete p[id];
    writeStore('postponed', p);
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

  function postponedInTopic(topic) {
    var p = readStore('postponed');
    var s = readStore('solved');
    return Object.keys(p).filter(function (id) {
      return p[id] === true && s[id] !== true && id.indexOf(topic + '-') === 0;
    }).length;
  }

  // Тема разобрана, когда с каждой задачей что-то сделали: решили или
  // сознательно отложили. Отложенные не идут в прогресс, но и не держат
  // ребёнка в теме — трудная задача не должна останавливать занятие.
  function handledInTopic(topic) {
    return Math.min(solvedInTopic(topic) + postponedInTopic(topic), TASKS_PER_TOPIC);
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

  // ---------- пошаговое выполнение примера ----------

  // Панель шагов: пульт, строка состояния и «коробки» с переменными.
  // Собирается сразу, но живёт скрытой, пока не нажали «По шагам».
  function makeStepperDom() {
    var node = document.createElement('div');
    node.className = 'stepper';
    node.hidden = true;

    var bar = document.createElement('div');
    bar.className = 'stepper-bar';

    function button(text, cls) {
      var b = document.createElement('button');
      b.className = 'btn btn-sm' + (cls ? ' ' + cls : '');
      b.type = 'button';
      b.textContent = text;
      bar.appendChild(b);
      return b;
    }

    var refs = {
      node: node,
      // Жёлтой на этой панели остаётся только строка кода: она показывает,
      // где программа стоит. Вторая жёлтая кнопка спорила бы с «Проверить».
      next: button('Шаг', 'btn-step'),
      all: button('До конца'),
      again: button('Сначала'),
      leave: button('Выйти')
    };

    var where = document.createElement('span');
    where.className = 'stepper-where';
    bar.appendChild(where);
    refs.where = where;

    var vars = document.createElement('div');
    vars.className = 'stepper-vars';
    refs.vars = vars;

    node.appendChild(bar);
    node.appendChild(vars);
    return refs;
  }

  // Одна пометка на строке кода: где программа стоит прямо сейчас.
  function markLine(cm, line) {
    if (cm.$stepLine !== undefined && cm.$stepLine !== null) {
      cm.removeLineClass(cm.$stepLine, 'background', 'cm-step');
      cm.removeLineClass(cm.$stepLine, 'gutter', 'cm-step-gutter');
    }
    cm.$stepLine = null;
    if (typeof line !== 'number' || line < 1 || line > cm.lineCount()) return;
    cm.$stepLine = line - 1;
    cm.addLineClass(cm.$stepLine, 'background', 'cm-step');
    cm.addLineClass(cm.$stepLine, 'gutter', 'cm-step-gutter');
    cm.scrollIntoView({ line: cm.$stepLine, ch: 0 }, 40);
  }

  // before — что лежало в коробках на прошлом шаге. Изменившаяся коробка
  // подсвечивается: это и есть ответ на вопрос «что сделала эта строка».
  // На первом шаге сравнивать не с чем, и не подсвечивается ничего.
  function renderVars(host, vars, before) {
    if (!vars.length) {
      host.innerHTML = '<span class="stepper-empty">Коробок пока нет — ни одной переменной не создано.</span>';
      return;
    }
    host.innerHTML = vars.map(function (v) {
      var fresh = before && before[v.name] !== v.value;
      return '<span class="box' + (fresh ? ' is-fresh' : '') + '">' +
        '<span class="box-name">' + esc(v.name) + '</span>' +
        '<span class="box-value">' + esc(v.value) + '</span>' +
        '</span>';
    }).join('');
  }

  function varsMap(vars) {
    var map = {};
    vars.forEach(function (v) { map[v.name] = v.value; });
    return map;
  }

  function wireStepper(refs, stepBtn, runBtn, cm, out) {
    var session = null;   // {ctl, resume} — пока не null, программа стоит на строке
    var before = null;    // значения коробок на прошлом шаге

    function setOut(text, bad) {
      out.className = 'example-out' + (bad ? ' is-error' : '');
      out.textContent = text;
    }

    function enter() {
      refs.node.hidden = false;
      stepBtn.disabled = true;
      runBtn.disabled = true;
      // Правка кода посреди трассы рассинхронизировала бы подсветку строк.
      cm.setOption('readOnly', 'nocursor');
      cm.getWrapperElement().classList.add('is-stepping');
    }

    function leave() {
      if (session && session.ctl) {
        session.ctl.cancel();
        if (session.resume) session.resume();
      }
      session = null;
      refs.node.hidden = true;
      stepBtn.disabled = false;
      runBtn.disabled = false;
      cm.setOption('readOnly', false);
      cm.getWrapperElement().classList.remove('is-stepping');
      markLine(cm, null);
    }

    function waiting(on) {
      refs.next.disabled = !on;
      refs.all.disabled = !on;
    }

    function start() {
      enter();
      setOut('');
      before = null;
      refs.where.textContent = 'программа запускается';
      renderVars(refs.vars, [], null);
      waiting(false);

      // Первая остановка приходит синхронно, ещё до возврата из stepSnippet,
      // поэтому запись о трассе заводим заранее. Сравнение с mine отсекает
      // хвост прошлой трассы, если нажали «Сначала».
      var mine = { ctl: null, resume: null };
      session = mine;

      mine.ctl = Runner.stepSnippet(cm.getValue(), function (info, resume) {
        if (session !== mine) return resume();
        mine.resume = resume;
        markLine(cm, info.line);
        refs.where.textContent = info.line
          ? 'сейчас выполнится строка ' + info.line
          : 'шаг ' + info.step;
        renderVars(refs.vars, info.vars, before);
        before = varsMap(info.vars);
        setOut(info.output, false);
        waiting(true);
        // Фокус остаётся на «Шаге»: дальше можно идти с клавиатуры,
        // не целясь мышью в маленькую кнопку двадцать раз подряд.
        refs.next.focus({ preventScroll: true });
      });

      mine.ctl.finished.then(function (res) {
        if (session !== mine || res.cancelled) return;   // вышли сами или начали заново
        mine.resume = null;
        waiting(false);
        markLine(cm, null);
        // Шагать больше некуда — уводим фокус на «Сначала», чтобы тот,
        // кто идёт с клавиатуры, не остался ни на чём.
        if (refs.node.contains(document.activeElement)) {
          refs.again.focus({ preventScroll: true });
        }
        if (res.ok) {
          refs.where.textContent = 'программа закончилась';
          setOut(res.output || 'Программа ничего не напечатала.', false);
        } else {
          refs.where.textContent = res.tooLong ? 'слишком много шагов' : 'программа остановилась на ошибке';
          setOut((res.output ? res.output + '\n' : '') + errorPlain(res.error), true);
        }
      });
    }

    stepBtn.addEventListener('click', start);

    refs.next.addEventListener('click', function () {
      if (!session || !session.resume) return;
      var resume = session.resume;
      // Кнопку не гасим: она снова понадобится через миг, а гашение
      // срывает с неё фокус, и шагать с клавиатуры становится нельзя.
      // От повторного нажатия защищает обнулённый resume.
      session.resume = null;
      resume();
    });

    refs.all.addEventListener('click', function () {
      if (!session || !session.resume) return;
      var resume = session.resume;
      session.resume = null;
      waiting(false);
      refs.where.textContent = 'досчитываю…';
      session.ctl.fast();
      resume();
    });

    refs.again.addEventListener('click', function () {
      leave();
      start();
    });

    refs.leave.addEventListener('click', leave);
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
    bar.appendChild(runBtn);

    // По шагам умеет только Python: он выполняется здесь же, в браузере.
    // C# компилируется на сервере и приходит уже посчитанным целиком.
    // В теме C# рядом всегда стоит тот же пример на Python — шаги живут там.
    var stepBtn = null;
    if (lang !== 'csharp') {
      stepBtn = document.createElement('button');
      stepBtn.className = 'btn btn-sm';
      stepBtn.type = 'button';
      stepBtn.textContent = 'По шагам';
      stepBtn.title = 'Выполнить по одной строке и смотреть, что меняется';
      bar.appendChild(stepBtn);
    }

    var note = document.createElement('span');
    note.className = 'bar-note';
    note.textContent = lang === 'csharp' ? 'считает сервер' : 'код можно менять';
    bar.appendChild(note);

    var out = document.createElement('pre');
    out.className = 'example-out';

    var stepper = stepBtn ? makeStepperDom() : null;

    example.appendChild(bar);
    if (stepper) example.appendChild(stepper.node);
    example.appendChild(out);
    host.appendChild(example);

    var cm = CodeMirror.fromTextArea(ta, cmBase({
      // В пошаговом режиме номера строк — единственный способ сказать
      // «сейчас выполняется вот эта». В примере C# они нужны не меньше:
      // ошибка компилятора приходит с номером строки.
      lineNumbers: true,
      viewportMargin: Infinity,
      mode: lang === 'csharp' ? 'text/x-csharp' : 'python'
    }));
    cm.setValue(code);

    if (stepper) wireStepper(stepper, stepBtn, runBtn, cm, out);

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

    return chain.then(function () {
      results.printHint = printInsteadOfReturn(task, results, printed);
      return { results: results, printed: printed };
    });
  }

  // Самая частая путаница первого занятия: ребёнок печатает ответ вместо
  // того, чтобы его вернуть. Внизу при этом стоит правильный текст, а все
  // тесты красные с «получилось None» — без объяснения это выглядит
  // издевательством. Ловим случай, когда все упавшие тесты вернули None,
  // а на экран при этом что-то напечатано.
  //
  // В C# такой ловушки нет: там компилятор сам скажет, что функция обязана
  // вернуть значение.
  function printInsteadOfReturn(task, results, printed) {
    if (!printed) return null;

    var failed = 0;
    for (var i = 0; i < task.tests.length; i++) {
      var r = results[i];
      if (!r || r.pass) continue;
      if (r.error) return null;                                  // упало по другой причине
      if (r.got !== null && r.got !== undefined) return null;    // вернуло что-то, просто не то
      failed++;
    }
    if (!failed) return null;

    return {
      line: null,
      text: 'функция напечатала правильный текст, но не вернула его. ' +
            'Проверка смотрит, что функция отдала в ответ через `return`, а `print` только показывает текст на экране ' +
            'и наружу не отдаёт ничего. Замени `print(...)` на `return ...`.'
    };
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

    // Темы идут по порядку: открыта каждая до первой неразобранной
    // включительно. Вернуться к пройденной можно всегда.
    //
    // Граница считается по разобранным, а не по решённым: три отложенные
    // задачи открывают следующую тему так же, как три решённые. Насечки
    // при этом честные — они показывают только решённое.
    var counts = TOPIC_ORDER.map(function (t) { return Math.min(solvedInTopic(t), TASKS_PER_TOPIC); });
    var handled = TOPIC_ORDER.map(handledInTopic);
    var frontier = counts.length - 1;
    for (var k = 0; k < handled.length; k++) {
      if (handled[k] < TASKS_PER_TOPIC) { frontier = k; break; }
    }

    TOPIC_ORDER.forEach(function (t, idx) {
      var done = counts[idx];
      var later = postponedInTopic(t);
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
      var count = done + ' из ' + TASKS_PER_TOPIC + (later ? ', отложено ' + later : '');
      seg.title = !ready
        ? title + ' — тема ещё не готова'
        : (open ? title + ' — ' + count
                : title + ' — откроется, когда разберёшься с предыдущей');

      // Насечки идут тремя состояниями: решено, отложено, ещё не тронуто.
      // Отложенное видно по всему курсу — ребёнок знает, куда вернуться.
      for (var i = 0; i < TASKS_PER_TOPIC; i++) {
        var n = document.createElement('div');
        n.className = 'notch' + (i < done ? ' is-done' : (i < done + later ? ' is-later' : ''));
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

  // Следующая готовая тема курса. Без списка тем (сервер молчит) не зовём
  // никуда: перейти всё равно не выйдет, содержимое темы берётся с сервера.
  function nextTopicAfter(topic) {
    if (!state.topics) return null;
    for (var i = TOPIC_ORDER.indexOf(topic) + 1; i < TOPIC_ORDER.length; i++) {
      var info = topicInfo(TOPIC_ORDER[i]);
      if (info && info.ready) return TOPIC_ORDER[i];
    }
    return null;
  }

  function goToTopic(topic) {
    location.href = '/topic?lang=' + state.lang + '&topic=' + topic;
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

  // Следующая задача, за которую стоит взяться. Отложенные уходят в конец
  // очереди, но не теряются: когда свободных больше нет, сюда возвращается
  // именно отложенная — на неё и укажет кнопка после сдачи.
  function nextUnsolvedIndex() {
    var later = -1;
    for (var i = 0; i < state.data.tasks.length; i++) {
      var id = state.data.tasks[i].id;
      if (isSolved(id)) continue;
      if (isPostponed(id)) {
        if (later < 0) later = i;
        continue;
      }
      return i;
    }
    return later;
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
      var mark = isSolved(task.id) ? ' is-done' : (isPostponed(task.id) ? ' is-later' : '');
      b.innerHTML = '<span class="pip' + mark + '"></span>' + (i + 1);
      b.title = task.title + (mark === ' is-later' ? ' — отложена' : '');
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

    // Правило проверки стоит у каждой задачи постоянно, а не всплывает
    // после ошибки: «напечатал вместо вернул» — самая частая путаница,
    // и узнавать о ней из четырёх красных тестов незачем.
    el('task-rule').innerHTML = inlineCode(
      state.lang === 'csharp'
        ? 'Как засчитывается: проверка вызывает функцию и смотрит, что она вернула через `return`. Напечатанное через `Console.WriteLine` в ответ не идёт.'
        : 'Как засчитывается: проверка вызывает функцию и смотрит, что она вернула через `return`. Напечатанное через `print` в ответ не идёт.'
    );

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
    renderLater();
    reportActivity();
    renderCompare(task);

    // Уже решённую задачу открываем со штампом — прогресс никуда не делся.
    if (isSolved(task.id)) showLatch(task, true);
  }

  // Задачу можно отложить и вернуться к ней позже: слишком трудная задача
  // не должна останавливать всё занятие.
  function renderLater() {
    var task = currentTask();
    var btn = el('later-btn');
    var note = el('later-note');

    if (isSolved(task.id)) {
      btn.hidden = true;
      note.hidden = true;
      return;
    }

    var on = isPostponed(task.id);
    btn.hidden = false;
    btn.textContent = on ? 'Вернуть в работу' : 'Отложить';
    note.hidden = !on;
    if (!on) return;

    // Отложив последнюю задачу темы, ребёнок иначе остался бы на экране
    // без единого выхода: сдавать нечего, штампа нет, а следующая тема
    // прячется в мелких сегментах шапки. Говорим прямо.
    var whole = handledInTopic(state.topic) >= TASKS_PER_TOPIC;
    var onward = whole ? nextTopicAfter(state.topic) : null;

    el('later-sub').textContent = whole
      ? 'Со всеми задачами темы ты разобрался. Отложенные ждут здесь — вернёшься, когда захочешь.'
      : 'Она осталась в списке сверху и ждёт. Возьмись за неё, когда будешь готов.';

    var onwardBtn = el('later-next');
    onwardBtn.hidden = !onward;
    onwardBtn.onclick = onward ? function () { goToTopic(onward); } : null;
  }

  function toggleLater() {
    var task = currentTask();

    // Решённую задачу откладывать нечего. Кнопка на ней спрятана, но
    // скрытая кнопка всё равно отвечает на click — проверяем по состоянию.
    if (isSolved(task.id)) return;

    if (isPostponed(task.id)) {
      setPostponed(task.id, false);
      renderLater();
      renderTaskNav();
      renderRail();
      return;
    }

    setPostponed(task.id, true);
    renderTaskNav();
    renderRail();   // насечка становится контурной, следующая тема может открыться

    // Пока в теме осталась неразобранная задача — уводим на неё. Когда
    // разобраны все, остаёмся здесь: отбрасывать ребёнка обратно к первой
    // отложенной незачем, ему уже открыта следующая тема.
    if (handledInTopic(state.topic) < TASKS_PER_TOPIC) {
      var next = nextUnsolvedIndex();
      if (next >= 0 && next !== state.taskIndex) return goToTask(next);
    }
    renderLater();
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
    if (results.printHint) return results.printHint;
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
    btn.hidden = false;
    btn.disabled = false;

    if (next >= 0) {
      btn.textContent = 'Задача ' + (next + 1);
      btn.onclick = function () { goToTask(next); };
    } else {
      // Раньше здесь стояла погасшая кнопка «Тема закрыта» — ребёнок
      // упирался в тупик и искал следующую тему в мелких сегментах шапки.
      var onward = nextTopicAfter(state.topic);
      if (onward) {
        btn.textContent = 'Следующая тема';
        btn.onclick = function () { goToTopic(onward); };
      } else {
        btn.textContent = 'Курс пройден';
        btn.disabled = true;
        btn.onclick = null;
      }
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

    el('later-btn').addEventListener('click', toggleLater);
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
