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
  const response = await fetch(`${baseUrl}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(credentials) });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('API keys protect models and attribute proxy usage', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apis-keys-'));
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const app = await startTestServer(createHttpHandler({ credentials, dataFile: path.join(directory, 'kv.json') }));
  t.after(async () => { await app.close(); await new Promise(resolve => upstream.close(resolve)); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const cookie = await login(app.baseUrl);
  await fetch(`${app.baseUrl}/admin/accounts`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Key upstream', base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key: 'upstream', models: ['model-a', 'model-b'] }) });
  const created = await fetch(`${app.baseUrl}/admin/api-keys`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Client A', models: ['model-a'] }) });
  const key = (await created.json()).api_key;
  assert.match(key.key, /^llm_[a-f0-9]{10}_/);
  const listing = await (await fetch(`${app.baseUrl}/admin/api-keys`, { headers: { Cookie: cookie } })).json();
  assert.equal(listing.keys[0].key, undefined);
  assert.equal(listing.keys[0].secret_hash, undefined);
  const optionalCall = await fetch(`${app.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'model-a', messages: [] }) });
  assert.equal(optionalCall.status, 200);
  await optionalCall.text();
  const optionalUsage = await (await fetch(`${app.baseUrl}/admin/usage?api_key_id=${key.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(optionalUsage.total, 1);
  await fetch(`${app.baseUrl}/admin/api-keys/settings`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ required: true }) });

  assert.equal((await fetch(`${app.baseUrl}/v1/models`)).status, 401);
  const models = await (await fetch(`${app.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` } })).json();
  assert.deepEqual(models.data.map(model => model.id), ['model-a']);
  const forbidden = await fetch(`${app.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'model-b', messages: [] }) });
  assert.equal(forbidden.status, 403);
  const allowed = await fetch(`${app.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'model-a', messages: [] }) });
  assert.equal(allowed.status, 200);
  await allowed.text();
  const usage = await (await fetch(`${app.baseUrl}/admin/usage?api_key_id=${key.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(usage.total, 2);
  assert.equal(usage.logs[0].api_key_name, 'Client A');
});

test('legacy account prices remain account overrides during SQLite migration', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apis-migration-'));
  const dataFile = path.join(directory, 'kv.json');
  await fs.writeFile(dataFile, JSON.stringify({ accounts: JSON.stringify([
    { id: 'a', name: 'A', base_url: 'https://a.example/v1', api_key: 'a', models: ['shared'], model_prices: { shared: { input: 1, output: 2 } } },
    { id: 'b', name: 'B', base_url: 'https://b.example/v1', api_key: 'b', models: ['shared'], model_prices: { shared: { input: 3, output: 4 } } },
  ]) }));
  const app = await startTestServer(createHttpHandler({ credentials, dataFile }));
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const cookie = await login(app.baseUrl);
  const accounts = (await (await fetch(`${app.baseUrl}/admin/accounts`, { headers: { Cookie: cookie } })).json()).accounts;
  assert.deepEqual(accounts.map(account => account.model_prices.shared), [{ input: 1, output: 2 }, { input: 3, output: 4 }]);
  const pricing = await (await fetch(`${app.baseUrl}/admin/pricing`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(pricing.prices, {});
});

test('global model prices are inherited and account overrides win', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apis-pricing-'));
  const app = await startTestServer(createHttpHandler({ credentials, dataFile: path.join(directory, 'kv.json') }));
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const cookie = await login(app.baseUrl);
  await fetch(`${app.baseUrl}/admin/pricing`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'model-a', input: 1.5, output: 6 }) });
  const create = await fetch(`${app.baseUrl}/admin/accounts`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Inherited', base_url: 'https://example.com/v1', api_key: 'key', models: ['model-a'] }) });
  const account = (await create.json()).account;
  let listed = await (await fetch(`${app.baseUrl}/admin/accounts`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(listed.accounts[0].model_prices['model-a'], { input: 1.5, output: 6 });
  await fetch(`${app.baseUrl}/admin/accounts`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...account, model_price_overrides: { 'model-a': { input: 2, output: 8 } } }) });
  listed = await (await fetch(`${app.baseUrl}/admin/accounts`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(listed.accounts[0].model_prices['model-a'], { input: 2, output: 8 });
});
