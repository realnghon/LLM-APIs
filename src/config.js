'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CREDENTIALS = Object.freeze({ username: 'admin', password: 'password' });

function loadAdminCredentials(configPath = path.join(__dirname, '..', 'config', 'admin.json')) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const username = String(parsed.username || '').trim();
    const password = String(parsed.password || '');
    if (!username || !password) throw new Error('username and password are required');
    return { username, password };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CREDENTIALS };
    throw new Error(`Invalid admin config: ${error.message}`);
  }
}

function loadServicePort(environment = process.env) {
  const port = Number(environment.PORT || 8787);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8787;
}

module.exports = { DEFAULT_CREDENTIALS, loadAdminCredentials, loadServicePort };
