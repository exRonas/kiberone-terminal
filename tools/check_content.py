# -*- coding: utf-8 -*-
"""Прогоняет эталонные решения через все тесты каждой задачи.

Без этого ошибка в задаче обнаружится посреди занятия. Запускается одной
командой и падает, если хоть одна эталонка не проходит:

    python tools/check_content.py

Python-решения выполняются здесь же. C#-решения компилируются и запускаются
через .NET SDK; если dotnet не установлен, они пропускаются с явной пометкой,
а команда всё равно падает — чтобы это нельзя было не заметить.
"""

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONTENT = os.path.join(ROOT, "content")

sys.path.insert(0, os.path.join(ROOT, "server"))

TOPIC_ORDER = [
    "basics", "conditions", "loops-for", "loops-while",
    "lists", "strings", "functions", "dicts",
]
TASKS_PER_TOPIC = 3

OK = "  ok  "
BAD = " ПАДАЕТ "


class Problem(Exception):
    pass


def load(lang, topic):
    path = os.path.join(CONTENT, lang, topic + ".json")
    if not os.path.exists(path):
        return None
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- структура

REQUIRED_TASK = ("id", "topic", "title", "statement", "starter", "entry", "tests", "hints", "solution")


def check_shape(lang, topic, data, seen_ids):
    """Проверки, которые не зависят от языка: поля на месте, id уникальны."""
    problems = []

    if data.get("topic") != topic:
        problems.append("поле topic не совпадает с именем файла")

    theory = data.get("theory") or []
    if not theory:
        problems.append("нет ни одной карточки теории")
    for card in theory:
        for key in ("id", "title", "text", "code"):
            if not card.get(key):
                problems.append("в карточке теории нет поля " + key)

    tasks = data.get("tasks") or []
    if len(tasks) != TASKS_PER_TOPIC:
        problems.append("задач {}, а должно быть {}".format(len(tasks), TASKS_PER_TOPIC))

    for task in tasks:
        tid = task.get("id", "?")
        for key in REQUIRED_TASK:
            if key not in task:
                problems.append("{}: нет поля {}".format(tid, key))
        if task.get("topic") != topic:
            problems.append("{}: поле topic не совпадает с темой".format(tid))
        if tid in seen_ids.get(lang, set()):
            problems.append("{}: такой id уже есть".format(tid))
        seen_ids.setdefault(lang, set()).add(tid)

        tests = task.get("tests") or []
        if len(tests) < 3:
            problems.append("{}: тестов меньше трёх".format(tid))
        hidden = [t for t in tests if t.get("hidden")]
        if len(hidden) != 1:
            problems.append("{}: скрытых тестов {}, а должен быть ровно один".format(tid, len(hidden)))
        for t in tests:
            if "args" not in t or "expect" not in t:
                problems.append("{}: у теста нет args или expect".format(tid))

        hints = task.get("hints") or []
        if not 2 <= len(hints) <= 3:
            problems.append("{}: подсказок {}, а надо две-три".format(tid, len(hints)))

        for name in task.get("must_call", []):
            body = task["solution"]
            body = body[body.index("def " + task["entry"]):] if ("def " + task["entry"]) in body else body
            if name + "(" not in body:
                problems.append("{}: эталонка не вызывает {}, хотя must_call этого требует".format(tid, name))

    return problems


# ---------------------------------------------------------------- Python

# Skulpt — не CPython. Эти методы у него работают только с латиницей:
# "м".isalpha() возвращает False. Курс написан по-русски, поэтому решение
# на таких методах пройдёт здесь и молча соврёт в браузере у ребёнка.
SKULPT_ASCII_ONLY = ("isalpha", "isdigit", "isupper", "islower", "isspace", "isalnum")


def check_skulpt_traps(task):
    problems = []
    where = "\n".join([task["solution"]] + list(task.get("hints", [])))
    for name in SKULPT_ASCII_ONLY:
        if "." + name + "(" in where:
            problems.append(
                "{}: используется .{}() — в Skulpt он работает только с латиницей, "
                "на русском тексте ответ будет неверным".format(task["id"], name))
    return problems


def run_python(task):
    """Выполняет эталонку и сверяет каждый тест."""
    problems = []
    namespace = {}
    try:
        exec(compile(task["solution"], task["id"] + ".py", "exec"), namespace)
    except Exception as e:
        return ["{}: эталонка не выполняется — {}: {}".format(task["id"], type(e).__name__, e)]

    fn = namespace.get(task["entry"])
    if not callable(fn):
        return ["{}: в эталонке нет функции {}".format(task["id"], task["entry"])]

    for i, test in enumerate(task["tests"], start=1):
        try:
            got = fn(*test["args"])
        except Exception as e:
            problems.append("{} тест {}: эталонка упала — {}: {}".format(
                task["id"], i, type(e).__name__, e))
            continue
        want = test["expect"]
        if got != want or type(got) is not type(want):
            problems.append("{} тест {}: {}{} дал {!r}, а ждали {!r}".format(
                task["id"], i, task["entry"], tuple(test["args"]), got, want))
    return problems


