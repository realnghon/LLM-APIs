'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'password' }),
  });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('account connectivity check uses the configured OpenAI-compatible model', async t => {
  let requestBody;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-sdk',
      object: 'chat.completion',
      created: 1,
      model: requestBody.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const accounts = [{
    id: 'account-1',
    name: 'SDK Account',
    base_url: upstreamUrl,
    api_key: 'test-key',
    format: 'openai',
    models: ['model-a'],
    priority: 1,
    weight: 1,
    enabled: true,
  }];
  const accountRepository = { list: async () => accounts };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository,
  }));
  t.after(app.close);
  const cookie = await login(app.baseUrl);

  const response = await fetch(`${app.baseUrl}/admin/accounts/test`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'account-1', testIndices: [0] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].retries, 0);
  assert.equal(requestBody.model, 'model-a');
});
