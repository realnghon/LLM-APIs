'use strict';

const crypto = require('crypto');
const { testAccount } = require('./upstream/ai-sdk-client');

function numberInRange(value, fallback, minimum, maximum = Infinity) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function cleanModelMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, model]) => [String(key).trim(), String(model).trim()])
    .filter(([key, model]) => key && model));
}

function cleanAllowance(input, existing) {
  if (!input || input.type !== 'total') return null;
  const quotaTotal = Math.max(0, Number(input.quota_total || 0));
  const unchanged = existing?.type === 'total'
    && existing.quota_mode === input.quota_mode
    && Number(existing.quota_total || 0) === quotaTotal;
  return {
    ...input,
    type: 'total',
    quota_total: quotaTotal,
    remaining: unchanged
      ? Math.max(0, Number(existing.remaining ?? quotaTotal))
      : Math.max(0, Number(input.remaining ?? quotaTotal)),
  };
}

function sanitizeAccount(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || input.id || `acc_${crypto.randomUUID()}`,
    name: String(input.name || existing.name || '').trim(),
    base_url: String(input.base_url ?? existing.base_url ?? '').trim().replace(/\/+$/, ''),
    api_key: String(input.api_key ?? existing.api_key ?? '').trim(),
    format: input.format === 'anthropic' ? 'anthropic' : 'openai',
    models: Array.isArray(input.models)
      ? [...new Set(input.models.map(model => String(model).trim()).filter(Boolean))]
      : (existing.models || []),
    model_map: input.model_map === undefined ? (existing.model_map || {}) : cleanModelMap(input.model_map),
    priority: numberInRange(input.priority, existing.priority || 1, 1),
    weight: numberInRange(input.weight, existing.weight || 1, 1, 10),
    max_concurrency: numberInRange(input.max_concurrency, existing.max_concurrency || 0, 0),
    enabled: input.enabled === undefined ? existing.enabled !== false : input.enabled !== false,
    note: String(input.note ?? existing.note ?? '').trim(),
    allowance: Object.prototype.hasOwnProperty.call(input, 'allowance')
      ? cleanAllowance(input.allowance, existing.allowance)
      : cleanAllowance(existing.allowance, existing.allowance),
    created_at: existing.created_at || now,
    updated_at: now,
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function createAccountsHandler(repository) {
  return async function handleAccounts(request) {
    const url = new URL(request.url);

    if (url.pathname === '/admin/accounts/test' && request.method === 'POST') {
      const input = await request.json();
      const account = (await repository.list()).find(item => item.id === input.id);
      if (!account) return response({ success: false, error: 'Account not found' }, 404);
      try {
        const results = await testAccount(account, input.testIndices);
        return response({ success: true, name: account.name, results });
      } catch (error) {
        return response({ success: false, error: error.message }, 400);
      }
    }

    if (url.pathname === '/admin/accounts/fetch-models' && request.method === 'POST') {
      const input = await request.json();
      const baseUrl = String(input.base_url || '').trim().replace(/\/+$/, '');
      const apiKey = String(input.api_key || '').trim();
      if (!baseUrl || !apiKey) return response({ success: false, error: 'Base URL 和 API Key 不能为空' }, 400);
      try {
        const modelsResponse = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!modelsResponse.ok) throw new Error(`上游返回 ${modelsResponse.status}`);
        const data = await modelsResponse.json();
        const models = (data.data || data.models || [])
          .map(item => String(item.id || item.model || item).trim())
          .filter(Boolean);
        return response({ success: true, models: [...new Set(models)] });
      } catch (error) {
        return response({ success: false, error: error.message || '获取模型失败' }, 400);
      }
    }

    if (url.pathname === '/admin/accounts/reorder' && request.method === 'POST') {
      const input = await request.json();
      if (!Array.isArray(input.ids)) return response({ success: false, error: 'ids array required' }, 400);
      await repository.reorder(input.ids);
      return response({ success: true });
    }

    if (url.pathname !== '/admin/accounts') return null;

    if (request.method === 'GET') {
      const accounts = await repository.list();
      const accountQuotas = {};
      for (const account of accounts) {
        if (account.allowance?.type === 'total') accountQuotas[account.id] = account.allowance;
      }
      return response({
        success: true,
        accounts,
        allowance_config: { account_quotas: accountQuotas },
        allowance_status: {},
      });
    }

    if (request.method === 'POST') {
      const input = await request.json();
      const accounts = await repository.list();
      const existing = input.id ? accounts.find(account => account.id === input.id) : null;
      const account = sanitizeAccount(input, existing || {});
      if (!account.name || !account.base_url || !account.api_key || account.models.length === 0) {
        return response({ success: false, error: '名称、接口地址、API Key 和模型不能为空' }, 400);
      }
      await repository.save(account);
      return response({ success: true, account });
    }

    if (request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return response({ success: false, error: 'id required' }, 400);
      if (typeof repository.delete !== 'function') return response({ success: false, error: 'Delete is not supported' }, 501);
      await repository.delete(id);
      return response({ success: true });
    }

    return response({ success: false, error: 'Method not allowed' }, 405);
  };
}

module.exports = { createAccountsHandler, sanitizeAccount };
