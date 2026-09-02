# -*- coding: utf-8 -*-
"""Одна команда для тьютора: ставит зависимости, собирает версию для
флешки, запускает сервер.

    python start.py

Короткий гайд — ТЬЮТОРУ.md. Технические подробности — README.md.

Каждый шаг можно выполнить и по отдельности (см. README), но тьютору,
который просто хочет провести занятие, отдельные шаги не нужны — нужен
один способ ничего не перепутать.
"""

import importlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def step(text):
    print("\n== " + text)


# ---------------------------------------------------------------- зависимости

def ensure_dependencies():
    """Ставит fastapi/uvicorn/pydantic при первом запуске. Дальше не нужно —
    один раз поставились и остаются, интернет для этого шага нужен только
    в первый раз."""
    step("Проверяю библиотеки Python")
    missing = []
    for mod in ("fastapi", "uvicorn", "pydantic"):
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append(mod)

    if not missing:
        print("   всё на месте")
        return

    print("   не хватает: {} — ставлю через pip (нужен интернет)".format(", ".join(missing)))
    req = os.path.join(HERE, "requirements.txt")
    code = subprocess.call([sys.executable, "-m", "pip", "install", "-q", "-r", req])
    if code != 0:
        raise SystemExit(
            "\nНе получилось поставить зависимости через pip.\n"
            "Проверь интернет и поставь вручную:\n"
            "    pip install -r requirements.txt")
    print("   поставлено")


# ---------------------------------------------------------------- офлайн-версия

def build_offline():
    """Пересобирает версию для флешки при каждом запуске: так она никогда
    не расходится с тем, что видят дети по адресу."""
    step("Собираю версию для флешки (запасной вариант, если сеть подведёт)")
    tools_dir = os.path.join(HERE, "tools")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    try:
        import build_offline as offline_builder
    except ImportError as e:
        print("   пропущено: сборщик не найден ({})".format(e))
        return

    try:
        offline_builder.main()
    except SystemExit as e:
        # Сборщик сам объясняет причину. Незачем ронять запуск сервера
        # из-за того, что офлайн-версия не собралась, — онлайн важнее.
        print("   пропущено: {}".format(e))


# ---------------------------------------------------------------- сервер

def main():
    ensure_dependencies()
    build_offline()

    step("Запускаю сервер")
    server_dir = os.path.join(HERE, "server")
    if server_dir not in sys.path:
        sys.path.insert(0, server_dir)

    # Вся логика запуска (адрес, прогрев C#, открытие браузера) живёт
    # в server/app.py — здесь её незачем повторять, только звать.
    import app as server_app
    server_app.main()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
