'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

test('independent account call allowance blocks requests after it is consumed', async t => {
  let upstreamRequests = 0;
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests += 1;
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-quota', object: 'chat.completion', model: 'model-a',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const account = {
    id: 'limited', name: 'Limited',
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    api_key: 'key', models: ['model-a'], priority: 1, weight: 1, enabled: true,
    allowance: { type: 'total', quota_mode: 'count', quota_total: 1, remaining: 1 },
  };
  const accountRepository = {
    list: async () => [account],
    debitAllowance: async (_id, amount) => { account.allowance.remaining -= amount; },
  };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository,
  }));
  t.after(app.close);

  const call = () => fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }),
  });

  const first = await call();
  assert.equal(first.status, 200);
  await first.text();
  const second = await call();
  assert.equal(second.status, 503);
  assert.equal(upstreamRequests, 1);
});
