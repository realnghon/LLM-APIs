'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
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

test('status checks cover every account model and never enter usage history', async t => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'status-check', model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const accounts = [{
    id: 'account-1', name: 'Status Account',
    base_url: `http://127.0.0.1:${upstream.address().port}/v1`, api_key: 'key', format: 'openai',
    models: ['model-a', 'model-b'], enabled: true,
  }];
  const usageLogs = [];
  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    accountRepository: { list: async () => accounts },
    usageRepository: { record: async entry => usageLogs.push(entry), list: async () => usageLogs, clear: async () => {} },
  }));
  t.after(app.close);
  const cookie = await login(app.baseUrl);

  const runResponse = await fetch(`${app.baseUrl}/admin/status/run`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.deepEqual(run.snapshot.results.map(result => [result.model, result.ok]), [['model-a', true], ['model-b', true]]);
  assert.equal(usageLogs.length, 0);

  const statusResponse = await fetch(`${app.baseUrl}/admin/status`, { headers: { Cookie: cookie } });
  const status = await statusResponse.json();
  assert.deepEqual(status.settings, { enabled: true, interval_minutes: 5 });
  assert.equal(status.snapshots.length, 1);

  const settingsResponse = await fetch(`${app.baseUrl}/admin/status/settings`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, interval_minutes: 15 }),
  });
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual((await settingsResponse.json()).settings, { enabled: false, interval_minutes: 15 });
});

test('status checks discover added models and deleting an account resets its history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apis-status-delete-'));
  const dataFile = path.join(directory, 'kv.json');

  const app = await startTestServer(createHttpHandler({
    credentials: { username: 'admin', password: 'password' },
    dataFile,
    accountTester: async account => account.models.map(model => ({
      model, label: model, ok: true, status: 200, latency_ms: 25, error: '',
    })),
  }));
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const cookie = await login(app.baseUrl);
  const account = {
    id: 'account-reused', name: 'Mutable Account', base_url: 'https://example.com/v1',
    api_key: 'secret', models: ['model-a'], enabled: true,
  };

  const saveAccount = models => fetch(`${app.baseUrl}/admin/accounts`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...account, models }),
  });
  const runStatus = async () => {
    const response = await fetch(`${app.baseUrl}/admin/status/run`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 200);
    return (await response.json()).snapshot;
  };
  const getStatus = async () => {
    const response = await fetch(`${app.baseUrl}/admin/status`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };

  assert.equal((await saveAccount(['model-a'])).status, 200);
  assert.deepEqual((await runStatus()).results.map(result => result.model), ['model-a']);

  assert.equal((await saveAccount(['model-a', 'model-b'])).status, 200);
  assert.deepEqual((await runStatus()).results.map(result => result.model), ['model-a', 'model-b']);

  assert.equal((await saveAccount(['model-a'])).status, 200);
  const afterModelDelete = await getStatus();
  assert.equal(afterModelDelete.snapshots.flatMap(snapshot => snapshot.results)
    .some(result => result.account_id === account.id && result.model === 'model-b'), false);
  assert.deepEqual((await runStatus()).results.map(result => result.model), ['model-a']);

  const deleted = await fetch(`${app.baseUrl}/admin/accounts?id=${account.id}`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(deleted.status, 200);
  const afterDelete = await getStatus();
  assert.equal(afterDelete.snapshots.flatMap(snapshot => snapshot.results).length, 0);

  assert.equal((await saveAccount(['model-c'])).status, 200);
  assert.deepEqual((await runStatus()).results.map(result => result.model), ['model-c']);
  const afterRecreate = await getStatus();
  const recreatedResults = afterRecreate.snapshots
    .flatMap(snapshot => snapshot.results)
    .filter(result => result.account_id === account.id);
  assert.deepEqual(recreatedResults.map(result => result.model), ['model-c']);
});
