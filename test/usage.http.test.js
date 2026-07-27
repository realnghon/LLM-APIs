'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'password' }),
  });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('successful proxy calls appear in authenticated usage records', async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-usage', object: 'chat.completion', model: 'model-a',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const account = {
    id: 'tracked', name: 'Tracked',
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    api_key: 'key', models: ['model-a'], priority: 1, weight: 1, enabled: true,
  };
  const logs = [];
  const usageRepository = {
    record: async entry => { logs.unshift(entry); },
    list: async () => logs,
    clear: async () => { logs.length = 0; },
  };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => [account] },
    usageRepository,
  }));
  t.after(app.close);

  const proxyResponse = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(proxyResponse.status, 200);
  await proxyResponse.text();

  const cookie = await login(app.baseUrl);
  const usageResponse = await fetch(`${app.baseUrl}/admin/usage?limit=25&offset=0`, {
    headers: { Cookie: cookie },
  });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.total, 1);
  assert.equal(usage.logs[0].account_name, 'Tracked');
  assert.equal(usage.logs[0].requested_model, 'model-a');
  assert.equal(usage.logs[0].status, 200);
});
