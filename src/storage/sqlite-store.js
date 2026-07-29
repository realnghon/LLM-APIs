'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_SETTINGS } = require('../status');

function decode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function databasePath(dataFile, explicitPath) {
  if (explicitPath) return explicitPath;
  const extension = path.extname(dataFile);
  return path.join(path.dirname(dataFile), `${path.basename(dataFile, extension)}.sqlite`);
}

function json(value, fallback = null) {
  try { return JSON.stringify(value); } catch { return JSON.stringify(fallback); }
}

function parsed(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_prices (
      model TEXT PRIMARY KEY COLLATE NOCASE,
      input_price REAL NOT NULL DEFAULT 0,
      output_price REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL UNIQUE,
      secret_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL DEFAULT '',
      api_key_id TEXT NOT NULL DEFAULT '',
      api_key_name TEXT NOT NULL DEFAULT '',
      api_key_prefix TEXT NOT NULL DEFAULT '',
      requested_model TEXT NOT NULL DEFAULT '',
      upstream_model TEXT NOT NULL DEFAULT '',
      request_path TEXT NOT NULL DEFAULT '',
      client_ip TEXT NOT NULL DEFAULT '',
      status INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      first_token_ms INTEGER,
      stream INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      consumed REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      attempts TEXT NOT NULL DEFAULT '[]',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_created_idx ON usage_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS usage_key_created_idx ON usage_logs(api_key_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS usage_account_created_idx ON usage_logs(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS usage_model_created_idx ON usage_logs(requested_model, created_at DESC);
    CREATE INDEX IF NOT EXISTS usage_status_created_idx ON usage_logs(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS status_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS status_snapshots (id TEXT PRIMARY KEY, checked_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS status_checked_idx ON status_snapshots(checked_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

function usageFiles(dataFile) {
  const extension = path.extname(dataFile);
  const directory = path.dirname(dataFile);
  const base = path.basename(dataFile, extension);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name === `${base}.usage.ndjson` || (name.startsWith(`${base}.usage-`) && name.endsWith('.ndjson')))
    .map(name => path.join(directory, name));
}

function migrateLegacy(db, dataFile) {
  const migrated = db.prepare("SELECT value FROM schema_meta WHERE key = 'legacy_imported'").get();
  if (migrated) return;
  transaction(db, () => {
    let document = {};
    if (fs.existsSync(dataFile)) {
      try { document = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch {}
    }
    const quotas = decode(document.allowance_config, {}).account_quotas || {};
    const allowanceStatus = decode(document.allowance_status, {});
    const accounts = decode(document.accounts, []);
    const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts(id, position, data, updated_at) VALUES (?, ?, ?, ?)');
    if (Array.isArray(accounts)) accounts.forEach((source, index) => {
      const now = source.updated_at || new Date().toISOString();
      const legacyAllowance = quotas[source.id];
      const state = allowanceStatus[`target:account:${source.id}`] || {};
      const allowance = source.allowance?.type === 'total' ? source.allowance : (legacyAllowance ? {
        type: 'total', quota_mode: legacyAllowance.mode || 'usage', quota_expires_at: legacyAllowance.expires_at || '',
        quota_total: Number(legacyAllowance.initial_total || 0), quota_rates_text: legacyAllowance.rates_text || '',
        quota_display_currency: legacyAllowance.display_currency === true,
        remaining: Number(state.remainingUnits ?? legacyAllowance.initial_total ?? 0),
      } : null);
      const overrides = source.model_price_overrides || source.model_prices || {};
      const clean = { ...source, allowance, model_price_overrides: overrides };
      delete clean.model_prices;
      insertAccount.run(clean.id, index, json(clean, {}), now);
    });

    const insertUsage = db.prepare(`INSERT OR IGNORE INTO usage_logs(
      id, request_id, account_id, account_name, api_key_id, api_key_name, api_key_prefix,
      requested_model, upstream_model, request_path, client_ip, status, duration_ms, first_token_ms,
      stream, input_tokens, output_tokens, total_tokens, cache_tokens, cache_create_tokens,
      consumed, cost, attempts, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const legacyLogs = decode(document.usage_logs, []);
    const rows = Array.isArray(legacyLogs) ? legacyLogs.slice() : [];
    for (const file of usageFiles(dataFile)) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try { rows.push(JSON.parse(line)); } catch {}
      }
    }
    for (const row of rows) insertUsage.run(
      row.id || row.request_id, row.request_id || row.id, row.account_id || '', row.account_name || '',
      row.api_key_id || '', row.api_key_name || '', row.api_key_prefix || '', row.requested_model || '',
      row.upstream_model || '', row.request_path || '', row.client_ip || '', Number(row.status || 0),
      Number(row.duration_ms || 0), row.first_token_ms == null ? null : Number(row.first_token_ms), row.stream === true ? 1 : 0,
      Number(row.input_tokens || 0), Number(row.output_tokens || 0), Number(row.total_tokens || 0),
      Number(row.cache_tokens || 0), Number(row.cache_create_tokens || 0), Number(row.consumed || 0),
      Number(row.cost || 0), json(row.attempts || [], []), row.error || '', row.created_at || new Date().toISOString(),
    );

    const extension = path.extname(dataFile);
    const statusFile = path.join(path.dirname(dataFile), `${path.basename(dataFile, extension)}.status.json`);
    if (fs.existsSync(statusFile)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        if (status.settings) db.prepare('INSERT OR REPLACE INTO status_settings(singleton, data) VALUES (1, ?)').run(json(status.settings));
        const insertSnapshot = db.prepare('INSERT OR IGNORE INTO status_snapshots(id, checked_at, data) VALUES (?, ?, ?)');
        for (const snapshot of status.snapshots || []) insertSnapshot.run(snapshot.id, snapshot.checked_at, json(snapshot));
      } catch {}
    }
    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('legacy_imported', ?)").run(new Date().toISOString());
  });
}

function createSqliteStore(dataFile, options = {}) {
  const filePath = databasePath(dataFile, options.databaseFile || process.env.DATABASE_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  let closed = false;
  createSchema(db);
  migrateLegacy(db, dataFile);
  let accountSnapshot = null;

  function invalidateAccounts() {
    accountSnapshot = null;
  }

  function pricesObject() {
    return Object.fromEntries(db.prepare('SELECT model, input_price, output_price FROM model_prices ORDER BY model COLLATE NOCASE').all()
      .map(row => [row.model, { input: Number(row.input_price), output: Number(row.output_price) }]));
  }

  const accountRepository = {
    async list() {
      if (accountSnapshot) return accountSnapshot.slice();
      const globalPrices = pricesObject();
      accountSnapshot = db.prepare('SELECT data FROM accounts ORDER BY position, rowid').all().map(row => {
        const account = parsed(row.data, {});
        const overrides = account.model_price_overrides || {};
        return { ...account, model_price_overrides: overrides, model_prices: { ...globalPrices, ...overrides } };
      });
      return accountSnapshot.slice();
    },
    async save(account) {
      const now = account.updated_at || new Date().toISOString();
      const clean = { ...account, model_price_overrides: account.model_price_overrides || {} };
      delete clean.model_prices;
      const existing = db.prepare('SELECT position, data FROM accounts WHERE id = ?').get(account.id);
      const current = parsed(existing?.data, {});
      if (clean.allowance?.type === 'total' && current.allowance?.type === 'total'
        && clean.allowance.quota_mode === current.allowance.quota_mode
        && Number(clean.allowance.quota_total || 0) === Number(current.allowance.quota_total || 0)) {
        clean.allowance.remaining = Number(current.allowance.remaining ?? clean.allowance.quota_total ?? 0);
      }
      const maximum = db.prepare('SELECT COALESCE(MAX(position), -1) AS value FROM accounts').get().value;
      db.prepare(`INSERT INTO accounts(id, position, data, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
        .run(account.id, existing ? existing.position : Number(maximum) + 1, json(clean, {}), now);
      invalidateAccounts();
      return account;
    },
    async delete(id) {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      invalidateAccounts();
    },
    async reorder(ids) {
      transaction(db, () => {
        const update = db.prepare('UPDATE accounts SET position = ? WHERE id = ?');
        ids.forEach((id, index) => update.run(index, id));
      });
      invalidateAccounts();
    },
    async debitAllowance(id, amount) {
      transaction(db, () => {
        const row = db.prepare('SELECT data FROM accounts WHERE id = ?').get(id);
        if (!row) return;
        const account = parsed(row.data, {});
        if (account.allowance?.type !== 'total') return;
        const current = Number(account.allowance.remaining ?? account.allowance.quota_total ?? 0);
        account.allowance.remaining = Math.max(0, current - Math.max(0, Number(amount || 0)));
        account.updated_at = new Date().toISOString();
        db.prepare('UPDATE accounts SET data = ?, updated_at = ? WHERE id = ?').run(json(account), account.updated_at, id);
      });
      invalidateAccounts();
    },
    async reserveCountAllowance(id) {
      return transaction(db, () => {
        const row = db.prepare('SELECT data FROM accounts WHERE id = ?').get(id);
        if (!row) return false;
        const account = parsed(row.data, {});
        const allowance = account.allowance;
        if (allowance?.type !== 'total' || allowance.quota_mode !== 'count') return true;
        if (allowance.quota_expires_at && allowance.quota_expires_at < new Date().toISOString().slice(0, 10)) return false;
        const current = Number(allowance.remaining ?? allowance.quota_total ?? 0);
        if (!(current > 0)) return false;
        allowance.remaining = current - 1;
        db.prepare('UPDATE accounts SET data = ?, updated_at = ? WHERE id = ?').run(json(account), new Date().toISOString(), id);
        invalidateAccounts();
        return true;
      });
    },
    async refundCountAllowance(id) {
      transaction(db, () => {
        const row = db.prepare('SELECT data FROM accounts WHERE id = ?').get(id);
        if (!row) return;
        const account = parsed(row.data, {});
        const allowance = account.allowance;
        if (allowance?.type !== 'total' || allowance.quota_mode !== 'count') return;
        allowance.remaining = Math.min(Number(allowance.quota_total || Infinity), Number(allowance.remaining || 0) + 1);
        db.prepare('UPDATE accounts SET data = ?, updated_at = ? WHERE id = ?').run(json(account), new Date().toISOString(), id);
      });
      invalidateAccounts();
    },
  };

  const priceRepository = {
    async list() { return pricesObject(); },
    async save(model, price) {
      const name = String(model || '').trim();
      db.prepare(`INSERT INTO model_prices(model, input_price, output_price, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(model) DO UPDATE SET input_price = excluded.input_price, output_price = excluded.output_price, updated_at = excluded.updated_at`)
        .run(name, Math.max(0, Number(price.input || 0)), Math.max(0, Number(price.output || 0)), new Date().toISOString());
      invalidateAccounts();
    },
    async delete(model) {
      db.prepare('DELETE FROM model_prices WHERE model = ? COLLATE NOCASE').run(model);
      invalidateAccounts();
    },
  };

  const usageColumns = `id, request_id, account_id, account_name, api_key_id, api_key_name, api_key_prefix,
    requested_model, upstream_model, request_path, client_ip, status, duration_ms, first_token_ms, stream,
    input_tokens, output_tokens, total_tokens, cache_tokens, cache_create_tokens, consumed, cost, attempts, error, created_at`;
  function usageRow(row) {
    return row ? { ...row, stream: row.stream === 1, attempts: parsed(row.attempts, []) } : row;
  }
  function statsSummary(where = '', parameters = []) {
    const totals = db.prepare(`SELECT COUNT(*) AS total_count,
      SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success_count,
      COALESCE(SUM(input_tokens), 0) AS total_input, COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(cost), 0) AS total_cost FROM usage_logs${where}`).get(...parameters);
    const grouped = column => db.prepare(`SELECT ${column} AS name, COUNT(*) AS count,
      COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
      COALESCE(SUM(cache_tokens), 0) AS cache, COALESCE(SUM(cache_create_tokens), 0) AS cache_create,
      COALESCE(SUM(consumed), 0) AS consumed, COALESCE(SUM(cost), 0) AS cost
      FROM usage_logs${where}${where ? ' AND' : ' WHERE'} ${column} != '' GROUP BY ${column}`).all(...parameters);
    const totalCount = Number(totals.total_count || 0);
    const successCount = Number(totals.success_count || 0);
    const totalInput = Number(totals.total_input || 0);
    const totalOutput = Number(totals.total_output || 0);
    return {
      total_count: totalCount,
      success_count: successCount,
      fail_count: totalCount - successCount,
      total_input: totalInput,
      total_output: totalOutput,
      total_tokens: totalInput + totalOutput,
      total_cost: Number(Number(totals.total_cost || 0).toFixed(12)),
      byAccount: grouped('account_name'),
      byModel: grouped('requested_model'),
    };
  }

  function usageStats(range = 'week', now = new Date()) {
    const current = now instanceof Date ? now : new Date(now);
    const today = current.toISOString().slice(0, 10);
    const recentStart = new Date(current.getTime() - 5 * 60 * 60_000).toISOString();
    const days = range === 'month' ? 30 : 7;
    const trendStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() - days + 1));
    const trendRows = db.prepare(`SELECT substr(created_at, 1, 10) AS day, account_name, requested_model,
      COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
      COALESCE(SUM(cost), 0) AS cost FROM usage_logs
      WHERE created_at >= ? AND created_at <= ? GROUP BY day, account_name, requested_model`)
      .all(trendStart.toISOString(), current.toISOString());
    const buckets = [];
    for (let index = 0; index < days; index += 1) {
      const date = new Date(trendStart);
      date.setUTCDate(trendStart.getUTCDate() + index);
      const key = date.toISOString().slice(0, 10);
      const rows = trendRows.filter(row => row.day === key);
      const byAccount = new Map();
      for (const row of rows) {
        if (!row.account_name) continue;
        const item = byAccount.get(row.account_name) || { name: row.account_name, count: 0, input: 0, output: 0, cache: 0, cache_create: 0, consumed: 0, cost: 0 };
        for (const field of ['count', 'input', 'output', 'cost']) item[field] += Number(row[field] || 0);
        byAccount.set(row.account_name, item);
      }
      buckets.push({
        key,
        count: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
        input: rows.reduce((sum, row) => sum + Number(row.input || 0), 0),
        output: rows.reduce((sum, row) => sum + Number(row.output || 0), 0),
        cost: Number(rows.reduce((sum, row) => sum + Number(row.cost || 0), 0).toFixed(12)),
        byAccount: [...byAccount.values()],
        byTarget: rows.map(row => ({
          account_name: row.account_name || '', model: row.requested_model || '', count: Number(row.count || 0),
          input: Number(row.input || 0), output: Number(row.output || 0), cost: Number(Number(row.cost || 0).toFixed(12)),
        })),
      });
    }
    return {
      cumulative: statsSummary(),
      daily: statsSummary(' WHERE created_at >= ? AND created_at <= ?', [`${today}T00:00:00.000Z`, current.toISOString()]),
      recent5h: statsSummary(' WHERE created_at >= ? AND created_at <= ?', [recentStart, current.toISOString()]),
      trend: { range: range === 'month' ? 'month' : 'week', buckets },
    };
  }
  const usageRepository = {
    async record(row) {
      db.prepare(`INSERT OR REPLACE INTO usage_logs(${usageColumns}) VALUES (${Array(25).fill('?').join(',')})`).run(
        row.id, row.request_id, row.account_id || '', row.account_name || '', row.api_key_id || '', row.api_key_name || '',
        row.api_key_prefix || '', row.requested_model || '', row.upstream_model || '', row.request_path || '', row.client_ip || '',
        Number(row.status || 0), Number(row.duration_ms || 0), row.first_token_ms == null ? null : Number(row.first_token_ms),
        row.stream === true ? 1 : 0, Number(row.input_tokens || 0), Number(row.output_tokens || 0), Number(row.total_tokens || 0),
        Number(row.cache_tokens || 0), Number(row.cache_create_tokens || 0), Number(row.consumed || 0), Number(row.cost || 0),
        json(row.attempts || [], []), row.error || '', row.created_at,
      );
    },
    async list(options = {}) {
      const clauses = [];
      const parameters = [];
      if (options.from) { clauses.push('created_at >= ?'); parameters.push(options.from); }
      if (options.to) { clauses.push('created_at <= ?'); parameters.push(options.to); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`SELECT ${usageColumns} FROM usage_logs${where} ORDER BY created_at DESC`).all(...parameters).map(usageRow);
    },
    async page(options = {}) {
      const clauses = [];
      const parameters = [];
      const add = (sql, value) => { if (value !== undefined && value !== '') { clauses.push(sql); parameters.push(value); } };
      add('api_key_id = ?', options.apiKeyId);
      add('account_id = ?', options.accountId);
      add('client_ip LIKE ?', options.clientIp ? `%${options.clientIp}%` : '');
      add('LOWER(requested_model) LIKE ?', options.model ? `%${options.model.toLowerCase()}%` : '');
      add('created_at >= ?', options.from);
      add('created_at <= ?', options.to);
      if (options.status === 'success') clauses.push('status >= 200 AND status < 400');
      else if (options.status === 'error') clauses.push('(status < 200 OR status >= 400)');
      else if (options.status) add('status = ?', Number(options.status));
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const stats = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success_count
        FROM usage_logs${where}`).get(...parameters);
      const logs = db.prepare(`SELECT ${usageColumns} FROM usage_logs${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...parameters, Number(options.limit), Number(options.offset)).map(usageRow);
      return { logs, total: Number(stats.total || 0), successCount: Number(stats.success_count || 0) };
    },
    async stats(range, now) { return usageStats(range, now); },
    async clear() { db.exec('DELETE FROM usage_logs'); },
  };

  const statusRepository = {
    async getSettings() {
      const row = db.prepare('SELECT data FROM status_settings WHERE singleton = 1').get();
      return { ...DEFAULT_SETTINGS, ...parsed(row?.data, {}) };
    },
    async saveSettings(settings) {
      db.prepare('INSERT OR REPLACE INTO status_settings(singleton, data) VALUES (1, ?)').run(json(settings));
      return settings;
    },
    async listSnapshots() {
      return db.prepare('SELECT data FROM status_snapshots ORDER BY checked_at DESC LIMIT 288').all().map(row => parsed(row.data, {}));
    },
    async addSnapshot(snapshot) {
      transaction(db, () => {
        db.prepare('INSERT OR REPLACE INTO status_snapshots(id, checked_at, data) VALUES (?, ?, ?)').run(snapshot.id, snapshot.checked_at, json(snapshot));
        db.exec('DELETE FROM status_snapshots WHERE id NOT IN (SELECT id FROM status_snapshots ORDER BY checked_at DESC LIMIT 288)');
      });
    },
    async removeAccountResults(accountId) {
      const rows = db.prepare('SELECT id, data FROM status_snapshots').all();
      const update = db.prepare('UPDATE status_snapshots SET data = ? WHERE id = ?');
      transaction(db, () => rows.forEach(row => {
        const snapshot = parsed(row.data, {});
        snapshot.results = (snapshot.results || []).filter(result => result.account_id !== accountId);
        update.run(json(snapshot), row.id);
      }));
    },
    async reconcileAccountResults(accountId, targetKeys) {
      const allowed = new Set(targetKeys);
      const rows = db.prepare('SELECT id, data FROM status_snapshots').all();
      const update = db.prepare('UPDATE status_snapshots SET data = ? WHERE id = ?');
      transaction(db, () => rows.forEach(row => {
        const snapshot = parsed(row.data, {});
        snapshot.results = (snapshot.results || []).filter(result => result.account_id !== accountId || allowed.has(result.target_key || `direct:${result.model}`));
        update.run(json(snapshot), row.id);
      }));
    },
  };

  const settingsRepository = {
    get(key, fallback = null) {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
      return row ? parsed(row.value, row.value) : fallback;
    },
    set(key, value) { db.prepare('INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)').run(key, json(value)); },
  };

  return {
    db, filePath, accountRepository, priceRepository, usageRepository, statusRepository, settingsRepository,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

module.exports = { createSqliteStore, databasePath };
