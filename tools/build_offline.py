# -*- coding: utf-8 -*-
"""Собирает офлайн-версию «Терминала» для флешки.

Зачем. Если в классном Wi-Fi включена изоляция клиентов, дети не увидят
машину тьютора и обычная версия работать не будет. Эта версия не требует
ни сервера, ни сети, ни установки: папку копируют на ноутбук и открывают
файл двойным кликом.

Что внутри. Только Python: он выполняется в самом браузере через Skulpt.
C# сюда положить нельзя — его проверка требует компилятора на каждом
ноутбуке.

Чего нет. Общей таблицы на проекторе: её некому считать без сервера.
Прогресс живёт в браузере того ноутбука, где ребёнок работает.

Скрипт читает исходники репозитория (server/, content/) и НЕ меняет их.
Собранная папка кладётся рядом с репозиторием, в ../terminal-offline/Терминал —
эта папка не входит в git, её всегда можно получить заново. Пересобрать
после правки задач или вёрстки:

    python tools/build_offline.py
"""

import io
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # корень репозитория terminal/
SRC = ROOT
STATIC = os.path.join(SRC, "server", "static")
CONTENT = os.path.join(SRC, "content", "python")
# Собранная папка — не часть репозитория (она регенерируется), поэтому
# кладём её рядом с terminal/, туда же, где она была раньше при ручной сборке.
OUT = os.path.join(os.path.dirname(ROOT), "terminal-offline", "Терминал")

TOPIC_ORDER = [
    "basics", "conditions", "loops-for", "loops-while",
    "lists", "strings", "functions", "dicts",
]

INDEX = "Терминал.html"


def read(path):
    with io.open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def swap(text, old, new, what):
    """Замена, которая падает, если исходник изменился. Молча промахнуться нельзя."""
    if old not in text:
        raise SystemExit(
            "Не найдено в исходнике: {}\n"
            "Видимо, ../terminal изменился. Поправьте собрать.py.".format(what))
    return text.replace(old, new, 1)


# ---------------------------------------------------------------- контент

def build_content():
    """Все восемь тем зашиваются в один JS-файл.

    Причина: браузер запрещает fetch для file://, поэтому подтянуть JSON
    с диска страница не может — данные должны приехать скриптом.
    """
    topics = {}
    order = []
    for topic in TOPIC_ORDER:
        path = os.path.join(CONTENT, topic + ".json")
        if not os.path.exists(path):
            print("  пропускаю {}: файла нет".format(topic))
            continue
        data = json.loads(read(path))
        topics[topic] = data
        order.append({
            "topic": topic,
            "title": data.get("title", topic),
            "subtitle": data.get("subtitle", ""),
            "ready": True,
            "tasks": len(data.get("tasks", [])),
            "task_ids": [t["id"] for t in data.get("tasks", [])],
        })

    payload = {"topics": topics, "index": order}
    return (
        "// Все темы курса, зашитые в файл: браузер не даёт читать JSON\n"
        "// с диска по file://, поэтому данные приезжают скриптом.\n"
        "// Файл собран автоматически — правьте ../terminal/content/python.\n"
        "window.OFFLINE = true;\n"
        "window.OFFLINE_INDEX_PAGE = " + json.dumps(INDEX, ensure_ascii=False) + ";\n"
        "window.OFFLINE_CONTENT = " + json.dumps(payload, ensure_ascii=False, indent=1) + ";\n"
    ), order


# ---------------------------------------------------------------- заглушка сети

NET_STUB = """// Заглушка связи для офлайн-версии.
//
// Сервера нет вообще: прогресс живёт в localStorage этого ноутбука,
// общей таблицы нет. Страница написана так, будто сервер есть, поэтому
// здесь повторён его интерфейс — все отправки просто проваливаются в никуда.

(function (global) {
  'use strict';

  var NAME_KEY = 'terminal:name';

  function name() {
    try { return localStorage.getItem(NAME_KEY) || ''; }
    catch (e) { return ''; }
  }

  function setName(value) {
    try { localStorage.setItem(NAME_KEY, value); }
    catch (e) { /* приватный режим */ }
  }

  // Единственный запрос, который странице реально нужен, — список тем.
  function get(path) {
    if (path.indexOf('/api/topics/') === 0) {
      return Promise.resolve({ lang: 'python', topics: global.OFFLINE_CONTENT.index });
    }
    var err = new Error('Офлайн-версия работает без сервера');
    err.offline = true;
    return Promise.reject(err);
  }

  function push() { return Promise.resolve(null); }

  function send() {
    var err = new Error('Офлайн-версия работает без сервера');
    err.rejected = true;
    return Promise.reject(err);
  }

  function flush() { return Promise.resolve(); }
  function pending() { return 0; }
  function onStatus() { /* нечего сообщать: сервера нет по замыслу */ }
  function mountStatus() { return null; }

  global.Net = {
    name: name, setName: setName, get: get, send: send, push: push,
    flush: flush, pending: pending, onStatus: onStatus, mountStatus: mountStatus
  };
})(window);
"""


