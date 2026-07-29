'use strict';

const crypto = require('crypto');

function digest(secret) { return crypto.createHash('sha256').update(String(secret)).digest('hex'); }
function response(body, status = 200) { return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } }); }

function createApiKeyRepository(db, settingsRepository) {
  function sanitized(row) {
    if (!row) return null;
    return { ...row, enabled: row.enabled === 1, models: JSON.parse(row.models || '[]'), secret_hash: undefined, masked_key: `llm_${row.prefix}_...` };
  }
  return {
    async list() { return db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all().map(sanitized); },
    async listUsageKeys() {
      return db.prepare(`SELECT api_key_id AS id, MAX(api_key_name) AS name, MAX(api_key_prefix) AS prefix
        FROM usage_logs WHERE api_key_id != '' GROUP BY api_key_id ORDER BY name COLLATE NOCASE`).all();
    },
    async count() { return Number(db.prepare('SELECT COUNT(*) AS value FROM api_keys').get().value); },
    async create(input) {
      const id = `key_${crypto.randomUUID()}`;
      const prefix = crypto.randomBytes(5).toString('hex');
      const secret = `llm_${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
      const now = new Date().toISOString();
      db.prepare('INSERT INTO api_keys(id, name, prefix, secret_hash, enabled, expires_at, models, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)')
        .run(id, String(input.name || '未命名 Key').trim(), prefix, digest(secret), String(input.expires_at || ''), JSON.stringify(Array.isArray(input.models) ? input.models : []), now, now);
      return { ...(await this.findById(id)), key: secret };
    },
    async findById(id) { return sanitized(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)); },
    async update(id, input) {
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
      if (!row) return null;
      db.prepare('UPDATE api_keys SET name = ?, enabled = ?, expires_at = ?, models = ?, updated_at = ? WHERE id = ?').run(
        String(input.name ?? row.name).trim(), input.enabled === undefined ? row.enabled : input.enabled === false ? 0 : 1,
        String(input.expires_at ?? row.expires_at), JSON.stringify(Array.isArray(input.models) ? input.models : JSON.parse(row.models || '[]')),
        new Date().toISOString(), id,
      );
      return this.findById(id);
    },
    async delete(id) { db.prepare('DELETE FROM api_keys WHERE id = ?').run(id); },
    async authenticate(secret) {
      const match = /^llm_([a-f0-9]{10})_/.exec(String(secret || ''));
      if (!match) return null;
      const row = db.prepare('SELECT * FROM api_keys WHERE prefix = ?').get(match[1]);
      if (!row || row.enabled !== 1 || (row.expires_at && row.expires_at < new Date().toISOString())) return null;
      const actual = Buffer.from(digest(secret), 'hex');
      const expected = Buffer.from(row.secret_hash, 'hex');
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? sanitized(row) : null;
    },
  };
}

function createApiKeysHandler(repository, settingsRepository) {
  return async function handleApiKeys(request) {
    const url = new URL(request.url);
    if (url.pathname === '/admin/api-keys/settings') {
      if (request.method === 'GET') return response({ success: true, required: settingsRepository.get('api_auth_required', false) === true });
      if (request.method === 'POST') {
        const input = await request.json();
        if (input.required === true && await repository.count() === 0) return response({ success: false, error: '请先创建至少一个 Key' }, 400);
        settingsRepository.set('api_auth_required', input.required === true);
        return response({ success: true, required: input.required === true });
      }
    }
    if (url.pathname !== '/admin/api-keys') return null;
    if (request.method === 'GET') return response({
      success: true,
      keys: await repository.list(),
      usage_keys: await repository.listUsageKeys(),
      required: settingsRepository.get('api_auth_required', false) === true,
    });
    if (request.method === 'POST') return response({ success: true, api_key: await repository.create(await request.json()) }, 201);
    if (request.method === 'PATCH') {
      const id = url.searchParams.get('id');
      const key = id && await repository.update(id, await request.json());
      return key ? response({ success: true, api_key: key }) : response({ success: false, error: 'Key not found' }, 404);
    }
    if (request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return response({ success: false, error: 'id required' }, 400);
      await repository.delete(id);
      return response({ success: true });
    }
    return response({ success: false, error: 'Method not allowed' }, 405);
  };
}

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || request.headers.get('x-api-key') || '';
}

module.exports = { bearerToken, createApiKeyRepository, createApiKeysHandler, digest };
