// Вход для тьютора. Страница отдаётся по тому же адресу, что просили,
// поэтому после успешного входа хватает перезагрузки.

(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var input = document.getElementById('password');
  var hint = document.getElementById('login-hint');
  var btn = document.getElementById('login-btn');

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var password = input.value;
    if (!password) {
      input.focus();
      return;
    }

    btn.disabled = true;
    Net.send('/api/login', { password: password }).then(function () {
      location.reload();
    }, function (e) {
      btn.disabled = false;
      hint.textContent = e.offline
        ? 'Сервер не отвечает. Проверь, что он запущен.'
        : 'Пароль не подходит.';
      hint.classList.add('is-bad');
      input.value = '';
      input.focus();
    });
  });

  input.focus();
})();
