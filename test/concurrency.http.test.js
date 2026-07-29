'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

function completion(content) {
  return JSON.stringify({
    id: `chatcmpl-${content}`, object: 'chat.completion', model: 'model-a',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

test('least-connections routing sends overlapping same-model requests to an idle peer', async t => {
  let releasePrimary;
  const primaryStarted = new Promise(resolve => { releasePrimary = resolve; });
  const primary = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    releasePrimary();
    await new Promise(resolve => setTimeout(resolve, 220));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(completion('primary'));
  });
  const secondary = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(completion('secondary'));
  });
  await Promise.all([
    new Promise(resolve => primary.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => secondary.listen(0, '127.0.0.1', resolve)),
  ]);
  t.after(() => Promise.all([
    new Promise(resolve => primary.close(resolve)),
    new Promise(resolve => secondary.close(resolve)),
  ]));

  const base = { api_key: 'key', models: ['model-a'], priority: 1, weight: 1, max_concurrency: 0, enabled: true };
  const accounts = [
    { ...base, id: 'primary', name: 'Primary', base_url: `http://127.0.0.1:${primary.address().port}/v1` },
    { ...base, id: 'secondary', name: 'Secondary', base_url: `http://127.0.0.1:${secondary.address().port}/v1` },
  ];
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => accounts }, random: () => 0.5,
  }));
  t.after(app.close);
  const call = () => fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }),
  }).then(response => response.json());

  const first = call();
  await primaryStarted;
  const second = await call();
  assert.equal(second.choices[0].message.content, 'secondary');
  assert.equal((await first).choices[0].message.content, 'primary');
});

test('concurrency limit sends overlapping requests to the next account', async t => {
  let primaryStarted;
  const started = new Promise(resolve => { primaryStarted = resolve; });
  const primary = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    primaryStarted();
    await new Promise(resolve => setTimeout(resolve, 250));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(completion('primary'));
  });
  const secondary = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(completion('secondary'));
  });
  await Promise.all([
    new Promise(resolve => primary.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => secondary.listen(0, '127.0.0.1', resolve)),
  ]);
  t.after(() => Promise.all([
    new Promise(resolve => primary.close(resolve)),
    new Promise(resolve => secondary.close(resolve)),
  ]));

  const baseAccount = { api_key: 'key', models: ['model-a'], weight: 1, enabled: true };
  const accounts = [
    { ...baseAccount, id: 'primary', name: 'Primary', base_url: `http://127.0.0.1:${primary.address().port}/v1`, priority: 1, max_concurrency: 1 },
    { ...baseAccount, id: 'secondary', name: 'Secondary', base_url: `http://127.0.0.1:${secondary.address().port}/v1`, priority: 2, max_concurrency: 1 },
  ];
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => accounts }, random: () => 0.5,
  }));
  t.after(app.close);

  const call = () => fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }] }),
  }).then(response => response.json());

  const firstCall = call();
  await started;
  const secondResult = await call();
  assert.equal(secondResult.choices[0].message.content, 'secondary');
  const firstResult = await firstCall;
  assert.equal(firstResult.choices[0].message.content, 'primary');
});
