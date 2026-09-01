// Тёмная и светлая темы. Подключается в <head> и до первой отрисовки
// проставляет выбор на <html>: иначе светлая тема на долю секунды мигнёт
// тёмной, и это видно.
//
// Меняются только CSS-переменные, разметка не знает про темы ничего.

(function (global) {
  'use strict';

  var KEY = 'terminal:theme';
  var DARK = 'dark';
  var LIGHT = 'light';

  function stored() {
    try { return localStorage.getItem(KEY); }
    catch (e) { return null; }   // приватный режим
  }

  // Тёмная — тема по умолчанию: так задуман весь модуль, и в классе
  // проектор с ней читается лучше.
  function current() {
    return stored() === LIGHT ? LIGHT : DARK;
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function set(theme) {
    apply(theme);
    try { localStorage.setItem(KEY, theme); }
    catch (e) { /* без сохранения, но в этой вкладке работает */ }
    buttons.forEach(paint);
  }

  function toggle() {
    set(current() === LIGHT ? DARK : LIGHT);
  }

  var buttons = [];

  function paint(btn) {
    var light = current() === LIGHT;
    // Значок показывает, куда переключишься, а подпись — что сейчас.
    btn.textContent = light ? '☾' : '☀';
    btn.title = light ? 'Включить тёмную тему' : 'Включить светлую тему';
    btn.setAttribute('aria-label', btn.title);
  }

  // Кнопка ставится в переданный узел. Возвращает её же — вдруг понадобится.
  function mount(host) {
    if (!host) return null;
    var btn = document.createElement('button');
    btn.className = 'btn btn-sm theme-btn';
    btn.type = 'button';
    btn.addEventListener('click', toggle);
    buttons.push(btn);
    paint(btn);
    host.appendChild(btn);
    return btn;
  }

  apply(current());

  // Кнопка встаёт сама во все узлы с data-theme-slot — страницам не нужно
  // ничего знать про темы, кроме места под кнопку.
  document.addEventListener('DOMContentLoaded', function () {
    var slots = document.querySelectorAll('[data-theme-slot]');
    for (var i = 0; i < slots.length; i++) mount(slots[i]);
  });

  global.Theme = { current: current, set: set, toggle: toggle, mount: mount };
})(window);
