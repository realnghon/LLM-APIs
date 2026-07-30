'use strict';

const assert = require('node:assert/strict');
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

test('account management discards removed pool and shared allowance settings', async t => {
  const records = [];
  const accountRepository = {
    list: async () => records,
    save: async account => {
      records.push(account);
      return account;
    },
  };
  const handler = createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository,
  });
  const server = await startTestServer(handler);
  t.after(server.close);
  const cookie = await login(server.baseUrl);

  const created = await fetch(`${server.baseUrl}/admin/accounts`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Primary',
      base_url: 'https://example.com/v1',
      api_key: 'secret',
      models: ['model-a'],
      model_prices: {
        'model-a': { input: 1.5, output: 6 },
        invalid: { input: -1, output: 'nope' },
      },
      pool_mode: true,
      pool_mode_retry_count: 5,
      pool_retry_statuses: [401, 429],
      request_timeout_ms: 1000,
      allowance: { type: 'shared', shared_group_name: 'old-pool' },
    }),
  });
  assert.equal(created.status, 200);

  const response = await fetch(`${server.baseUrl}/admin/accounts`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accounts.length, 1);
  assert.deepEqual(body.accounts[0].models, ['model-a']);
  assert.deepEqual(body.accounts[0].model_prices, {
    'model-a': { input: 1.5, output: 6 },
    invalid: { input: 0, output: 0 },
  });
  assert.equal(body.accounts[0].pool_mode, undefined);
  assert.equal(body.accounts[0].pool_mode_retry_count, undefined);
  assert.equal(body.accounts[0].pool_retry_statuses, undefined);
  assert.equal(body.accounts[0].request_timeout_ms, undefined);
  assert.equal(body.allowance_config.shared_groups, undefined);
});
