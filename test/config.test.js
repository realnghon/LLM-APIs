'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadAdminCredentials, loadServiceConfig, loadServicePort } = require('../src/config');

test('service defaults to port 8787 and allows an environment override', () => {
  assert.equal(loadServicePort({}), 8787);
  assert.equal(loadServicePort({ PORT: '4321' }), 4321);
});

test('admin credentials require a file or complete environment override', t => {
  const missing = path.join(os.tmpdir(), `missing-admin-${process.pid}.json`);
  assert.throws(() => loadAdminCredentials(missing, {}), /Admin config not found/);
  assert.deepEqual(loadAdminCredentials(missing, { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'secret' }), {
    username: 'owner', password: 'secret',
  });
});

test('service configuration loads from JSON with environment overrides', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-apis-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'service.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '0.0.0.0', port: 9000, max_request_body_bytes: 2048,
    headers_timeout_ms: 6000, request_timeout_ms: 20000, keep_alive_timeout_ms: 2000,
  }));
  assert.deepEqual(loadServiceConfig(configPath, { PORT: '9001' }), {
    host: '0.0.0.0', port: 9001, max_request_body_bytes: 2048,
    headers_timeout_ms: 6000, request_timeout_ms: 20000, keep_alive_timeout_ms: 2000,
  });
});
