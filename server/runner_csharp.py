# -*- coding: utf-8 -*-
"""Компиляция и запуск C# на машине тьютора.

Это НЕ песочница. Расчёт на детей и случайные бесконечные циклы, а не
на злонамеренный код: процесс просто ограничен по времени, вывод обрезается,
работа идёт во временной папке.

Скорость. Каждая проверка — это вызов компилятора, и холодная сборка занимает
несколько секунд. Поэтому проекты не создаются заново: держим небольшой пул
готовых папок, в них подменяется только Program.cs, и сборка идёт инкрементально.
Пул заодно ограничивает, сколько компиляций идёт одновременно.
"""

import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time

RUN_TIMEOUT = 10        # столько живёт программа ребёнка
BUILD_TIMEOUT = 90      # первая сборка на холодной машине бывает долгой
OUTPUT_LIMIT = 10 * 1024
POOL_SIZE = 4

WORK_ROOT = os.path.join(tempfile.gettempdir(), "terminal-csharp")

CSPROJ = """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>{tfm}</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
    <AssemblyName>task</AssemblyName>
    <RootNamespace>task</RootNamespace>
    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>
    <NoWarn>CS0168;CS0219</NoWarn>
  </PropertyGroup>
</Project>
"""

# Пометки, по которым разбирается вывод. Ребёнок их не видит.
MARK_OK = "<<T{}>>"
MARK_ERR = "<<E{}>>"

_pool = None
_pool_lock = threading.Lock()
_tfm = None


# ---------------------------------------------------------------- окружение

_exe = False


def dotnet_exe():
    """Путь к dotnet.

    Обычная установка кладёт его в PATH. Но на школьном ноутбуке прав
    администратора может не быть, и тогда SDK ставят скриптом в папку
    пользователя — туда PATH не смотрит. Проверяем оба места.
    """
    global _exe
    if _exe is not False:
        return _exe

    found = shutil.which("dotnet")
    if not found:
        home = os.path.expanduser("~")
        for candidate in (os.path.join(home, ".dotnet", "dotnet.exe"),
                          os.path.join(home, ".dotnet", "dotnet")):
            if os.path.exists(candidate):
                found = candidate
                break
    _exe = found
    return _exe


def dotnet_available():
    return dotnet_exe() is not None


def dotnet_version():
    exe = dotnet_exe()
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def target_framework():
    """Берём фреймворк под установленный SDK, а не прибитый гвоздями net8.0."""
    global _tfm
    if _tfm:
        return _tfm
    _tfm = "net8.0"
    if not dotnet_exe():
        return _tfm
    try:
        out = subprocess.run([dotnet_exe(), "--list-sdks"], capture_output=True, text=True, timeout=30)
        majors = []
        for line in out.stdout.splitlines():
            m = re.match(r"\s*(\d+)\.", line)
            if m:
                majors.append(int(m.group(1)))
        if majors:
            _tfm = "net{}.0".format(max(majors))
    except (OSError, subprocess.SubprocessError):
        pass
    return _tfm


# ---------------------------------------------------------------- пул проектов

def _make_project(path):
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "task.csproj"), "w", encoding="utf-8") as f:
        f.write(CSPROJ.format(tfm=target_framework()))
    with open(os.path.join(path, "Program.cs"), "w", encoding="utf-8") as f:
        f.write("class Program { static void Main() { } }\n")
    return path


def _get_pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = queue.Queue()
            for i in range(POOL_SIZE):
                _pool.put(_make_project(os.path.join(WORK_ROOT, "slot{}".format(i))))
    return _pool


def warmup():
    """Первая сборка долгая. Прогреваем на старте, чтобы не ждать на занятии."""
    if not dotnet_available():
        return False
    pool = _get_pool()
    path = pool.get()
    try:
        subprocess.run([dotnet_exe(), "build", "-v", "quiet", "--nologo"],
                       cwd=path, capture_output=True, text=True, timeout=BUILD_TIMEOUT)
        return True
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        pool.put(path)


