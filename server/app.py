# -*- coding: utf-8 -*-
"""Сервер «Терминала».

Отдаёт статику, хранит прогресс и решения. Проверка задач идёт в браузере,
поэтому сервер для решения задач не нужен: если он упал, дети продолжают
работать, гаснет только общая таблица.
"""

import hashlib
import hmac
import json
import os
import socket
import sys
import time

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402
import runner_csharp  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATIC = os.path.join(HERE, "static")
CONTENT = os.path.join(ROOT, "content")

LANGS = ("python", "csharp")

# Порядок тем задан здесь, а не именами файлов: он учебный, а не алфавитный.
TOPIC_ORDER = [
    "basics", "conditions", "loops-for", "loops-while",
    "lists", "strings", "functions", "dicts",
]
TASKS_PER_TOPIC = 3

# Названия для тем, файла которых ещё нет: легенда на проекторе должна быть
# по-русски всегда, а не показывать слаги.
TOPIC_TITLES = {
    "basics": "Переменные и вывод",
    "conditions": "Условия",
    "loops-for": "Цикл for",
    "loops-while": "Цикл while",
    "lists": "Списки",
    "strings": "Строки",
    "functions": "Функции",
    "dicts": "Словари",
}

app = FastAPI(title="Терминал", docs_url=None, redoc_url=None)
api = APIRouter(prefix="/api")


# ---------------------------------------------------------------- пароль

# Таблица группы и страница тьютора закрыты паролем: на странице тьютора
# видно время решения, а его дети видеть не должны нигде.
#
# Это защита от любопытного ребёнка, а не от злоумышленника: связь идёт
# по обычному http внутри класса, пароль ходит открытым текстом.
PASSWORD = os.environ.get("TERMINAL_PASSWORD", "admin123")
COOKIE = "terminal_admin"
COOKIE_MAX_AGE = 12 * 60 * 60   # учебный день; на утро следующего дня вход заново

# Пути в нижнем регистре: на Windows статика отдаётся и по /Board.html.
PROTECTED_PAGES = ("/board", "/board.html", "/tutor", "/tutor.html")
PROTECTED_API = ("/api/board", "/api/tutor", "/api/student/delete")


def _token():
    """Метка входа. Считается от пароля, а не случайная: перезапуск сервера
    посреди занятия не должен выкидывать тьютора с проектора."""
    return hashlib.sha256(("терминал:" + PASSWORD).encode("utf-8")).hexdigest()


def authorized(request):
    return hmac.compare_digest(request.cookies.get(COOKIE, ""), _token())


@app.middleware("http")
async def guard(request, call_next):
    """Один заслон на всё закрытое: и на страницы, и на данные под ними.

    Именно middleware, а не зависимость на маршрутах: board.html и tutor.html
    отдаёт ещё и StaticFiles, мимо маршрутов, и без общего заслона в них
    можно было бы зайти по прямому имени файла.
    """
    path = request.url.path.rstrip("/").lower() or "/"

    if path in PROTECTED_API and not authorized(request):
        return JSONResponse({"detail": "Нужен пароль"}, status_code=401)

    # Страница отдаётся по тому же адресу, что просили: после входа
    # достаточно перезагрузить её, никаких возвратных параметров в ссылке.
    if path in PROTECTED_PAGES and not authorized(request):
        return page("login.html")

    return await call_next(request)


class Login(BaseModel):
    password: str = Field(min_length=1, max_length=200)


