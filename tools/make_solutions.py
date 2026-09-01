# -*- coding: utf-8 -*-
"""Собирает шпаргалку тьютора: все эталонные решения обоих языков в один файл.

    python tools/make_solutions.py

Файл генерируется из content/, а не пишется руками: решения там уже есть,
и любая вторая копия рано или поздно разойдётся с первой. Перегенерировать
после каждой правки задач.

Результат кладётся в docs/, а не в server/static — иначе сервер начнёт
раздавать решения детям.
"""

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONTENT = os.path.join(ROOT, "content")
OUT = os.path.join(ROOT, "docs", "РЕШЕНИЯ.md")

TOPIC_ORDER = [
    "basics", "conditions", "loops-for", "loops-while",
    "lists", "strings", "functions", "dicts",
]


def load(lang, topic):
    path = os.path.join(CONTENT, lang, topic + ".json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    out = []
    out.append("# Решения")
    out.append("")
    out.append("Шпаргалка тьютора: эталонные решения всех задач, Python и C# рядом.")
    out.append("Детям этот файл не показывается и сервером не раздаётся.")
    out.append("")
    out.append("Файл собран автоматически. Не править руками — правки уйдут")
    out.append("при следующем запуске `python tools/make_solutions.py`.")
    out.append("Источник — `content/`.")
    out.append("")

    # Оглавление: восемь тем в учебном порядке, а не в алфавитном.
    out.append("## Темы")
    out.append("")
    for i, topic in enumerate(TOPIC_ORDER, 1):
        data = load("python", topic)
        anchor = data["title"].lower().replace(" ", "-").replace(",", "")
        out.append("%d. [%s](#%d-%s)" % (i, data["title"], i, anchor))
    out.append("")

    total = 0
    for i, topic in enumerate(TOPIC_ORDER, 1):
        py = load("python", topic)
        cs = load("csharp", topic)
        cs_by_id = {t["id"]: t for t in cs["tasks"]}

        out.append("---")
        out.append("")
        out.append("## %d. %s" % (i, py["title"]))
        out.append("")
        out.append("*%s*" % py["subtitle"])
        out.append("")

        for task in py["tasks"]:
            total += 1
            twin = cs_by_id[task["id"]]
            out.append("### `%s` — %s" % (task["id"], task["title"]))
            out.append("")
            for line in task["statement"].strip().splitlines():
                out.append(line)
            out.append("")

            # must_call — список имён, даже когда оно одно.
            must = task.get("must_call") or []
            if isinstance(must, str):
                must = [must]
            if must:
                out.append("Обязана вызывать: %s." % ", ".join("`%s`" % n for n in must))
                out.append("")

            hidden = [t for t in task["tests"] if t.get("hidden")]
            if hidden:
                args = ", ".join(json.dumps(a, ensure_ascii=False) for a in hidden[0]["args"])
                out.append("Скрытый тест: `%s(%s)` → `%s`" % (
                    task["entry"], args,
                    json.dumps(hidden[0]["expect"], ensure_ascii=False)))
                out.append("")

            out.append("**Python**")
            out.append("")
            out.append("```python")
            out.append(task["solution"].rstrip())
            out.append("```")
            out.append("")
            out.append("**C#**")
            out.append("")
            out.append("```csharp")
            out.append(twin["solution"].rstrip())
            out.append("```")
            out.append("")

    out.append("---")
    out.append("")
    out.append("Всего задач: %d, решений: %d." % (total, total * 2))
    out.append("")

    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))

    sys.stdout.write("Записано: %s (%d задач)\n" % (
        os.path.relpath(OUT, ROOT), total))


if __name__ == "__main__":
    main()