# ---------------------------------------------------------------- сборка файла

def _cs_string(value):
    out = value.replace("\\", "\\\\").replace('"', '\\"')
    out = out.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return '"' + out + '"'


def cs_literal(value, kind):
    """Аргумент теста -> литерал C#. Тип берётся из signature задачи."""
    if kind == "int":
        return str(int(value))
    if kind == "long":
        return str(int(value)) + "L"
    if kind == "double":
        return repr(float(value))
    if kind == "bool":
        return "true" if value else "false"
    if kind == "string":
        return _cs_string(value)
    if kind == "int[]":
        return "new int[] { " + ", ".join(str(int(v)) for v in value) + " }"
    if kind == "string[]":
        return "new string[] { " + ", ".join(_cs_string(v) for v in value) + " }"
    if kind == "dict":
        pairs = ", ".join("{{ {}, {} }}".format(_cs_string(k), int(v)) for k, v in value.items())
        return "new System.Collections.Generic.Dictionary<string, int> { " + pairs + " }"
    raise ValueError("неизвестный тип аргумента: " + str(kind))


HARNESS_HELPERS = """
    static string TQuote(string s)
    {
        System.Text.StringBuilder b = new System.Text.StringBuilder();
        b.Append('"');
        foreach (char c in s)
        {
            if (c == '"') b.Append("\\\\\\"");
            else if (c == '\\\\') b.Append("\\\\\\\\");
            else if (c == '\\n') b.Append("\\\\n");
            else if (c == '\\r') b.Append("\\\\r");
            else if (c == '\\t') b.Append("\\\\t");
            else if (c < ' ') b.Append("\\\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        b.Append('"');
        return b.ToString();
    }

    static string TDump(object v)
    {
        if (v == null) return "null";
        if (v is bool) return ((bool)v) ? "true" : "false";
        if (v is string) return TQuote((string)v);
        if (v is char) return TQuote(v.ToString());
        if (v is int || v is long || v is short || v is byte) return v.ToString();
        if (v is double || v is float || v is decimal)
            return System.Convert.ToDouble(v).ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (v is System.Collections.IDictionary)
        {
            System.Collections.IDictionary d = (System.Collections.IDictionary)v;
            System.Text.StringBuilder b = new System.Text.StringBuilder();
            b.Append('{');
            bool first = true;
            foreach (object k in d.Keys)
            {
                if (!first) b.Append(", ");
                first = false;
                b.Append(TQuote(k.ToString())).Append(": ").Append(TDump(d[k]));
            }
            b.Append('}');
            return b.ToString();
        }
        if (v is System.Collections.IEnumerable)
        {
            System.Text.StringBuilder b = new System.Text.StringBuilder();
            b.Append('[');
            bool first = true;
            foreach (object item in (System.Collections.IEnumerable)v)
            {
                if (!first) b.Append(", ");
                first = false;
                b.Append(TDump(item));
            }
            b.Append(']');
            return b.ToString();
        }
        return TQuote(v.ToString());
    }
"""


def build_source(user_code, task):
    """Код ребёнка + вызовы тестов, вставленные перед его последней скобкой.

    Код ребёнка идёт первым и не сдвигается ни на строку, поэтому номера строк
    в ошибках компилятора совпадают с тем, что он видит в редакторе.
    """
    signature = task.get("signature") or {}
    arg_types = signature.get("args", [])
    entry = task["entry"]

    lines = ["", "    static void Main()", "    {"]
    lines.append("        System.Console.OutputEncoding = System.Text.Encoding.UTF8;")
    for i, test in enumerate(task["tests"]):
        args = ", ".join(cs_literal(v, arg_types[j]) for j, v in enumerate(test["args"]))
        call = "{}({})".format(entry, args)
        lines.append("        try {{ System.Console.WriteLine({} + TDump({})); }}".format(
            _cs_string(MARK_OK.format(i)), call))
        lines.append("        catch (System.Exception ex) {{ System.Console.WriteLine({} + ex.GetType().Name + \": \" + ex.Message); }}".format(
            _cs_string(MARK_ERR.format(i))))
    lines.append("    }")
    lines.append(HARNESS_HELPERS)

    harness = "\n".join(lines) + "\n"

    cut = user_code.rfind("}")
    if cut == -1:
        # Скобки не закрыты: пусть об этом скажет компилятор, а не мы.
        return user_code + "\n" + harness

    return user_code[:cut] + harness + user_code[cut:]


