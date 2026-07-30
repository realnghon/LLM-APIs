'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SERVICE_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
  max_request_body_bytes: 10 * 1024 * 1024,
  headers_timeout_ms: 15_000,
  request_timeout_ms: 300_000,
  keep_alive_timeout_ms: 5_000,
});

function loadAdminCredentials(
  configPath = path.join(__dirname, '..', 'config', 'admin.json'),
  environment = process.env,
) {
  const environmentUsername = String(environment.ADMIN_USERNAME || '').trim();
  const environmentPassword = String(environment.ADMIN_PASSWORD || '');
  if (environmentUsername && environmentPassword) {
    return { username: environmentUsername, password: environmentPassword };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const username = String(parsed.username || '').trim();
    const password = String(parsed.password || '');
    if (!username || !password) throw new Error('username and password are required');
    return { username, password };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Admin config not found. Create config/admin.json or set ADMIN_USERNAME and ADMIN_PASSWORD.');
    throw new Error(`Invalid admin config: ${error.message}`);
  }
}

function integer(value, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function loadServiceConfig(
  configPath = path.join(__dirname, '..', 'config', 'service.json'),
  environment = process.env,
) {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Invalid service config: ${error.message}`);
  }
  const value = { ...DEFAULT_SERVICE_CONFIG, ...fileConfig };
  return {
    host: String(environment.HOST ?? value.host).trim() || DEFAULT_SERVICE_CONFIG.host,
    port: integer(environment.PORT ?? value.port, DEFAULT_SERVICE_CONFIG.port, 1, 65535),
    max_request_body_bytes: integer(environment.MAX_REQUEST_BODY_BYTES ?? value.max_request_body_bytes, DEFAULT_SERVICE_CONFIG.max_request_body_bytes, 1024),
    headers_timeout_ms: integer(environment.HEADERS_TIMEOUT_MS ?? value.headers_timeout_ms, DEFAULT_SERVICE_CONFIG.headers_timeout_ms, 5_000),
    request_timeout_ms: integer(environment.REQUEST_TIMEOUT_MS ?? value.request_timeout_ms, DEFAULT_SERVICE_CONFIG.request_timeout_ms, 10_000),
    keep_alive_timeout_ms: integer(environment.KEEP_ALIVE_TIMEOUT_MS ?? value.keep_alive_timeout_ms, DEFAULT_SERVICE_CONFIG.keep_alive_timeout_ms, 1_000),
  };
}

function loadServicePort(environment = process.env) {
  return loadServiceConfig(undefined, environment).port;
}

function loadServiceHost(environment = process.env) {
  return loadServiceConfig(undefined, environment).host;
}

module.exports = {
  DEFAULT_SERVICE_CONFIG,
  loadAdminCredentials,
  loadServiceConfig,
  loadServiceHost,
  loadServicePort,
};