# ---------------------------------------------------------------- C#

def run_csharp(tasks):
    """Компилирует и гоняет эталонки C# через раннер сервера."""
    try:
        import runner_csharp
    except ImportError as e:
        return ["не удалось загрузить runner_csharp: {}".format(e)]

    if not runner_csharp.dotnet_available():
        return None  # SDK нет — отдельная ветка сообщений

    problems = []
    for task in tasks:
        result = runner_csharp.run_tests(task["solution"], task)
        if result.get("error"):
            problems.append("{}: {}".format(task["id"], result["error"]))
            continue
        for i, r in enumerate(result["tests"], start=1):
            if not r["pass"]:
                problems.append("{} тест {}: дал {}, а ждали {}".format(
                    task["id"], i, r.get("got"), r.get("want")))
    return problems


# ---------------------------------------------------------------- сверка языков

def check_parity(python_tasks, csharp_tasks):
    """Задачи на C# обязаны повторять Python один в один по id и формулировке."""
    problems = []
    py_ids = [t["id"] for t in python_tasks]
    cs_ids = [t["id"] for t in csharp_tasks]

    if py_ids != cs_ids:
        problems.append("порядок или состав id не совпадает:\n    python: {}\n    csharp: {}".format(py_ids, cs_ids))
        return problems

    py_by_id = {t["id"]: t for t in python_tasks}
    for task in csharp_tasks:
        other = py_by_id[task["id"]]
        if task["title"] != other["title"]:
            problems.append("{}: заголовки разошлись".format(task["id"]))
        if len(task["tests"]) != len(other["tests"]):
            problems.append("{}: разное число тестов".format(task["id"]))
        if [t["args"] for t in task["tests"]] != [t["args"] for t in other["tests"]]:
            problems.append("{}: аргументы тестов разошлись".format(task["id"]))
    return problems


# ---------------------------------------------------------------- главное

def main():
    problems = []
    notes = []
    seen_ids = {}
    checked = 0

    languages = []
    for lang in ("python", "csharp"):
        if os.path.isdir(os.path.join(CONTENT, lang)) and os.listdir(os.path.join(CONTENT, lang)):
            languages.append(lang)

    loaded = {}
    for lang in languages:
        loaded[lang] = {}
        print("\n{}".format(lang))
        for topic in TOPIC_ORDER:
            data = load(lang, topic)
            if data is None:
                print("  {:<14} — файла нет".format(topic))
                problems.append("{}/{}.json отсутствует".format(lang, topic))
                continue
            loaded[lang][topic] = data

            bad = check_shape(lang, topic, data, seen_ids)
            if lang == "python":
                for task in data.get("tasks", []):
                    bad.extend(check_skulpt_traps(task))
                    bad.extend(run_python(task))
                    checked += len(task.get("tests", []))

            if bad:
                print("  {:<14} {}".format(topic, BAD))
                for line in bad:
                    print("      " + line)
                problems.extend(bad)
            else:
                print("  {:<14} {} задач {}".format(topic, OK, len(data.get("tasks", []))))

    # C# гоняем одним заходом: запуск dotnet дорогой
    if "csharp" in loaded and loaded["csharp"]:
        cs_tasks = [t for topic in TOPIC_ORDER if topic in loaded["csharp"]
                    for t in loaded["csharp"][topic]["tasks"]]
        print("\ncsharp: компиляция эталонных решений")
        result = run_csharp(cs_tasks)
        if result is None:
            notes.append("dotnet не найден: эталонные решения C# не проверены")
            print("  .NET SDK не найден — решения C# НЕ проверены")
        else:
            checked += sum(len(t["tests"]) for t in cs_tasks)
            if result:
                problems.extend(result)
                for line in result:
                    print("      " + line)
            else:
                print("  {} все эталонки скомпилировались и прошли".format(OK))

        # соответствие тем один в один
        for topic in TOPIC_ORDER:
            if topic in loaded.get("python", {}) and topic in loaded["csharp"]:
                bad = check_parity(loaded["python"][topic]["tasks"], loaded["csharp"][topic]["tasks"])
                if bad:
                    problems.extend(bad)
                    print("  соответствие {}: {}".format(topic, BAD))
                    for line in bad:
                        print("      " + line)

    print("\n" + "-" * 58)
    if problems:
        print("ПРОВЕРКА НЕ ПРОШЛА: {} {}".format(
            len(problems), "проблема" if len(problems) == 1 else "проблем"))
        return 1

    if notes:
        for n in notes:
            print("НЕ ПРОВЕРЕНО: " + n)
        print("Поставьте .NET SDK и запустите снова.")
        return 1

    print("Всё сошлось: проверено {} тестов на эталонных решениях.".format(checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