# ---------------------------------------------------------------- ошибки компилятора

ERROR_RE = re.compile(r"(?P<file>[^(\n]*Program\.cs)\((?P<line>\d+),(?P<col>\d+)\)\s*:\s*"
                      r"(?P<kind>error|warning)\s+(?P<code>CS\d+)\s*:\s*(?P<msg>[^\[\n]*)")

# Что означают самые частые сообщения компилятора — по-русски.
CS_HINTS = {
    "CS1002": "не хватает точки с запятой в конце строки.",
    "CS1513": "не хватает закрывающей фигурной скобки }.",
    "CS1514": "не хватает открывающей фигурной скобки {.",
    "CS0029": "типы не сходятся: нельзя положить значение одного типа в переменную другого.",
    "CS0266": "типы не сходятся: нужно явное преобразование.",
    "CS1061": "у этого значения нет такого метода или поля. Проверь написание.",
    "CS0103": "имя не найдено. Проверь, как ты назвал переменную выше.",
    "CS0161": "не во всех ветках есть return — добавь возврат значения в конце.",
    "CS0165": "переменная используется раньше, чем ей что-то присвоили.",
    "CS1503": "аргумент не того типа, какой ждёт метод.",
    "CS7036": "методу не хватает аргументов.",
    "CS0117": "у этого типа нет такого имени.",
    "CS0136": "переменная с таким именем уже есть в этой области.",
    "CS0106": "неуместный модификатор: решения пишутся как static-методы.",
    "CS8025": "лишняя или недостающая скобка рядом с этой строкой.",
}


def parse_build_errors(output, user_line_count):
    """Ошибки компилятора с номером строки в коде ребёнка.

    Заготовка с вызовами тестов приписана ПОСЛЕ его кода, поэтому строки
    внутри его кода не сдвигаются. Всё, что компилятор нашёл ниже, относится
    к заготовке — такие ошибки прикрепляем к последней строке ребёнка,
    чтобы не показывать ему чужой код.
    """
    errors = []
    seen = set()
    for m in ERROR_RE.finditer(output):
        if m.group("kind") != "error":
            continue
        line = int(m.group("line"))
        code = m.group("code")
        message = m.group("msg").strip()
        if line > user_line_count:
            line = user_line_count
        key = (line, code, message)
        if key in seen:
            continue
        seen.add(key)
        errors.append({
            "line": line,
            "code": code,
            "message": message,
            "hint": CS_HINTS.get(code, ""),
        })
    return errors


# ---------------------------------------------------------------- запуск

def _parse_output(text, count):
    """Разбирает помеченные строки. Всё остальное — то, что напечатал ребёнок."""
    values = {}
    errors = {}
    printed = []
    for line in text.splitlines():
        matched = False
        for i in range(count):
            if line.startswith(MARK_OK.format(i)):
                values[i] = line[len(MARK_OK.format(i)):]
                matched = True
                break
            if line.startswith(MARK_ERR.format(i)):
                errors[i] = line[len(MARK_ERR.format(i)):]
                matched = True
                break
        if not matched:
            printed.append(line)
    return values, errors, "\n".join(printed)


def _same(got, want):
    if isinstance(want, bool) or isinstance(got, bool):
        return got is want or got == want and isinstance(got, bool) == isinstance(want, bool)
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        return abs(got - want) < 1e-9
    return got == want


