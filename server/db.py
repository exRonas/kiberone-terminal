# -*- coding: utf-8 -*-
"""Хранилище: один файл SQLite рядом со скриптом, разворачивать нечего.

Данные живут два занятия и стираются. Истории между учебными годами нет.
"""

import contextlib
import os
import sqlite3
import time

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "terminal.sqlite3")

SCHEMA = """
CREATE TABLE IF NOT EXISTS students (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    name_key        TEXT NOT NULL UNIQUE,
    created_at      REAL NOT NULL,
    last_seen       REAL NOT NULL,
    last_lang       TEXT,
    last_task_id    TEXT,
    last_task_since REAL
);

CREATE TABLE IF NOT EXISTS solutions (
    id         INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    lang       TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    code       TEXT NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE (student_id, lang, task_id)
);

CREATE TABLE IF NOT EXISTS progress (
    id         INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    lang       TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    topic      TEXT NOT NULL,
    solved     INTEGER NOT NULL DEFAULT 0,
    hints      INTEGER NOT NULL DEFAULT 0,
    attempts   INTEGER NOT NULL DEFAULT 0,
    first_seen REAL NOT NULL,
    solved_at  REAL,
    UNIQUE (student_id, lang, task_id)
);

CREATE INDEX IF NOT EXISTS progress_lang ON progress (lang, student_id);
"""


@contextlib.contextmanager
def connect(path=None):
    conn = sqlite3.connect(path or DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init(path=None):
    with connect(path) as conn:
        conn.executescript(SCHEMA)


def name_key(name):
    """Аня и аня — один и тот же ребёнок. NOCASE в SQLite кириллицу не сворачивает."""
    return " ".join(name.split()).casefold()


# ---------- дети ----------

def upsert_student(conn, name):
    now = time.time()
    key = name_key(name)
    conn.execute(
        "INSERT INTO students (name, name_key, created_at, last_seen) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(name_key) DO UPDATE SET last_seen = excluded.last_seen",
        (name.strip(), key, now, now),
    )
    row = conn.execute("SELECT * FROM students WHERE name_key = ?", (key,)).fetchone()
    return row


def delete_student(conn, name):
    """Убирает ребёнка целиком: строку, прогресс и решения на обоих языках.

    Каскад по внешним ключам делает это сам — `PRAGMA foreign_keys = ON`
    стоит в connect(). Возвращает имя, как оно было записано, или None,
    если такого ребёнка нет.

    Языки не разделяются намеренно: решения на Python — это то, что
    ребёнок увидит рядом с задачей на занятии по C#. Удалить половину
    ребёнка значит тихо сломать вторую половину курса.
    """
    key = name_key(name)
    row = conn.execute("SELECT name FROM students WHERE name_key = ?", (key,)).fetchone()
    if row is None:
        return None
    conn.execute("DELETE FROM students WHERE name_key = ?", (key,))
    return row["name"]


def touch_activity(conn, student_id, lang, task_id):
    """Запоминает, на какой задаче ребёнок сидит сейчас и с какого момента.

    Время нужно только для страницы тьютора. Детям оно нигде не показывается.
    """
    now = time.time()
    row = conn.execute(
        "SELECT last_task_id FROM students WHERE id = ?", (student_id,)
    ).fetchone()
    same = row is not None and row["last_task_id"] == task_id
    conn.execute(
        "UPDATE students SET last_seen = ?, last_lang = ?, last_task_id = ?, "
        "last_task_since = CASE WHEN ? THEN last_task_since ELSE ? END WHERE id = ?",
        (now, lang, task_id, 1 if same else 0, now, student_id),
    )


# ---------- прогресс и решения ----------

def save_progress(conn, student_id, lang, task_id, topic, solved, hints, code):
    """Идемпотентно: повторная отправка того же результата ничего не ломает.

    Решённая задача обратно в нерешённые не уходит, время сдачи не переписывается.
    """
    now = time.time()
    conn.execute(
        "INSERT INTO progress (student_id, lang, task_id, topic, solved, hints, attempts, first_seen, solved_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) "
        "ON CONFLICT(student_id, lang, task_id) DO UPDATE SET "
        "  solved    = MAX(progress.solved, excluded.solved),"
        "  hints     = MAX(progress.hints, excluded.hints),"
        "  attempts  = progress.attempts + 1,"
        "  topic     = excluded.topic,"
        "  solved_at = COALESCE(progress.solved_at, excluded.solved_at)",
        (student_id, lang, task_id, topic, 1 if solved else 0, hints, now, now if solved else None),
    )
    if code is not None:
        conn.execute(
            "INSERT INTO solutions (student_id, lang, task_id, code, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(student_id, lang, task_id) DO UPDATE SET "
            "  code = excluded.code, updated_at = excluded.updated_at",
            (student_id, lang, task_id, code, now),
        )


def get_solution(conn, name, lang, task_id):
    """Решение ребёнка по имени и id задачи — связка занятий Python и C#."""
    row = conn.execute(
        "SELECT s.code, s.updated_at FROM solutions s "
        "JOIN students st ON st.id = s.student_id "
        "WHERE st.name_key = ? AND s.lang = ? AND s.task_id = ?",
        (name_key(name), lang, task_id),
    ).fetchone()
    return row


# ---------- таблица группы ----------

def board(conn, lang, limit, offset):
    """Строки таблицы. Два запроса на всю группу, без запроса на ребёнка."""
    rows = conn.execute(
        "SELECT s.id, s.name, s.last_seen, s.last_task_id, s.last_task_since,"
        "       COALESCE(SUM(p.solved), 0) AS solved,"
        "       COALESCE(SUM(p.hints), 0)  AS hints "
        "FROM students s "
        "LEFT JOIN progress p ON p.student_id = s.id AND p.lang = ? "
        "GROUP BY s.id "
        "ORDER BY solved DESC, s.name COLLATE NOCASE "
        "LIMIT ? OFFSET ?",
        (lang, limit, offset),
    ).fetchall()

    ids = [r["id"] for r in rows]
    by_topic = {}
    if ids:
        marks = ",".join("?" * len(ids))
        for r in conn.execute(
            "SELECT student_id, topic, COUNT(*) AS done FROM progress "
            "WHERE lang = ? AND solved = 1 AND student_id IN (" + marks + ") "
            "GROUP BY student_id, topic",
            [lang] + ids,
        ):
            by_topic.setdefault(r["student_id"], {})[r["topic"]] = r["done"]

    total = conn.execute("SELECT COUNT(*) AS n FROM students").fetchone()["n"]
    return rows, by_topic, total