# ---------------------------------------------------------------- страницы

def build_app_js():
    """Тот же app.js, но без обращений к серверу."""
    js = read(os.path.join(STATIC, "app.js"))

    js = swap(js, """  function loadContent(lang, topic) {
    var api = '/api/content/' + lang + '/' + topic + '.json';""",
              """  function loadContent(lang, topic) {
    // Офлайн-версия: темы уже лежат в content.js, сеть не нужна.
    if (window.OFFLINE_CONTENT) {
      var found = window.OFFLINE_CONTENT.topics[topic];
      return found
        ? Promise.resolve(found)
        : Promise.reject(new Error('темы «' + topic + '» нет в этой сборке'));
    }
    var api = '/api/content/' + lang + '/' + topic + '.json';""",
              "loadContent")

    js = swap(js, "          location.href = '/topic?lang=' + state.lang + '&topic=' + t;",
              "          location.href = 'topic.html?lang=' + state.lang + '&topic=' + t;",
              "переход между темами")

    js = swap(js, "      location.replace('/');",
              "      location.replace(window.OFFLINE_INDEX_PAGE);",
              "возврат на страницу входа")

    return ("// Собрано автоматически из ../terminal/server/static/app.js\n"
            "// Правьте оригинал и запускайте собрать.py, а не этот файл.\n" + js)


def build_topic_html():
    html = read(os.path.join(STATIC, "topic.html"))
    html = swap(html, '<script src="/net.js"></script>',
                '<script src="content.js"></script>\n<script src="net.js"></script>',
                "подключение net.js")
    # C#-версии в офлайне нет, лишний режим подсветки не нужен
    html = swap(html, '<script src="vendor/codemirror/mode/clike/clike.js"></script>\n', "",
                "режим C# в редакторе")
    return html


def build_index(order):
    cards = "\n".join(
        '        <a class="lang topic-card" href="topic.html?lang=python&amp;topic={t}">\n'
        '          <span class="lang-name">{n}. {title}</span>\n'
        '          <span class="lang-note">{sub}</span>\n'
        '        </a>'.format(t=item["topic"], n=i + 1,
                              title=item["title"], sub=item["subtitle"] or "три задачи")
        for i, item in enumerate(order))

    return """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Терминал — Python</title>
<link rel="stylesheet" href="style.css">
</head>
<body class="gate-body">

<main class="gate gate-wide">
  <div class="gate-mark">
    <span class="mark-glyph">&gt;_</span>
    <span class="gate-word">Терминал</span>
    <span class="mark-lang">python</span>
  </div>
  <p class="gate-sub">Повторяем язык: теория, задачи, проверка тестами.
    Эта версия работает без интернета — прямо на твоём ноутбуке.</p>

  <form class="gate-form" id="gate-form" autocomplete="off">
    <label class="gate-label" for="name">Как тебя зовут</label>
    <div class="gate-input">
      <span class="gate-prompt">&gt;</span>
      <input id="name" name="name" type="text" maxlength="32" required
             placeholder="имя" spellcheck="false" autocomplete="off">
    </div>
    <div class="gate-hint" id="gate-hint">Имя нужно, чтобы твой прогресс сохранился на этом ноутбуке.</div>

    <div class="gate-label gate-label-2">Темы</div>
    <div class="gate-topics" id="gate-topics">
{cards}
    </div>
  </form>
</main>

<script src="content.js"></script>
<script src="net.js"></script>
<script src="index.js"></script>
</body>
</html>
""".format(cards=cards)


