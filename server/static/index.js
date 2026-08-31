// Вход: имя один раз, дальше оно живёт в localStorage.
// Регистрации и паролей нет.

(function () {
  'use strict';

  var form = document.getElementById('gate-form');
  var input = document.getElementById('name');
  var hint = document.getElementById('gate-hint');

  Net.mountStatus(document.getElementById('gate-status'));

  input.value = Net.name();

  // Первая доступная тема курса — туда и отправляем.
  function firstTopic(lang) {
    return Net.get('/api/topics/' + lang).then(function (data) {
      var ready = data.topics.filter(function (t) { return t.ready; });
      return ready.length ? ready[0].topic : null;
    }, function () {
      return 'conditions';   // сервер молчит — открываем первую готовую тему
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var lang = (ev.submitter && ev.submitter.dataset.lang) || 'python';
    var name = input.value.trim().replace(/\s+/g, ' ');

    if (!name) {
      hint.textContent = 'Впиши имя — по нему сайт узнает тебя на следующем занятии.';
      hint.classList.add('is-bad');
      input.focus();
      return;
    }

    hint.classList.remove('is-bad');
    Net.setName(name);
    Net.push('/api/session', { name: name });

    firstTopic(lang).then(function (topic) {
      if (!topic) {
        hint.textContent = 'Для этого языка тем пока нет.';
        hint.classList.add('is-bad');
        return;
      }
      location.href = '/topic?lang=' + lang + '&topic=' + topic;
    });
  });

  input.focus();
})();
