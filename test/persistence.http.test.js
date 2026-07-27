'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

const credentials = { username: 'admin', password: 'password' };

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(credentials),
  });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('accounts persist across application restarts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apis-'));
  const dataFile = path.join(directory, 'kv.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const first = await startTestServer(createHttpHandler({ credentials, dataFile }));
  const firstCookie = await login(first.baseUrl);
  const created = await fetch(`${first.baseUrl}/admin/accounts`, {
    method: 'POST',
    headers: { Cookie: firstCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Persistent',
      base_url: 'https://example.com/v1',
      api_key: 'secret',
      models: ['model-a'],
    }),
  });
  assert.equal(created.status, 200);
  await first.close();
  const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.match(String(stored.accounts), /Persistent/);

  const second = await startTestServer(createHttpHandler({ credentials, dataFile }));
  t.after(second.close);
  const secondCookie = await login(second.baseUrl);
  const listed = await fetch(`${second.baseUrl}/admin/accounts`, {
    headers: { Cookie: secondCookie },
  });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].name, 'Persistent');
});
