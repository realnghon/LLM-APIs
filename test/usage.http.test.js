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
    model_prices: { 'model-a': { input: 2, output: 8 } },
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
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '::ffff:203.0.113.9' },
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
  assert.equal(usage.logs[0].input_tokens, 3);
  assert.equal(usage.logs[0].output_tokens, 2);
  assert.equal(usage.logs[0].total_tokens, 5);
  assert.equal(usage.logs[0].client_ip, '203.0.113.9');
  assert.equal(usage.logs[0].request_path, '/v1/chat/completions');
  assert.equal(usage.logs[0].attempts.length, 1);
  assert.equal(usage.logs[0].cost, 0.000022);
  assert.equal(usage.logs[0].first_token_ms, null);
});

test('streaming proxy records reasoning as the first token and final usage after completion', async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    await new Promise(resolve => setTimeout(resolve, 30));
    res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
    await new Promise(resolve => setTimeout(resolve, 120));
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    await new Promise(resolve => setTimeout(resolve, 30));
    res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const account = {
    id: 'streamed', name: 'Streamed', base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    api_key: 'key', models: ['model-a'], priority: 1, weight: 1, enabled: true,
  };
  const logs = [];
  const usageRepository = { record: async entry => logs.unshift(entry), list: async () => logs, clear: async () => {} };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => [account] }, usageRepository,
  }));
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });
  await response.text();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].input_tokens, 7);
  assert.equal(logs[0].output_tokens, 4);
  assert.equal(logs[0].first_token_ms >= 20, true);
  assert.equal(logs[0].first_token_ms < 100, true);
  assert.equal(logs[0].duration_ms - logs[0].first_token_ms >= 130, true);
});

test('usage stats include weekly trend, cumulative cost and rolling five-hour account totals', async t => {
  const now = Date.now();
  const logs = [
    { id: '1', account_name: 'A', requested_model: 'm', status: 200, input_tokens: 10, output_tokens: 5, cost: 0.1, created_at: new Date(now - 60 * 60_000).toISOString() },
    { id: '2', account_name: 'B', requested_model: 'm2', status: 200, input_tokens: 20, output_tokens: 4, cost: 0.2, created_at: new Date(now - 4 * 60 * 60_000).toISOString() },
    { id: '3', account_name: 'A', requested_model: 'm', status: 500, input_tokens: 30, output_tokens: 3, cost: 0.3, created_at: new Date(now - 6 * 60 * 60_000).toISOString() },
  ];
  const usageRepository = { record: async () => {}, list: async () => logs, clear: async () => {} };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => [] }, usageRepository,
  }));
  t.after(app.close);
  const cookie = await login(app.baseUrl);
  const response = await fetch(`${app.baseUrl}/admin/usage/stats?range=week`, { headers: { Cookie: cookie } });
  const body = await response.json();

  assert.equal(body.cumulative.total_cost, 0.6);
  assert.equal(body.recent5h.total_count, 2);
  assert.deepEqual(body.recent5h.byAccount.map(row => [row.name, row.input]), [['A', 10], ['B', 20]]);
  assert.equal(body.trend.range, 'week');
  assert.equal(body.trend.buckets.length, 7);
  assert.equal(body.trend.buckets.reduce((sum, bucket) => sum + bucket.count, 0), 3);
  const targets = body.trend.buckets.flatMap(bucket => bucket.byTarget);
  assert.equal(targets.reduce((sum, target) => sum + target.count, 0), 3);
  assert.equal(targets.some(target => target.account_name === 'B' && target.model === 'm2'), true);
});

test('direct proxy requests record the socket IP when proxy headers are absent', async t => {
  const logs = [];
  const usageRepository = { record: async entry => logs.unshift(entry), list: async () => logs, clear: async () => {} };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => [] }, usageRepository,
  }));
  t.after(app.close);
  const proxyResponse = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'missing-model', messages: [] }),
  });
  assert.equal(proxyResponse.status, 404);
  const cookie = await login(app.baseUrl);
  const usageResponse = await fetch(`${app.baseUrl}/admin/usage`, { headers: { Cookie: cookie } });
  const usage = await usageResponse.json();
  assert.equal(usage.logs[0].client_ip, '127.0.0.1');
});

test('usage records can be filtered by caller, date, account, model and status', async t => {
  const logs = [
    { id: '1', client_ip: '10.0.0.1', account_id: 'a', requested_model: 'm1', status: 200, created_at: '2026-03-01T10:00:00.000Z' },
    { id: '2', client_ip: '10.0.0.2', account_id: 'b', requested_model: 'm2', status: 429, created_at: '2026-03-02T10:00:00.000Z' },
  ];
  const usageRepository = {
    record: async entry => logs.unshift(entry), list: async () => logs, clear: async () => { logs.length = 0; },
  };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => [] }, usageRepository,
  }));
  t.after(app.close);
  const cookie = await login(app.baseUrl);

  const response = await fetch(`${app.baseUrl}/admin/usage?client_ip=10.0.0.2&account_id=b&model=m2&status=error&from=2026-03-02&to=2026-03-02`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 1);
  assert.equal(body.logs[0].id, '2');
});