INDEX_JS = """// Вход офлайн-версии: имя один раз, дальше выбор темы.

(function () {
  'use strict';

  var input = document.getElementById('name');
  var hint = document.getElementById('gate-hint');
  var topics = document.getElementById('gate-topics');

  input.value = Net.name();

  // Пока имя не введено, темы не открываются: иначе прогресс будет ничей.
  function lock() {
    var ok = input.value.trim().length > 0;
    topics.dataset.locked = ok ? '0' : '1';
    return ok;
  }

  input.addEventListener('input', function () {
    lock();
    hint.classList.remove('is-bad');
    Net.setName(input.value.trim().replace(/\\s+/g, ' '));
  });

  topics.addEventListener('click', function (ev) {
    if (lock()) return;
    ev.preventDefault();
    hint.textContent = 'Сначала впиши имя — иначе прогресс будет ничей.';
    hint.classList.add('is-bad');
    input.focus();
  });

  document.getElementById('gate-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
  });

  lock();
  input.focus();
})();
"""

EXTRA_CSS = """
/* ============ ОФЛАЙН-ВЕРСИЯ: ВЫБОР ТЕМЫ ============ */

.gate-wide { max-width: 560px; }

.gate-topics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.gate-topics[data-locked="1"] { opacity: 0.45; }

.topic-card { text-decoration: none; }
.topic-card .lang-name { font-size: 13.5px; }
"""


README_TXT = """ТЕРМИНАЛ — версия для флешки
============================

Что это
-------
Сайт для повторения Python. Работает без интернета и без сервера,
прямо на ноутбуке. Ставить ничего не нужно.

Как запустить
-------------
1. Скопируйте всю папку «Терминал» с флешки на ноутбук
   (например, на рабочий стол).
2. Откройте в ней файл «{index}» двойным кликом.
3. Впишите имя и выберите тему.

Важно: копируйте папку целиком. Если открыть файл прямо с флешки,
всё тоже работает, но флешку нельзя вынимать во время занятия.

Что внутри
----------
Восемь тем, в каждой три задачи. Всего 24 задачи с проверкой тестами.
Python выполняется в самом браузере.

Чего здесь нет
--------------
- Общей таблицы группы: её считает сервер, а его в этой версии нет.
  Прогресс каждого ребёнка виден у него в шапке страницы.
- Занятия по C#: его проверка требует компилятора на каждом ноутбуке.
  C# работает только в обычной версии, на машине тьютора.

Прогресс
--------
Хранится в браузере того ноутбука, где ребёнок работал. Если открыть
в другом браузере или почистить данные браузера — прогресс обнулится.
Между ноутбуками он не переносится.

Если что-то не открывается
--------------------------
Откройте файл через Chrome или Edge: правой кнопкой по файлу →
«Открыть с помощью» → браузер.
"""


# ---------------------------------------------------------------- сборка

def main():
    if not os.path.isdir(STATIC):
        raise SystemExit("Не найден исходник: {}".format(STATIC))

    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    print("Собираю офлайн-версию из {}".format(SRC))

    content_js, order = build_content()
    if not order:
        raise SystemExit("В ../terminal/content/python нет ни одной темы")

    write(os.path.join(OUT, "content.js"), content_js)
    write(os.path.join(OUT, "net.js"), NET_STUB)
    write(os.path.join(OUT, "app.js"), build_app_js())
    write(os.path.join(OUT, "topic.html"), build_topic_html())
    write(os.path.join(OUT, INDEX), build_index(order))
    write(os.path.join(OUT, "index.js"), INDEX_JS)
    write(os.path.join(OUT, "style.css"), read(os.path.join(STATIC, "style.css")) + EXTRA_CSS)
    shutil.copy2(os.path.join(STATIC, "runner.js"), os.path.join(OUT, "runner.js"))

    # Вендор нужен целиком: без интернета взять его будет неоткуда.
    vendor_src = os.path.join(STATIC, "vendor")
    vendor_out = os.path.join(OUT, "vendor")
    shutil.copytree(vendor_src, vendor_out)
    # Режим C# в офлайне не используется
    clike = os.path.join(vendor_out, "codemirror", "mode", "clike")
    if os.path.isdir(clike):
        shutil.rmtree(clike)

    write(os.path.join(OUT, "КАК ПОЛЬЗОВАТЬСЯ.txt"), README_TXT.format(index=INDEX))

    total = sum(len(t["task_ids"]) for t in order)
    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(OUT) for f in fs)
    print()
    print("Готово: {}".format(OUT))
    print("  тем:    {}".format(len(order)))
    print("  задач:  {}".format(total))
    print("  размер: {:.1f} МБ".format(size / 1024 / 1024))
    print()
    print("Копировать на флешку целиком папку «Терминал».")


if __name__ == "__main__":
    main()