@api.post("/login")
def api_login(body: Login):
    # Через bytes: compare_digest на строках спотыкается о не-ASCII в пароле.
    if not hmac.compare_digest(body.password.encode("utf-8"), PASSWORD.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Пароль не подходит")
    res = JSONResponse({"ok": True})
    res.set_cookie(COOKIE, _token(), max_age=COOKIE_MAX_AGE,
                   httponly=True, samesite="lax")
    return res


@api.post("/logout")
def api_logout():
    res = JSONResponse({"ok": True})
    res.delete_cookie(COOKIE)
    return res


# ---------------------------------------------------------------- контент

_cache = {}


def load_topic(lang, topic):
    """Читает тему из JSON. Файл перечитывается, если его правили — рестарт не нужен."""
    if lang not in LANGS or topic not in TOPIC_ORDER:
        raise HTTPException(status_code=404, detail="Такой темы нет")

    path = os.path.join(CONTENT, lang, topic + ".json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        raise HTTPException(status_code=404, detail="Тема ещё не готова: " + topic)

    key = (lang, topic)
    hit = _cache.get(key)
    if hit and hit[0] == mtime:
        return hit[1]

    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    _cache[key] = (mtime, data)
    return data


def topic_index(lang):
    """Список тем курса с пометкой, какие уже готовы."""
    out = []
    for order, topic in enumerate(TOPIC_ORDER, start=1):
        path = os.path.join(CONTENT, lang, topic + ".json")
        ready = os.path.exists(path)
        item = {"topic": topic, "order": order, "ready": ready, "tasks": TASKS_PER_TOPIC}
        if ready:
            data = load_topic(lang, topic)
            item["title"] = data.get("title", topic)
            item["subtitle"] = data.get("subtitle", "")
            item["tasks"] = len(data.get("tasks", []))
            item["task_ids"] = [t["id"] for t in data.get("tasks", [])]
        else:
            item["title"] = TOPIC_TITLES.get(topic, topic)
            item["subtitle"] = ""
            item["task_ids"] = []
        out.append(item)
    return out


def known_task(lang, task_id):
    """Задачи придумывает контент, а не клиент. Чужой id на сервер не попадёт."""
    for item in topic_index(lang):
        if task_id in item["task_ids"]:
            return item["topic"]
    return None


# ---------------------------------------------------------------- модели

NAME_MAX = 32
CODE_MAX = 20000


class Session(BaseModel):
    name: str = Field(min_length=1, max_length=NAME_MAX)

    @field_validator("name")
    @classmethod
    def tidy(cls, v):
        v = " ".join(v.split())
        if not v:
            raise ValueError("Имя не может быть пустым")
        return v


class Activity(BaseModel):
    name: str = Field(min_length=1, max_length=NAME_MAX)
    lang: str
    task_id: str = Field(min_length=1, max_length=64)

    @field_validator("lang")
    @classmethod
    def known_lang(cls, v):
        if v not in LANGS:
            raise ValueError("Неизвестный язык")
        return v


class RunIn(BaseModel):
    lang: str
    task_id: str = Field(default="", max_length=64)
    code: str = Field(min_length=1, max_length=CODE_MAX)

    @field_validator("lang")
    @classmethod
    def known_lang(cls, v):
        if v != "csharp":
            raise ValueError("Через сервер запускается только C#: Python работает в браузере")
        return v


class ProgressIn(Activity):
    solved: bool = False
    hints: int = Field(default=0, ge=0, le=10)
    code: str = Field(default="", max_length=CODE_MAX)


# ---------------------------------------------------------------- API

@api.get("/topics/{lang}")
def api_topics(lang: str):
    if lang not in LANGS:
        raise HTTPException(status_code=404, detail="Неизвестный язык")
    return {"lang": lang, "topics": topic_index(lang)}


@api.get("/content/{lang}/{filename}")
def api_content(lang: str, filename: str):
    if not filename.endswith(".json"):
        raise HTTPException(status_code=404, detail="Не найдено")
    return load_topic(lang, filename[:-5])


@api.post("/session")
def api_session(body: Session):
    with db.connect() as conn:
        row = db.upsert_student(conn, body.name)
    return {"name": row["name"]}


@api.post("/activity")
def api_activity(body: Activity):
    if known_task(body.lang, body.task_id) is None:
        raise HTTPException(status_code=400, detail="Неизвестная задача")
    with db.connect() as conn:
        row = db.upsert_student(conn, body.name)
        db.touch_activity(conn, row["id"], body.lang, body.task_id)
    return {"ok": True}


@api.post("/progress")
def api_progress(body: ProgressIn):
    topic = known_task(body.lang, body.task_id)
    if topic is None:
        raise HTTPException(status_code=400, detail="Неизвестная задача")
    with db.connect() as conn:
        row = db.upsert_student(conn, body.name)
        db.save_progress(
            conn, row["id"], body.lang, body.task_id, topic,
            body.solved, body.hints, body.code or None,
        )
        db.touch_activity(conn, row["id"], body.lang, body.task_id)
    return {"ok": True}


@api.get("/solution/{lang}/{task_id}")
def api_solution(lang: str, task_id: str, name: str = Query(min_length=1, max_length=NAME_MAX)):
    """Своё решение прошлого занятия. Понадобится в C#-версии на шаге 5."""
    if lang not in LANGS:
        raise HTTPException(status_code=404, detail="Неизвестный язык")
    with db.connect() as conn:
        row = db.get_solution(conn, name, lang, task_id)
    if row is None:
        return {"found": False, "code": None}
    return {"found": True, "code": row["code"], "updated_at": row["updated_at"]}


@api.get("/runtime")
def api_runtime():
    """Чем сервер умеет запускать C#. Страница показывает это честно."""
    return {
        "csharp": runner_csharp.dotnet_available(),
        "dotnet": runner_csharp.dotnet_version(),
    }


@api.post("/run")
def api_run(body: RunIn):
    """Компиляция и запуск C#. Python сюда не ходит — он считается в браузере."""
    if not runner_csharp.dotnet_available():
        raise HTTPException(status_code=503, detail="На машине тьютора не установлен .NET SDK")

    if body.task_id:
        topic = known_task(body.lang, body.task_id)
        if topic is None:
            raise HTTPException(status_code=400, detail="Неизвестная задача")
        task = None
        for t in load_topic(body.lang, topic)["tasks"]:
            if t["id"] == body.task_id:
                task = t
        return runner_csharp.run_tests(body.code, task)

    return runner_csharp.run_snippet(body.code)


def _board_payload(lang, limit, offset, with_time):
    topics = topic_index(lang)
    order = [t["topic"] for t in topics]

    with db.connect() as conn:
        rows, by_topic, total = db.board(conn, lang, limit, offset)

    now = time.time()
    students = []
    for r in rows:
        done = by_topic.get(r["id"], {})
        item = {
            "name": r["name"],
            "solved": r["solved"],
            "hints": r["hints"],
            "topics": [min(done.get(t, 0), TASKS_PER_TOPIC) for t in order],
        }
        if with_time:
            # Единственное место, где время вообще фигурирует, и видит его только тьютор.
            item["task_id"] = r["last_task_id"]
            item["on_task_sec"] = int(now - r["last_task_since"]) if r["last_task_since"] else None
            item["idle_sec"] = int(now - r["last_seen"]) if r["last_seen"] else None
        students.append(item)

    return {
        "lang": lang,
        # Адрес печатается на проекторе, чтобы опоздавшие видели, куда заходить.
        "url": "http://{}:{}".format(local_ip(), os.environ.get("TERMINAL_PORT", "8000")),
        "topics": [{"topic": t["topic"], "title": t["title"], "ready": t["ready"]} for t in topics],
        "tasks_per_topic": TASKS_PER_TOPIC,
        "students": students,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@api.get("/board")
def api_board(lang: str = "python", limit: int = Query(default=100, ge=1, le=500), offset: int = Query(default=0, ge=0)):
    if lang not in LANGS:
        raise HTTPException(status_code=404, detail="Неизвестный язык")
    return _board_payload(lang, limit, offset, with_time=False)


@api.post("/student/delete")
def api_student_delete(body: Session):
    """Убирает ребёнка из таблицы. Только для тьютора — путь под паролем.

    Нужно после занятия и после проб: лишние профили висят на проекторе
    и мешают видеть группу.
    """
    with db.connect() as conn:
        removed = db.delete_student(conn, body.name)
    if removed is None:
        raise HTTPException(status_code=404, detail="Такого имени в таблице нет")
    return {"deleted": removed}


@api.get("/tutor")
def api_tutor(lang: str = "python", limit: int = Query(default=100, ge=1, le=500), offset: int = Query(default=0, ge=0)):
    if lang not in LANGS:
        raise HTTPException(status_code=404, detail="Неизвестный язык")
    data = _board_payload(lang, limit, offset, with_time=True)
    titles = {}
    for t in topic_index(lang):
        if t["ready"]:
            for task in load_topic(lang, t["topic"])["tasks"]:
                titles[task["id"]] = task["title"]
    data["task_titles"] = titles
    return data


app.include_router(api)


# ---------------------------------------------------------------- страницы

def page(name):
    return FileResponse(os.path.join(STATIC, name))


@app.get("/")
def page_index():
    return page("index.html")


@app.get("/topic")
def page_topic():
    return page("topic.html")


@app.get("/board")
def page_board():
    return page("board.html")


@app.get("/tutor")
def page_tutor():
    return page("tutor.html")


# Статика монтируется последней, иначе она перехватит адреса выше.
app.mount("/", StaticFiles(directory=STATIC), name="static")


# ---------------------------------------------------------------- запуск

_ip = None


def local_ip():
    """Адрес машины в классной сети. Считается один раз: таблицу опрашивают часто."""
    global _ip
    if _ip is None:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            _ip = s.getsockname()[0]
        except OSError:
            _ip = "127.0.0.1"
        finally:
            s.close()
    return _ip


def banner(port):
    url = "http://{}:{}".format(local_ip(), port)
    width = max(len(url) + 22, 52)
    print()
    print("=" * width)
    print("  ТЕРМИНАЛ — сервер запущен")
    print()
    print("  Дети открывают:      " + url)
    print("  Таблица на проектор: " + url + "/board")
    print("  Страница тьютора:    " + url + "/tutor")
    print("=" * width)
    print()
    # Пароль печатается в консоль тьютора: искать его в коде посреди занятия
    # никто не будет.
    if PASSWORD == "admin123":
        print("  Таблица и страница тьютора под паролем: admin123")
        print("  Свой пароль: TERMINAL_PASSWORD=... перед запуском.")
    else:
        print("  Таблица и страница тьютора под паролем из TERMINAL_PASSWORD.")
    print()
    print("  Если у детей не открывается — скорее всего, в этом Wi-Fi")
    print("  включена изоляция клиентов. Раздайте точку с телефона.")
    print()
    print("  Остановить: Ctrl+C")
    print()
    sys.stdout.flush()   # адрес должен быть виден сразу, даже если вывод перенаправлен


def main():
    import uvicorn

    port = int(os.environ.get("TERMINAL_PORT", "8000"))
    db.init()
    banner(port)
    if runner_csharp.dotnet_available():
        print("  .NET SDK найден, прогреваю компилятор...")
        runner_csharp.warmup()
        print("  компилятор готов.")
        print()
    else:
        print("  .NET SDK не найден: занятие по C# работать не будет,")
        print("  Python работает как обычно.")
        print()
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
