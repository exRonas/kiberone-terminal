// Выполняет выражение на живой странице и печатает результат. Нужен, чтобы
// проверять поведение в настоящем браузере, а не по чтению исходников.
//
//   node tools/probe.js <url> "<js-выражение>"
//
// Выражение может вернуть промис — дождёмся.

var http = require('http');
var cp = require('child_process');

var url = process.argv[2];
var expr = process.argv[3];
// Необязательный третий аргумент выполняется на странице входа, до перехода
// на целевую: там место для подготовки localStorage. Внутри самого
// выражения перезагружать страницу нельзя — контекст выполнения умрёт
// вместе с ответом.
var pre = process.argv[4] || '';

var CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
var PORT = 9334;

var chrome = cp.spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--no-first-run',
  '--user-data-dir=' + require('os').tmpdir() + '\\probeprofile',
  'about:blank'
], { stdio: 'ignore' });

function targets(cb, tries) {
  tries = tries || 0;
  http.get('http://127.0.0.1:' + PORT + '/json/list', function (res) {
    var b = '';
    res.on('data', function (d) { b += d; });
    res.on('end', function () { cb(JSON.parse(b)); });
  }).on('error', function (e) {
    if (tries > 60) throw e;
    setTimeout(function () { targets(cb, tries + 1); }, 250);
  });
}

targets(function (list) {
  var page = list.filter(function (t) { return t.type === 'page'; })[0];
  var ws = new WebSocket(page.webSocketDebuggerUrl);
  var id = 0;
  var waiting = {};

  function send(method, params) {
    return new Promise(function (resolve) {
      var n = ++id;
      waiting[n] = resolve;
      ws.send(JSON.stringify({ id: n, method: method, params: params || {} }));
    });
  }

  ws.onmessage = function (ev) {
    var msg = JSON.parse(ev.data);
    if (msg.id && waiting[msg.id]) { waiting[msg.id](msg.result); delete waiting[msg.id]; }
  };

  ws.onopen = function () {
    send('Runtime.enable')
      .then(function () { return send('Page.enable'); })
      // Страница темы без имени в localStorage уводит на вход — имя ставим заранее.
      .then(function () { return send('Page.navigate', { url: new URL(url).origin + '/' }); })
      .then(function () { return new Promise(function (r) { setTimeout(r, 1200); }); })
      .then(function () {
        return send('Runtime.evaluate', {
          // pre может вернуть промис (например, вход тьютора) — дожидаемся.
          expression: "Promise.resolve((function(){localStorage.setItem('terminal:name','Проверка');" +
                      pre + "})())",
          awaitPromise: true
        });
      })
      .then(function () { return send('Page.navigate', { url: url }); })
      .then(function () { return new Promise(function (r) { setTimeout(r, 2500); }); })
      .then(function () {
        return send('Runtime.evaluate', {
          expression: 'Promise.resolve((function(){' + expr + '})()).then(function(v){return JSON.stringify(v,null,1);},function(e){return "ОШИБКА: "+(e&&e.stack||e);})',
          awaitPromise: true,
          returnByValue: true
        });
      })
      .then(function (res) {
        if (res.exceptionDetails) console.log('ИСКЛЮЧЕНИЕ:', JSON.stringify(res.exceptionDetails.exception));
        console.log(res.result && res.result.value);
        ws.close();
        chrome.kill();
        process.exit(0);
      });
  };
});
