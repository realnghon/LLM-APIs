'use strict';

function renderLoginPage(hasError = false) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 - LLM-APIs</title>
  <link rel="stylesheet" href="/assets/login.css">
</head>
<body>
  <main class="login-shell">
    <div class="login-brand"><span>LA</span><span>LLM-APIs</span></div>
    <form class="login-form" method="post" action="/login">
      <h1>登录管理后台</h1>
      ${hasError ? '<p class="error" role="alert">用户名或密码错误</p>' : ''}
      <label>用户名<input name="username" autocomplete="username" required autofocus></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
}

module.exports = { renderLoginPage };
