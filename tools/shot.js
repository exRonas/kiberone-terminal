// Снимок страницы через headless Chrome по CDP. Без зависимостей: Node 22
// умеет WebSocket сам. Нужен, потому что вёрстку автотестами тут не проверить.
//
//   node tools/shot.js <url> <файл.png> [ширина] [высота] [js-перед-снимком]

var http = require('http');
var fs = require('fs');
var cp = require('child_process');

var url = process.argv[2];
var out = process.argv[3];
var W = parseInt(process.argv[4] || '1366', 10);
var H = parseInt(process.argv[5] || '768', 10);
var before = process.argv[6] || '';
// Седьмой аргумент выполняется на странице входа, до перехода на целевую:
// там место для подготовки localStorage и для входа тьютора. Внутри before
// логиниться нельзя — login.js перезагружает страницу, и контекст со всеми
// таймерами умирает вместе со снимком.
var pre = process.argv[7] || '';

var CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
var PORT = 9333;

var chrome = cp.spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--window-size=' + W + ',' + H,
  '--hide-scrollbars',
  '--no-first-run',
  '--user-data-dir=' + require('os').tmpdir() + '\\shotprofile',
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
    send('Page.enable')
      // Страница темы без имени в localStorage уводит на вход — имя ставим заранее.
      .then(function () { return send('Page.navigate', { url: new URL(url).origin + '/' }); })
      .then(function () { return new Promise(function (r) { setTimeout(r, 1200); }); })
      .then(function () {
        return send('Runtime.evaluate', {
          expression: "Promise.resolve((function(){localStorage.setItem('terminal:name','Проверка');" +
                      pre + "})())",
          awaitPromise: true
        });
      })
      .then(function () { return send('Page.navigate', { url: url }); })
      .then(function () { return new Promise(function (r) { setTimeout(r, 1800); }); })
      .then(function () {
        if (!before) return null;
        return send('Runtime.evaluate', { expression: before, awaitPromise: true });
      })
      .then(function () { return new Promise(function (r) { setTimeout(r, before ? 1500 : 200); }); })
      .then(function () { return send('Page.captureScreenshot', { format: 'png' }); })
      .then(function (res) {
        fs.writeFileSync(out, Buffer.from(res.data, 'base64'));
        console.log('снято: ' + out);
        ws.close();
        chrome.kill();
        process.exit(0);
      });
  };
});
