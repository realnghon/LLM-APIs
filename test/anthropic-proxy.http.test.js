'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

test('Anthropic accounts use the official provider behind the OpenAI-compatible route', async t => {
  let upstreamPath = '';
  let apiKey = '';
  const upstream = http.createServer(async (req, res) => {
    upstreamPath = req.url;
    apiKey = req.headers['x-api-key'];
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'hello from claude' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 3 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const account = {
    id: 'anthropic', name: 'Anthropic', format: 'anthropic',
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    api_key: 'anthropic-key', models: ['claude-test'], priority: 1, weight: 1, enabled: true,
  };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => [account] },
    usageRepository: { record: async () => {}, list: async () => [], clear: async () => {} },
  }));
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      max_tokens: 32,
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'hello from claude');
  assert.equal(body.usage.total_tokens, 7);
  assert.equal(upstreamPath, '/v1/messages');
  assert.equal(apiKey, 'anthropic-key');
});

test('Anthropic accounts receive OpenAI image inputs as multimodal content', async t => {
  let upstreamBody = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_image', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'image received' }], stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 2 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const account = {
    id: 'anthropic-image', name: 'Anthropic Image', format: 'anthropic',
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    api_key: 'anthropic-key', models: ['claude-test'], enabled: true,
  };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => [account] },
  }));
  t.after(app.close);

  const response = await fetch(`${app.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-test',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ] }],
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBody.messages[0].content, [
    { type: 'text', text: 'Describe this image.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ]);
});
