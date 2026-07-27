'use strict';

const crypto = require('crypto');

function number(value) { return Math.max(0, Number(value || 0)); }
function emptyStats() { return { count: 0, input: 0, output: 0, cache: 0, cache_create: 0, consumed: 0, cost: 0 }; }

function normalizeIp(value) {
  const ip = String(value || '').trim();
  if (ip === '::1') return '127.0.0.1';
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped ? mapped[1] : ip;
}

function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return normalizeIp(forwarded?.split(',')[0] || request.headers.get('x-real-ip') || request.headers.get('x-llm-remote-address'));
}

function modelPrice(account, model) {
  const prices = account?.model_prices || {};
  return prices[model] || prices['*'] || {};
}

function usageCost(account, model, usage = {}) {
  const price = modelPrice(account, model);
  const input = number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const output = number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens);
  return number((input * number(price.input) + output * number(price.output)) / 1_000_000);
}

function summarize(logs) {
  const accounts = new Map();
  const models = new Map();
  let success = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  for (const log of logs) {
    const ok = Number(log.status) >= 200 && Number(log.status) < 400;
    if (ok) success += 1;
    totalInput += number(log.input_tokens);
    totalOutput += number(log.output_tokens);
    totalCost += number(log.cost);
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
      item.cost += number(log.cost);
      map.set(name, item);
    }
  }
  const toRows = map => [...map].map(([name, values]) => ({ name, ...values }));
  return {
    total_count: logs.length,
    success_count: success,
    fail_count: logs.length - success,
    total_input: totalInput,
    total_output: totalOutput,
    total_tokens: totalInput + totalOutput,
    total_cost: Number(totalCost.toFixed(12)),
    byAccount: toRows(accounts),
    byModel: toRows(models),
  };
}

function summarizeTargets(logs) {
  const targets = new Map();
  for (const log of logs) {
    const accountName = log.account_name || '';
    const model = log.requested_model || '';
    if (!accountName && !model) continue;
    const key = `${accountName}\u0000${model}`;
    const target = targets.get(key) || { account_name: accountName, model, count: 0, input: 0, output: 0, cost: 0 };
    target.count += 1;
    target.input += number(log.input_tokens);
    target.output += number(log.output_tokens);
    target.cost += number(log.cost);
    targets.set(key, target);
  }
  return [...targets.values()].map(target => ({ ...target, cost: Number(target.cost.toFixed(12)) }));
}

function dailyTrend(logs, range, now = new Date()) {
  const days = range === 'month' ? 30 : 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
  const grouped = new Map();
  for (const log of logs) {
    const created = new Date(log.created_at);
    if (!Number.isFinite(created.getTime()) || created < start || created > now) continue;
    const key = created.toISOString().slice(0, 10);
    const bucket = grouped.get(key) || [];
    bucket.push(log);
    grouped.set(key, bucket);
  }
  const buckets = [];
  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const key = date.toISOString().slice(0, 10);
    const summary = summarize(grouped.get(key) || []);
    buckets.push({
      key,
      count: summary.total_count,
      input: summary.total_input,
      output: summary.total_output,
      cost: summary.total_cost,
      byAccount: summary.byAccount,
      byTarget: summarizeTargets(grouped.get(key) || []),
    });
  }
  return { range: range === 'month' ? 'month' : 'week', buckets };
}

function usageEntry({ requestId, account, model, upstreamModel, requestPath, clientIp: callerIp, status, durationMs, stream, error, attempts = [], usage = {} }) {
  const id = requestId || `usage_${crypto.randomUUID()}`;
  const inputTokens = number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const outputTokens = number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens);
  return {
    id,
    request_id: id,
    account_id: account?.id || '',
    account_name: account?.name || '',
    requested_model: model || '',
    upstream_model: upstreamModel || model || '',
    request_path: requestPath || '',
    client_ip: callerIp || '',
    status: Number(status || 0),
    duration_ms: Number(durationMs || 0),
    stream: stream === true,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: number(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens,
    cache_tokens: number(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cachedInputTokens),
    cache_create_tokens: number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    consumed: 0,
    cost: usageCost(account, upstreamModel || model, usage),
    attempts,
    error: error || '',
    created_at: new Date().toISOString(),
  };
}

function endOfDay(value) {
  if (!value) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
}

function filterLogs(logs, searchParams) {
  const accountId = searchParams.get('account_id') || '';
  const model = (searchParams.get('model') || '').toLowerCase();
  const callerIp = searchParams.get('client_ip') || '';
  const status = searchParams.get('status') || '';
  const from = searchParams.get('from') || '';
  const to = endOfDay(searchParams.get('to') || '');
  return logs.filter(log => {
    const code = Number(log.status || 0);
    if (accountId && log.account_id !== accountId) return false;
    if (model && !String(log.requested_model || '').toLowerCase().includes(model)) return false;
    if (callerIp && !String(log.client_ip || '').includes(callerIp)) return false;
    if (status === 'success' && !(code >= 200 && code < 400)) return false;
    if (status === 'error' && code >= 200 && code < 400) return false;
    if (status && !['success', 'error'].includes(status) && code !== Number(status)) return false;
    if (from && String(log.created_at || '') < from) return false;
    if (to && String(log.created_at || '') > to) return false;
    return true;
  });
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
      const allLogs = filterLogs(await repository.list(), url.searchParams);
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
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60_000);
      return response({
        success: true,
        cumulative: summarize(logs),
        daily: summarize(logs.filter(log => String(log.created_at || '').startsWith(today))),
        recent5h: summarize(logs.filter(log => {
          const created = new Date(log.created_at);
          return Number.isFinite(created.getTime()) && created >= fiveHoursAgo && created <= now;
        })),
        trend: dailyTrend(logs, url.searchParams.get('range') || 'week', now),
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

module.exports = { clientIp, createMemoryUsageRepository, createUsageHandler, dailyTrend, filterLogs, normalizeIp, summarize, usageCost, usageEntry };
