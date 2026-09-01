// Связь с сервером. Сервер нужен только для общей таблицы: проверка задач
// идёт в браузере. Поэтому упавший сервер не мешает решать — отправки
// складываются в очередь и уходят, когда он вернётся.

(function (global) {
  'use strict';

  var QUEUE_KEY = 'terminal:queue';
  var NAME_KEY = 'terminal:name';
  var QUEUE_MAX = 200;

  var online = null;      // null — ещё не знаем
  var listeners = [];

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { /* приватный режим */ }
  }

  function setOnline(next) {
    if (online === next) return;
    online = next;
    listeners.forEach(function (fn) { fn(next); });
  }

  function name() {
    try { return localStorage.getItem(NAME_KEY) || ''; }
    catch (e) { return ''; }
  }

  function setName(value) {
    try { localStorage.setItem(NAME_KEY, value); }
    catch (e) { /* приватный режим */ }
  }

  function request(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      if (!r.ok) {
        // Сервер ответил и отказал — это не потеря связи, повторять смысла нет.
        setOnline(true);
        return r.json().catch(function () { return {}; }).then(function (data) {
          var err = new Error(data.detail || ('Сервер ответил ' + r.status));
          err.rejected = true;
          // Вход протух — страница должна попросить пароль заново,
          // а не висеть на проекторе с последними данными.
          err.unauthorized = (r.status === 401);
          throw err;
        });
      }
      setOnline(true);
      return r.json();
    }, function (e) {
      setOnline(false);
      e.offline = true;
      throw e;
    });
  }

  function get(path) { return request('GET', path); }

  // Запуск кода в очередь не ставится: ответ нужен здесь и сейчас,
  // а отложенная компиляция никому не нужна. Отказ сервера доходит как есть.
  function send(path, body) { return request('POST', path, body); }

  // Отправка «в фоне»: не решённая задача ждёт в очереди, а не теряется.
  function push(path, body) {
    return request('POST', path, body).then(function (res) {
      flush();
      return res;
    }, function (e) {
      if (e.offline) enqueue(path, body);
      return null;
    });
  }

  function enqueue(path, body) {
    var q = read(QUEUE_KEY, []);
    // Повторная отправка того же по смыслу события не нужна: сервер и так
    // принимает последнее состояние задачи.
    q = q.filter(function (item) {
      return !(item.path === path && item.body && body &&
               item.body.task_id === body.task_id && item.body.lang === body.lang);
    });
    q.push({ path: path, body: body });
    if (q.length > QUEUE_MAX) q = q.slice(-QUEUE_MAX);
    write(QUEUE_KEY, q);
  }

  var flushing = false;

  function flush() {
    if (flushing) return Promise.resolve();
    var q = read(QUEUE_KEY, []);
    if (!q.length) return Promise.resolve();
    flushing = true;

    var chain = Promise.resolve();
    var sent = 0;
    q.forEach(function (item) {
      chain = chain.then(function (stop) {
        if (stop) return true;
        return request('POST', item.path, item.body).then(
          function () { sent++; return false; },
          function (e) { return !!e.offline; }   // связи снова нет — остальное ждёт
        );
      });
    });

    return chain.then(function () {
      write(QUEUE_KEY, read(QUEUE_KEY, []).slice(sent));
      flushing = false;
    });
  }

  function pending() { return read(QUEUE_KEY, []).length; }

  function onStatus(fn) {
    listeners.push(fn);
    if (online !== null) fn(online);
  }

  // Плашка о том, что таблица недоступна. Текст говорит ребёнку главное:
  // работа не потеряна.
  function mountStatus(host) {
    var badge = document.createElement('div');
    badge.className = 'offline';
    badge.hidden = true;
    badge.innerHTML = '<span class="offline-dot"></span>' +
      '<span>Таблица недоступна — решения сохраняются локально</span>';
    host.appendChild(badge);
    onStatus(function (ok) { badge.hidden = !!ok; });
    return badge;
  }

  global.Net = {
    name: name,
    setName: setName,
    get: get,
    send: send,
    push: push,
    flush: flush,
    pending: pending,
    onStatus: onStatus,
    mountStatus: mountStatus
  };
})(window);
