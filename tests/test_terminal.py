# -*- coding: utf-8 -*-
"""Тесты: загрузка контента, проверка решений, API прогресса, компиляция C#.

    pip install pytest httpx
    python -m pytest tests -q
"""

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import db                # noqa: E402
import runner_csharp     # noqa: E402

TOPICS = ["basics", "conditions", "loops-for", "loops-while",
          "lists", "strings", "functions", "dicts"]


def load(lang, topic):
    with open(os.path.join(ROOT, "content", lang, topic + ".json"), encoding="utf-8") as f:
        return json.load(f)


def all_tasks(lang):
    for topic in TOPICS:
        for task in load(lang, topic)["tasks"]:
            yield task


# ------------------------------------------------------------------ контент

@pytest.mark.parametrize("topic", TOPICS)
@pytest.mark.parametrize("lang", ["python", "csharp"])
def test_topic_loads(lang, topic):
    data = load(lang, topic)
    assert data["topic"] == topic
    assert data["title"]
    assert len(data["tasks"]) == 3
    assert len(data["theory"]) >= 4


@pytest.mark.parametrize("lang", ["python", "csharp"])
def test_every_task_has_one_hidden_test(lang):
    for task in all_tasks(lang):
        hidden = [t for t in task["tests"] if t.get("hidden")]
        assert len(hidden) == 1, task["id"]


@pytest.mark.parametrize("lang", ["python", "csharp"])
def test_task_ids_unique(lang):
    ids = [t["id"] for t in all_tasks(lang)]
    assert len(ids) == len(set(ids)) == 24


def test_languages_match_one_to_one():
    """Смысл модуля: та же задача с тем же id на двух языках."""
    py = {t["id"]: t for t in all_tasks("python")}
    cs = {t["id"]: t for t in all_tasks("csharp")}
    assert set(py) == set(cs)
    for tid in py:
        assert py[tid]["title"] == cs[tid]["title"], tid
        assert [t["args"] for t in py[tid]["tests"]] == [t["args"] for t in cs[tid]["tests"]], tid
        assert [t["expect"] for t in py[tid]["tests"]] == [t["expect"] for t in cs[tid]["tests"]], tid


def test_no_oop_anywhere_in_python():
    """Никакого ООП: ни классов, ни объектов в теории, задачах и примерах."""
    banned = ("class ", "self", "__init__", "объект", "экземпляр")
    for topic in TOPICS:
        data = load("python", topic)
        blob = json.dumps(data, ensure_ascii=False).lower()
        for word in banned:
            assert word.lower() not in blob, "{}: встретилось «{}»".format(topic, word)


def test_csharp_frame_is_only_frame():
    """В C# class Program — обязательная рамка. Слов про ООП быть не должно."""
    banned = ("объект", "экземпляр", "наследован", "метод класса")
    for topic in TOPICS:
        data = load("csharp", topic)
        blob = json.dumps(data, ensure_ascii=False).lower()
        for word in banned:
            assert word not in blob, "{}: встретилось «{}»".format(topic, word)
        for task in data["tasks"]:
            assert "class Program" in task["starter"]
            assert "static" in task["starter"]


# ------------------------------------------------------------------ решения

@pytest.mark.parametrize("task", list(all_tasks("python")), ids=lambda t: t["id"])
def test_python_reference_solution(task):
    namespace = {}
    exec(compile(task["solution"], task["id"], "exec"), namespace)
    fn = namespace[task["entry"]]
    for test in task["tests"]:
        got = fn(*test["args"])
        assert got == test["expect"], "{}({})".format(task["entry"], test["args"])
        assert type(got) is type(test["expect"])


def test_python_starter_does_not_solve_it():
    """Стартовый шаблон не должен случайно проходить тесты."""
    for task in all_tasks("python"):
        namespace = {}
        try:
            exec(compile(task["starter"], task["id"], "exec"), namespace)
        except SyntaxError:
            continue  # шаблон намеренно неполный — это нормально
        fn = namespace.get(task["entry"])
        if fn is None:
            continue
        passed = 0
        for test in task["tests"]:
            try:
                if fn(*test["args"]) == test["expect"]:
                    passed += 1
            except Exception:
                pass
        assert passed < len(task["tests"]), task["id"] + ": шаблон уже решает задачу"


# ------------------------------------------------------------------ база и API

@pytest.fixture()
def guest(tmp_path, monkeypatch):
    """Сервер на отдельной базе, чтобы не трогать рабочую. Без входа тьютора."""
    httpx = pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "t.sqlite3"))
    db.init()

    import app as app_module
    return TestClient(app_module.app)


@pytest.fixture()
def api(guest):
    """То же, но уже с введённым паролем: таблица и страница тьютора закрыты,
    а почти всё, что тут проверяется, смотрит именно на них."""
    import app as app_module
    r = guest.post("/api/login", json={"password": app_module.PASSWORD})
    assert r.status_code == 200
    return guest


