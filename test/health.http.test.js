'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHttpHandler } = require('../src/app');
const { startTestServer } = require('./helpers/test-server');

test('health and readiness probes are public and report available models', async t => {
  const accountRepository = { list: async () => [{ enabled: true, models: ['model-a', 'model-b'], model_map: {} }] };
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' }, accountRepository,
  }));
  t.after(app.close);

  const health = await fetch(`${app.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const ready = await fetch(`${app.baseUrl}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready', accounts: 1, models: 2 });
});
