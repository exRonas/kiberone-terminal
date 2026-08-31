# -*- coding: utf-8 -*-
"""Временный статический сервер для шага 1.

Страница берёт задачи из content/ через fetch, а браузер запрещает fetch
для file://. Поэтому даже на шаге «без сервера» нужен кто-то, кто отдаёт файлы.

На шаге 2 этот скрипт заменит настоящий сервер на FastAPI: он будет отдавать
ту же статику плюс прогресс и таблицу группы.

    python tools/serve_dev.py
"""

import http.server
import os
import socket
import socketserver
import webbrowser

PORT = 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
START_PAGE = "/server/static/topic.html?lang=python&topic=conditions"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # В классе занятие идёт по одному файлу, кеш только мешает.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # консоль нужна для адреса, а не для лога запросов


def local_ip():
    """Адрес машины в классной сети, а не 127.0.0.1."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        url = "http://{}:{}{}".format(local_ip(), PORT, START_PAGE)
        line = "http://{}:{}".format(local_ip(), PORT)
        print()
        print("=" * 52)
        print("  ТЕРМИНАЛ")
        print()
        print("  Дети открывают:   " + line)
        print("=" * 52)
        print()
        print("Остановить: Ctrl+C")
        webbrowser.open("http://127.0.0.1:{}{}".format(PORT, START_PAGE))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nОстановлено.")


if __name__ == "__main__":
    main()