def test_progress_flow(api):
    assert api.post("/api/session", json={"name": "Аня"}).status_code == 200

    r = api.post("/api/progress", json={
        "name": "Аня", "lang": "python", "task_id": "conditions-1",
        "solved": True, "hints": 1, "code": "def is_even(n): return n % 2 == 0"})
    assert r.status_code == 200

    board = api.get("/api/board?lang=python").json()
    row = [s for s in board["students"] if s["name"] == "Аня"][0]
    assert row["solved"] == 1
    assert row["topics"][1] == 1     # conditions — вторая тема


def test_progress_is_idempotent(api):
    body = {"name": "Боря", "lang": "python", "task_id": "lists-1",
            "solved": True, "hints": 0, "code": "x"}
    for _ in range(5):
        api.post("/api/progress", json=body)
    row = [s for s in api.get("/api/board?lang=python").json()["students"]
           if s["name"] == "Боря"][0]
    assert row["solved"] == 1


def test_solved_never_goes_back(api):
    base = {"name": "Вика", "lang": "python", "task_id": "lists-1", "hints": 0, "code": "x"}
    api.post("/api/progress", json=dict(base, solved=True))
    api.post("/api/progress", json=dict(base, solved=False))
    row = [s for s in api.get("/api/board?lang=python").json()["students"]
           if s["name"] == "Вика"][0]
    assert row["solved"] == 1


def test_unknown_task_rejected(api):
    r = api.post("/api/progress", json={
        "name": "Аня", "lang": "python", "task_id": "выдуманная", "solved": True})
    assert r.status_code == 400


def test_unknown_language_rejected(api):
    r = api.post("/api/progress", json={
        "name": "Аня", "lang": "perl", "task_id": "conditions-1", "solved": True})
    assert r.status_code == 422


def test_blank_name_rejected(api):
    assert api.post("/api/session", json={"name": "   "}).status_code == 422


def test_board_hides_time_and_tutor_shows_it(api):
    api.post("/api/activity", json={"name": "Глеб", "lang": "python", "task_id": "basics-1"})

    for student in api.get("/api/board?lang=python").json()["students"]:
        assert "on_task_sec" not in student
        assert "idle_sec" not in student

    tutor = api.get("/api/tutor?lang=python").json()
    row = [s for s in tutor["students"] if s["name"] == "Глеб"][0]
    assert row["on_task_sec"] is not None
    assert tutor["task_titles"]["basics-1"]


def test_board_and_tutor_need_password(guest):
    assert guest.get("/api/board?lang=python").status_code == 401
    assert guest.get("/api/tutor?lang=python").status_code == 401


def test_closed_pages_show_the_login_form(guest):
    # Отдаётся форма по тому же адресу, а не редирект: после входа хватит перезагрузки.
    for path in ("/board", "/tutor"):
        r = guest.get(path)
        assert r.status_code == 200
        assert "Терминал — вход" in r.text
        assert "Движение группы" not in r.text
        assert "Кто где сидит" not in r.text


def test_static_html_does_not_bypass_the_password(guest):
    # Статика примонтирована в корень, так что board.html доступен и по имени файла.
    for path in ("/board.html", "/tutor.html", "/BOARD.HTML"):
        assert "Терминал — вход" in guest.get(path).text


def test_wrong_password_rejected(guest):
    assert guest.post("/api/login", json={"password": "admin"}).status_code == 401
    assert guest.get("/api/tutor?lang=python").status_code == 401


def test_logout_closes_it_again(api):
    assert api.get("/api/tutor?lang=python").status_code == 200
    assert api.post("/api/logout").status_code == 200
    assert api.get("/api/tutor?lang=python").status_code == 401


def test_children_are_not_locked_out(guest):
    """Пароль стоит только на таблице и странице тьютора. Всё детское открыто —
    иначе занятие остановится вместе с ним."""
    assert guest.get("/").status_code == 200
    assert guest.get("/topic?lang=python&topic=basics").status_code == 200
    assert guest.get("/api/topics/python").status_code == 200
    assert guest.get("/api/content/python/basics.json").status_code == 200
    assert guest.post("/api/session", json={"name": "Аня"}).status_code == 200
    assert guest.post("/api/progress", json={
        "name": "Аня", "lang": "python", "task_id": "basics-1",
        "solved": True, "hints": 0, "code": "x"}).status_code == 200


def test_deleting_a_student_needs_the_password(guest):
    """Иначе удалить кого угодно мог бы любой ребёнок с той же страницы."""
    guest.post("/api/session", json={"name": "Аня"})
    assert guest.post("/api/student/delete", json={"name": "Аня"}).status_code == 401
    # и никто никуда не делся
    assert guest.post("/api/session", json={"name": "Аня"}).status_code == 200


def test_delete_removes_the_student_everywhere(api):
    api.post("/api/progress", json={
        "name": "Аня", "lang": "python", "task_id": "basics-1",
        "solved": True, "hints": 1, "code": "def greet(name): return 1"})
    api.post("/api/progress", json={
        "name": "Аня", "lang": "csharp", "task_id": "basics-1",
        "solved": True, "hints": 0, "code": "class Program {}"})
    api.post("/api/session", json={"name": "Боря"})

    assert api.post("/api/student/delete", json={"name": "Аня"}).json()["deleted"] == "Аня"

    for lang in ("python", "csharp"):
        names = [s["name"] for s in api.get("/api/board?lang=" + lang).json()["students"]]
        assert "Аня" not in names
        assert "Боря" in names

    # Решения уходят вместе с ребёнком, иначе на занятии по C# всплыл бы
    # чужой код под его именем.
    assert api.get("/api/solution/python/basics-1?name=Аня").json()["code"] is None


