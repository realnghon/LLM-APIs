'use strict';

const crypto = require('crypto');

function number(value) { return Math.max(0, Number(value || 0)); }
function emptyStats() { return { count: 0, input: 0, output: 0, cache: 0, cache_create: 0, consumed: 0 }; }

function summarize(logs) {
  const accounts = new Map();
  const models = new Map();
  let success = 0;
  for (const log of logs) {
    const ok = Number(log.status) >= 200 && Number(log.status) < 400;
    if (ok) success += 1;
    const targets = [[accounts, log.account_name], [models, log.requested_model]];
    for (const [map, name] of targets) {
      if (!name) continue;
      const item = map.get(name) || emptyStats();
      item.count += 1;
      item.input += number(log.input_tokens);
      item.output += number(log.output_tokens);
      item.cache += number(log.cache_tokens);
      item.cache_create += number(log.cache_create_tokens);
      item.consumed += number(log.consumed);
      map.set(name, item);
    }
  }
  const toRows = map => [...map].map(([name, values]) => ({ name, ...values }));
  return {
    total_count: logs.length,
    success_count: success,
    fail_count: logs.length - success,
    byAccount: toRows(accounts),
    byModel: toRows(models),
  };
}

function usageEntry({ account, model, upstreamModel, status, durationMs, stream, error, usage = {} }) {
  const id = `usage_${crypto.randomUUID()}`;
  return {
    id,
    request_id: id,
    account_id: account?.id || '',
    account_name: account?.name || '',
    requested_model: model || '',
    upstream_model: upstreamModel || model || '',
    status: Number(status || 0),
    duration_ms: Number(durationMs || 0),
    stream: stream === true,
    input_tokens: number(usage.prompt_tokens ?? usage.input_tokens),
    output_tokens: number(usage.completion_tokens ?? usage.output_tokens),
    total_tokens: number(usage.total_tokens),
    cache_tokens: number(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    cache_create_tokens: number(usage.cache_creation_input_tokens),
    consumed: 0,
    error: error || '',
    created_at: new Date().toISOString(),
  };
}

function response(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function createUsageHandler(repository) {
  return async function handleUsage(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/admin/usage')) return null;

    if (url.pathname === '/admin/usage' && request.method === 'DELETE') {
      await repository.clear();
      return response({ success: true });
    }

    if (url.pathname === '/admin/usage' && request.method === 'GET') {
      const allLogs = await repository.list();
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 25)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const logs = allLogs.slice(offset, offset + limit);
      const successCount = allLogs.filter(log => Number(log.status) >= 200 && Number(log.status) < 400).length;
      return response({
        success: true,
        logs,
        total: allLogs.length,
        stats: { success_count: successCount, error_count: allLogs.length - successCount },
      });
    }

    if (url.pathname === '/admin/usage/stats' && request.method === 'GET') {
      const logs = await repository.list();
      const today = new Date().toISOString().slice(0, 10);
      return response({
        success: true,
        cumulative: summarize(logs),
        daily: summarize(logs.filter(log => String(log.created_at || '').startsWith(today))),
      });
    }

    return response({ success: false, error: 'Not found' }, 404);
  };
}

function createMemoryUsageRepository() {
  const logs = [];
  return {
    async list() { return logs.slice(); },
    async record(entry) { logs.unshift(entry); },
    async clear() { logs.length = 0; },
  };
}

module.exports = { createMemoryUsageRepository, createUsageHandler, summarize, usageEntry };
