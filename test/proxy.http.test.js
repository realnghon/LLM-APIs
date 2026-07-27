'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

async function startUpstream(respond) {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    respond(req, res, Buffer.concat(chunks));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('proxy times out a stalled account and fails over to the same model on another account', async t => {
  const stalled = await startUpstream(async (_req, res) => {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [] }));
  });
  const healthy = await startUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'healthy' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  t.after(async () => { await Promise.all([stalled.close(), healthy.close()]); });
  const base = { api_key: 'key', models: ['model-a'], weight: 1, enabled: true };
  const accounts = [
    { ...base, id: 'stalled', name: 'Stalled', base_url: stalled.baseUrl, priority: 1, request_timeout_ms: 50 },
    { ...base, id: 'healthy', name: 'Healthy', base_url: healthy.baseUrl, priority: 2, request_timeout_ms: 1000 },
  ];
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' }, accountRepository: { list: async () => accounts },
  }));
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'healthy');
  assert.equal(stalled.requests(), 1);
  assert.equal(healthy.requests(), 1);
});

test('proxy fails over to the next account without retrying the failed account', async t => {
  const failed = await startUpstream((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temporary failure' } }));
  });
  const healthy = await startUpstream((_req, res, body) => {
    const request = JSON.parse(body.toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  t.after(async () => { await Promise.all([failed.close(), healthy.close()]); });

  const accounts = [
    { id: 'failed', name: 'Failed', base_url: failed.baseUrl, api_key: 'one', models: ['model-a'], priority: 1, weight: 1, enabled: true },
    { id: 'healthy', name: 'Healthy', base_url: healthy.baseUrl, api_key: 'two', models: ['model-a'], priority: 2, weight: 1, enabled: true },
  ];
  const accountRepository = { list: async () => accounts };
  const handler = createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository,
  });
  const app = await startTestServer(handler);
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await response.json()).choices[0].message.content, 'ok');
  assert.equal(failed.requests(), 1);
  assert.equal(healthy.requests(), 1);
});
