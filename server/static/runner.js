// Запуск Python в браузере через Skulpt + перевод ошибок на человеческий язык.
// Сервер здесь не участвует: проверка работает и без сети.

(function (global) {
  'use strict';

  var EXEC_LIMIT_MS = 2500; // защита от бесконечного цикла
  var MAX_STEPS = 600;      // столько шагов хватает любому примеру теории

  function builtinRead(path) {
    if (!global.Sk.builtinFiles || !global.Sk.builtinFiles.files[path]) {
      throw new Error("Модуль не найден: '" + path + "'");
    }
    return global.Sk.builtinFiles.files[path];
  }

  // Skulpt настраивается заново перед каждым запуском: это заодно
  // сбрасывает отсчёт лимита времени.
  // debugging включает остановку перед каждой строкой — на нём держится
  // пошаговый режим. Компилятор смотрит на этот флаг в момент разбора кода,
  // поэтому configure обязан отработать до importMainWithBody.
  function configure(onOutput, debugging) {
    global.Sk.configure({
      output: onOutput,
      read: builtinRead,
      execLimit: EXEC_LIMIT_MS,
      killableWhile: true,
      killableFor: true,
      debugging: !!debugging,
      __future__: global.Sk.python3,
      inputfun: function () {
        throw new global.Sk.builtin.Exception('input() здесь не работает — данные приходят в аргументах функции');
      },
      inputfunTakesPrompt: true
    });
  }

  // ---------- значения ----------

  // Печатает значение так, как его показал бы Python.
  function pyRepr(value) {
    if (value === true) return 'True';
    if (value === false) return 'False';
    if (value === null || value === undefined) return 'None';
    if (typeof value === 'string') return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return '[' + value.map(pyRepr).join(', ') + ']';
    if (typeof value === 'object') {
      var parts = Object.keys(value).map(function (k) { return pyRepr(k) + ': ' + pyRepr(value[k]); });
      return '{' + parts.join(', ') + '}';
    }
    return String(value);
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') {
      if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
      return Math.abs(a - b) < 1e-9;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var j = 0; j < ka.length; j++) {
        if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
        if (!deepEqual(a[ka[j]], b[ka[j]])) return false;
      }
      return true;
    }
    return false;
  }

  // ---------- ошибки ----------

  function errName(e) {
    if (e && e.tp$name) return e.tp$name;
    if (e && e.constructor && e.constructor.name) return e.constructor.name;
    return 'Error';
  }

  function errText(e) {
    try {
      if (e && e.args && e.args.v && e.args.v.length) {
        return String(global.Sk.ffi.remapToJs(e.args.v[0]));
      }
    } catch (ignored) { /* дальше пробуем toString */ }
    return e && e.message ? String(e.message) : String(e);
  }

  function errLine(e) {
    if (e && e.traceback && e.traceback.length) {
      for (var i = 0; i < e.traceback.length; i++) {
        if (typeof e.traceback[i].lineno === 'number') return e.traceback[i].lineno;
      }
    }
    if (typeof e.$lineno === 'number') return e.$lineno;
    return null;
  }

  var QUOTED = /['"`]([^'"`]+)['"`]/;

  // Превращает ошибку Skulpt в понятный русский текст.
  // Голый traceback ребёнку не показываем.
  function humanize(e) {
    if (e && e.message === '__timeout__') {
      return { line: null, text: 'Программа выполняется слишком долго. Скорее всего, цикл никогда не заканчивается — проверь его условие.' };
    }

    var name = errName(e);
    var raw = errText(e);
    var line = errLine(e);
    var quoted = (raw.match(QUOTED) || [])[1];
    var text;

    switch (name) {
      case 'TimeLimitError':
        line = null;
        text = 'Программа выполняется слишком долго. Скорее всего, цикл никогда не заканчивается — проверь его условие.';
        break;

      case 'NameError':
        text = quoted
          ? 'имя `' + quoted + '` не определено. Проверь, как ты назвал переменную выше, — возможно, здесь опечатка.'
          : 'используется имя, которого нет. Проверь написание переменных.';
        break;

      case 'SyntaxError':
      case 'ParseError':
      case 'IndentationError':
      case 'TokenError':
        text = syntaxHint(raw);
        break;

      case 'TypeError':
        text = typeHint(raw);
        break;

      case 'IndexError':
        text = 'в списке нет элемента с таким номером. Нумерация начинается с 0, последний элемент — под номером len(...) - 1.';
        break;

      case 'KeyError':
        text = quoted
          ? 'в словаре нет ключа ' + quoted + '. Проверь, что ключ туда действительно добавлен.'
          : 'в словаре нет такого ключа.';
        break;

      case 'ZeroDivisionError':
        text = 'деление на ноль. Проверь, что делитель не может стать нулём.';
        break;

      case 'ValueError':
        text = 'значение не подходит для этой операции. ' + raw;
        break;

      case 'AttributeError':
        text = 'у этого значения нет такого действия. ' + raw;
        break;

      case 'RecursionError':
        text = 'функция вызывает сама себя без остановки. Нужно условие, при котором она перестаёт себя вызывать.';
        break;

      case 'UnboundLocalError':
        text = quoted
          ? 'переменная `' + quoted + '` используется раньше, чем ей что-то присвоили.'
          : 'переменная используется раньше, чем ей что-то присвоили.';
        break;

      default:
        text = raw || 'непонятная ошибка при выполнении.';
    }

    return { line: line, text: text };
  }

  function syntaxHint(raw) {
    var low = raw.toLowerCase();
    if (low.indexOf('expected :') !== -1 || low.indexOf('bad token') !== -1) {
      return 'синтаксическая ошибка. После `if`, `elif`, `else` и `def` обязательно ставится двоеточие.';
    }
    if (low.indexOf('indent') !== -1) {
      return 'сбит отступ. Внутри `if` или `def` все строки должны быть сдвинуты вправо на одинаковое число пробелов (обычно 4).';
    }
    if (low.indexOf('eof') !== -1 || low.indexOf('unexpected end') !== -1) {
      return 'строка оборвалась. Скорее всего, не закрыта скобка или кавычка.';
    }
    return 'синтаксическая ошибка: Python не понял эту строку. Проверь двоеточие, скобки и кавычки.';
  }

  function typeHint(raw) {
    var low = raw.toLowerCase();
    if (low.indexOf('unsupported operand') !== -1 || low.indexOf('cannot concatenate') !== -1 || low.indexOf('for +') !== -1) {
      return 'нельзя соединить число и строку напрямую. Число превращают в строку через `str(...)`, строку в число — через `int(...)`.';
    }
    if (low.indexOf('argument') !== -1) {
      return 'функции передали не столько аргументов, сколько она ждёт. ' + raw;
    }
    if (low.indexOf('not callable') !== -1) {
      return 'так вызывать нельзя: это не функция. Проверь, не совпало ли имя переменной с именем функции.';
    }
    if (low.indexOf('nonetype') !== -1) {
      return 'функция вернула None вместо значения. Проверь, что во всех ветках стоит `return`.';
    }
    return 'значения не того типа для этой операции. ' + raw;
  }

  // ---------- выполнение ----------

  // Выполняет код и возвращает модуль. Печать собирается в out.
  function importModule(code, out) {
    configure(function (t) { out.push(t); });
    return global.Sk.misceval.asyncToPromise(function () {
      return global.Sk.importMainWithBody('<stdin>', false, code, true);
    });
  }

  // Просто выполнить код (для примеров в теории).
  function runSnippet(code) {
    var out = [];
    return importModule(code, out).then(
      function () { return { ok: true, output: out.join('') }; },
      function (e) { return { ok: false, output: out.join(''), error: humanize(e) }; }
    );
  }

  // Выполнить код и вызвать функцию entry с аргументами args.
  function callEntry(code, entry, args) {
    var out = [];
    return importModule(code, out).then(function (mod) {
      var fn = mod.$d[entry];
      if (fn === undefined) {
        return {
          ok: false,
          output: out.join(''),
          error: { line: null, text: 'в коде нет функции `' + entry + '`. Имя должно совпадать в точности — проверь строку с `def`.' }
        };
      }
      if (!global.Sk.builtin.checkCallable(fn)) {
        return {
          ok: false,
          output: out.join(''),
          error: { line: null, text: '`' + entry + '` — это не функция, а переменная. Функция объявляется через `def ' + entry + '(...)`.' }
        };
      }
      var pyArgs = args.map(function (a) { return global.Sk.ffi.remapToPy(a); });
      return global.Sk.misceval.asyncToPromise(function () {
        return global.Sk.misceval.callsimOrSuspendArray(fn, pyArgs);
      }).then(function (res) {
        return { ok: true, output: out.join(''), value: global.Sk.ffi.remapToJs(res) };
      });
    }).catch(function (e) {
      return { ok: false, output: out.join(''), error: humanize(e) };
    });
  }

  // ---------- пошаговое выполнение ----------

  // Служебные имена, которые Python заводит сам. Ребёнку в «коробках»
  // им не место.
  var HOUSEKEEPING = { __name__: 1, __doc__: 1, __package__: 1, __file__: 1, __builtins__: 1 };

  // Skulpt переименовывает переменные, чьи имена заняты в JavaScript:
  // `name` внутри становится `name_$rw$`. Ребёнку показываем исходное имя.
  function unmangle(key) { return key.replace(/_\$rw\$$/, ''); }

  // Снимок «коробок» на текущем шаге. Функции пропускаем: коробкой
  // со значением их называть рано, про def теория говорит отдельно.
  function readVars(loc) {
    var vars = [];
    if (!loc) return vars;
    Object.keys(loc).forEach(function (key) {
      if (key.charAt(0) === '$') return;
      if (HOUSEKEEPING[key]) return;
      var value = loc[key];
      try {
        if (global.Sk.builtin.checkCallable(value)) return;
        vars.push({ name: unmangle(key), value: pyRepr(global.Sk.ffi.remapToJs(value)) });
      } catch (ignored) {
        /* значение не переводится в JS — показывать нечего */
      }
    });
    return vars;
  }

  var CANCELLED = { cancelled: true };
  var TOO_LONG = { tooLong: true };

  // Выполняет код, останавливаясь перед каждой строкой.
  //
  // onStep(info, resume) зовётся перед выполнением строки: info.line —
  // номер этой строки, info.vars — что уже лежит в коробках, info.output —
  // что уже напечатано. Пока не вызовут resume, программа стоит.
  //
  // Возвращает пульт: finished — промис с итогом, fast() — досчитать
  // без остановок, cancel() — прекратить. И то и другое срабатывает
  // на следующем resume.
  function stepSnippet(code, onStep) {
    var out = [];
    var steps = 0;
    var control = { fast: false, cancelled: false };

    configure(function (t) { out.push(t); }, true);

    var finished = global.Sk.misceval.asyncToPromise(function () {
      return global.Sk.importMainWithBody('<stdin>', false, code, true);
    }, {
      'Sk.debug': function (susp) {
        return new Promise(function (resolve, reject) {
          function resume() {
            // Лимит времени считается от старта программы, а между шагами
            // ребёнок думает сколько хочет. Без сброса защита от вечного
            // цикла срабатывала бы на ровном месте.
            global.Sk.execStart = new Date();
            resolve(susp.resume());
          }

          if (control.cancelled) return reject(CANCELLED);
          if (++steps > MAX_STEPS) return reject(TOO_LONG);
          if (control.fast) return resume();

          // Номер строки и значения лежат на вложенном кадре, а не на самой
          // приостановке: у неё только data и ссылка на ребёнка.
          var frame = susp.child || susp;
          onStep({
            line: typeof frame.$lineno === 'number' ? frame.$lineno : null,
            vars: readVars(frame.$loc),
            output: out.join(''),
            step: steps
          }, resume);
        });
      }
    }).then(function () {
      return { ok: true, done: true, output: out.join('') };
    }, function (e) {
      if (e === CANCELLED) return { cancelled: true, output: out.join('') };
      if (e === TOO_LONG) {
        return {
          tooLong: true, output: out.join(''),
          error: { line: null, text: 'в этом примере слишком много шагов, чтобы пройти его по одному. Запусти его целиком.' }
        };
      }
      return { ok: false, output: out.join(''), error: humanize(e) };
    });

    return {
      finished: finished,
      fast: function () { control.fast = true; },
      cancel: function () { control.cancelled = true; }
    };
  }

  global.Runner = {
    runSnippet: runSnippet,
    stepSnippet: stepSnippet,
    callEntry: callEntry,
    pyRepr: pyRepr,
    deepEqual: deepEqual,
    humanize: humanize,
    EXEC_LIMIT_MS: EXEC_LIMIT_MS
  };
})(window);
