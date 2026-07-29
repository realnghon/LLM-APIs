'use strict';

const { defineConfig } = require('@playwright/test');
const path = require('path');
const os = require('os');

module.exports = defineConfig({
  testDir: './test/browser',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node APIs.js',
    url: 'http://127.0.0.1:3210/login',
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: '3210',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'password',
      DATA_FILE: path.join(os.tmpdir(), `llm-apis-browser-test-${process.pid}.json`),
      LLM_APIS_PID_FILE: path.join(os.tmpdir(), `llm-apis-browser-test-${process.pid}.pid`),
    },
  },
});