def test_delete_is_case_insensitive_like_everything_else(api):
    api.post("/api/session", json={"name": "Аня"})
    assert api.post("/api/student/delete", json={"name": "аня"}).status_code == 200
    assert not api.get("/api/board?lang=python").json()["students"]


def test_deleting_an_unknown_name_is_404(api):
    assert api.post("/api/student/delete", json={"name": "Никого"}).status_code == 404


def test_board_is_paginated(api):
    for i in range(5):
        api.post("/api/session", json={"name": "Ребёнок {}".format(i)})
    page = api.get("/api/board?lang=python&limit=2&offset=0").json()
    assert len(page["students"]) == 2
    assert page["total"] == 5


def test_same_name_is_same_child(api):
    api.post("/api/session", json={"name": "Аня"})
    api.post("/api/session", json={"name": "  аня  "})
    assert api.get("/api/board?lang=python").json()["total"] == 1


def test_solution_survives_for_next_lesson(api):
    """C#-занятие достаёт решение по имени и id задачи."""
    api.post("/api/progress", json={
        "name": "Даша", "lang": "python", "task_id": "conditions-1",
        "solved": True, "hints": 0, "code": "def is_even(n):\n    return n % 2 == 0"})
    r = api.get("/api/solution/python/conditions-1?name=Даша").json()
    assert r["found"] is True
    assert "is_even" in r["code"]

    missing = api.get("/api/solution/python/conditions-1?name=Незнакомец").json()
    assert missing["found"] is False


def test_content_endpoint(api):
    data = api.get("/api/content/python/conditions.json").json()
    assert data["topic"] == "conditions"
    assert api.get("/api/content/python/нет-такой.json").status_code == 404


# ------------------------------------------------------------------ C#

def test_csharp_source_keeps_student_line_numbers():
    """Заготовка приписана после кода ребёнка, поэтому его строки не сдвигаются."""
    task = next(t for t in all_tasks("csharp") if t["id"] == "conditions-1")
    source = runner_csharp.build_source(task["solution"], task)
    student_lines = task["solution"].splitlines()
    built_lines = source.splitlines()
    for i, line in enumerate(student_lines[:-1]):   # кроме последней скобки
        assert built_lines[i] == line, "строка {} сдвинулась".format(i + 1)


def test_csharp_harness_calls_every_test():
    task = next(t for t in all_tasks("csharp") if t["id"] == "conditions-3")
    source = runner_csharp.build_source(task["solution"], task)
    assert source.count("Grade(") >= len(task["tests"])
    for i in range(len(task["tests"])):
        assert "<<T{}>>".format(i) in source


def test_csharp_literals():
    assert runner_csharp.cs_literal(5, "int") == "5"
    assert runner_csharp.cs_literal(True, "bool") == "true"
    assert runner_csharp.cs_literal("Аня", "string") == '"Аня"'
    assert runner_csharp.cs_literal('он сказал "да"', "string") == '"он сказал \\"да\\""'
    assert runner_csharp.cs_literal([1, 2], "int[]") == "new int[] { 1, 2 }"
    assert "Dictionary<string, int>" in runner_csharp.cs_literal({"a": 1}, "dict")


def test_csharp_compiler_errors_are_translated():
    output = (r"C:\work\Program.cs(7,25): error CS1002: ; expected [C:\work\task.csproj]" "\n"
              r"C:\work\Program.cs(40,1): error CS1513: } expected [C:\work\task.csproj]")
    errors = runner_csharp.parse_build_errors(output, user_line_count=12)
    assert errors[0]["line"] == 7
    assert errors[0]["code"] == "CS1002"
    assert "точки с запятой" in errors[0]["hint"]
    # Ошибка ниже кода ребёнка относится к заготовке — прижимаем к его последней строке.
    assert errors[1]["line"] == 12


@pytest.mark.skipif(not runner_csharp.dotnet_available(), reason="нет .NET SDK")
@pytest.mark.parametrize("task", list(all_tasks("csharp")), ids=lambda t: t["id"])
def test_csharp_reference_solution(task):
    result = runner_csharp.run_tests(task["solution"], task)
    assert "compile_errors" not in result, result.get("compile_errors")
    assert not result.get("error"), result.get("error")
    for i, r in enumerate(result["tests"]):
        assert r["pass"], "{} тест {}: {} вместо {}".format(
            task["id"], i + 1, r.get("got"), r.get("want"))


@pytest.mark.skipif(not runner_csharp.dotnet_available(), reason="нет .NET SDK")
def test_csharp_infinite_loop_is_stopped():
    task = next(t for t in all_tasks("csharp") if t["id"] == "conditions-1")
    code = task["starter"].replace("// твой код", "while (true) { }")
    result = runner_csharp.run_tests(code, task)
    assert result.get("timeout") or result.get("compile_errors")
