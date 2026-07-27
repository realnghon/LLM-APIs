'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

const credentials = { username: 'admin', password: 'password' };

test('admin login protects the management interface with a session cookie', async t => {
  const handler = createHttpHandler({ credentials });
  const server = await startTestServer(handler);
  t.after(server.close);

  const anonymousPage = await fetch(`${server.baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(anonymousPage.status, 302);
  assert.equal(anonymousPage.headers.get('location'), '/login');

  const anonymousApi = await fetch(`${server.baseUrl}/admin/accounts`);
  assert.equal(anonymousApi.status, 401);
  assert.deepEqual(await anonymousApi.json(), { success: false, error: 'Unauthorized' });

  const rejected = await fetch(`${server.baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
  });
  assert.equal(rejected.status, 401);

  const accepted = await fetch(`${server.baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(credentials),
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get('location'), '/admin');
  const cookie = accepted.headers.get('set-cookie');
  assert.match(cookie, /^llm_admin_session=[^;]+;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const authenticated = await fetch(`${server.baseUrl}/admin`, {
    headers: { Cookie: cookie.split(';', 1)[0] },
  });
  assert.equal(authenticated.status, 200);
  assert.match(await authenticated.text(), /账号管理/);
});