def run_tests(user_code, task):
    """Собирает и запускает решение. Возвращает результат по каждому тесту."""
    if not dotnet_available():
        return {"error": "На этой машине не найден .NET SDK — C# запускать нечем."}

    started = time.time()
    source = build_source(user_code, task)
    user_line_count = user_code.count("\n") + 1

    pool = _get_pool()
    path = pool.get()
    try:
        with open(os.path.join(path, "Program.cs"), "w", encoding="utf-8") as f:
            f.write(source)

        try:
            build = subprocess.run(
                [dotnet_exe(), "build", "-v", "quiet", "--nologo"],
                cwd=path, capture_output=True, text=True,
                timeout=BUILD_TIMEOUT, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            return {"error": "Компилятор не ответил вовремя. Попробуй ещё раз."}

        build_sec = time.time() - started

        if build.returncode != 0:
            errors = parse_build_errors((build.stdout or "") + (build.stderr or ""), user_line_count)
            if not errors:
                errors = [{"line": None, "code": "", "message": "Программа не собралась.", "hint": ""}]
            return {"compile_errors": errors, "build_sec": round(build_sec, 2)}

        exe = os.path.join(path, "bin", "Debug", target_framework(), "task.dll")
        try:
            run = subprocess.run(
                [dotnet_exe(), exe], cwd=path, capture_output=True, text=True,
                timeout=RUN_TIMEOUT, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            return {
                "timeout": True,
                "build_sec": round(build_sec, 2),
                "error": "Программа выполняется слишком долго. Скорее всего, цикл никогда "
                         "не заканчивается — проверь его условие.",
            }

        text = (run.stdout or "")[:OUTPUT_LIMIT]
        values, errors, printed = _parse_output(text, len(task["tests"]))

        results = []
        for i, test in enumerate(task["tests"]):
            if i in errors:
                results.append({"pass": False, "error": errors[i], "want": test["expect"]})
                continue
            if i not in values:
                results.append({"pass": False, "error": "тест не выполнился", "want": test["expect"]})
                continue
            try:
                got = json.loads(values[i])
            except ValueError:
                results.append({"pass": False, "error": "непонятный ответ", "want": test["expect"]})
                continue
            results.append({"pass": _same(got, test["expect"]), "got": got, "want": test["expect"]})

        return {
            "tests": results,
            "printed": printed[:OUTPUT_LIMIT],
            "build_sec": round(build_sec, 2),
            "total_sec": round(time.time() - started, 2),
        }
    finally:
        pool.put(path)


def run_snippet(code):
    """Запуск примера из теории: как есть, без вызовов тестов."""
    if not dotnet_available():
        return {"error": "На этой машине не найден .NET SDK — C# запускать нечем."}

    pool = _get_pool()
    path = pool.get()
    try:
        with open(os.path.join(path, "Program.cs"), "w", encoding="utf-8") as f:
            f.write(code)
        try:
            build = subprocess.run([dotnet_exe(), "build", "-v", "quiet", "--nologo"],
                                   cwd=path, capture_output=True, text=True,
                                   timeout=BUILD_TIMEOUT, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            return {"error": "Компилятор не ответил вовремя."}

        if build.returncode != 0:
            errors = parse_build_errors((build.stdout or "") + (build.stderr or ""),
                                        code.count("\n") + 1)
            return {"compile_errors": errors}

        exe = os.path.join(path, "bin", "Debug", target_framework(), "task.dll")
        try:
            run = subprocess.run([dotnet_exe(), exe], cwd=path, capture_output=True, text=True,
                                 timeout=RUN_TIMEOUT, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            return {"error": "Программа выполняется слишком долго — проверь условие цикла."}
        return {"printed": (run.stdout or "")[:OUTPUT_LIMIT]}
    finally:
        pool.put(path)
