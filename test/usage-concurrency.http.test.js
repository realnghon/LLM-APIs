'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

const credentials = { username: 'admin', password: 'password' };

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(credentials),
  });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('concurrent usage records persist across restarts without loss', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apis-usage-'));
  const dataFile = path.join(directory, 'kv.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  let upstreamRequests = 0;
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests += 1;
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const first = await startTestServer(createHttpHandler({ credentials, dataFile }));
  const cookie = await login(first.baseUrl);
  const created = await fetch(`${first.baseUrl}/admin/accounts`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Concurrent', base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
      api_key: 'key', models: ['model-a'], max_concurrency: 0,
    }),
  });
  assert.equal(created.status, 200);

  for (let start = 0; start < 1005; start += 50) {
    const calls = Array.from({ length: Math.min(50, 1005 - start) }, (_, offset) => {
      const index = start + offset;
      return fetch(`${first.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${index % 4 + 1}` },
        body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: String(index) }] }),
      }).then(async response => {
        assert.equal(response.status, 200);
        await response.text();
      });
    });
    await Promise.all(calls);
  }
  const firstUsageResponse = await fetch(`${first.baseUrl}/admin/usage?limit=1000`, { headers: { Cookie: cookie } });
  const firstUsage = await firstUsageResponse.json();
  assert.equal(firstUsage.total, 1005);
  assert.equal(new Set(firstUsage.logs.map(row => row.request_id)).size, 1000);
  assert.equal(upstreamRequests, 1005);
  await first.close();

  const second = await startTestServer(createHttpHandler({ credentials, dataFile }));
  t.after(second.close);
  const secondCookie = await login(second.baseUrl);
  const response = await fetch(`${second.baseUrl}/admin/usage?limit=1000`, { headers: { Cookie: secondCookie } });
  const usage = await response.json();
  assert.equal(usage.total, 1005);
  assert.equal(usage.logs.every(row => row.total_tokens === 3), true);
});
