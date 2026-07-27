'use strict';

const { usageEntry } = require('./usage');
const { proxyAnthropic } = require('./upstream/anthropic-client');
const { allowanceDebit, hasRemainingAllowance } = require('./allowance');
const { createConcurrencyLimiter, finalizeStream } = require('./concurrency');

function mappedModel(account, requestedModel) {
  const requested = requestedModel.toLowerCase();
  for (const [clientModel, upstreamModel] of Object.entries(account.model_map || {})) {
    if (clientModel.toLowerCase() === requested) return upstreamModel;
  }
  return (account.models || []).some(model => String(model).toLowerCase() === requested)
    ? requestedModel
    : null;
}

function weightedOrder(accounts, random = Math.random) {
  return accounts
    .map(account => ({
      account,
      score: Math.log(Math.max(Number.EPSILON, random())) / Math.max(1, Number(account.weight) || 1),
    }))
    .sort((left, right) => right.score - left.score)
    .map(item => item.account);
}

function orderedCandidates(accounts, model, random) {
  const candidates = accounts.filter(account => account.enabled !== false && mappedModel(account, model) !== null);
  const priorities = [...new Set(candidates.map(account => Math.max(1, Number(account.priority) || 1)))].sort((a, b) => a - b);
  return priorities.flatMap(priority => weightedOrder(
    candidates.filter(account => Math.max(1, Number(account.priority) || 1) === priority),
    random,
  ));
}

function targetUrl(baseUrl, requestPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v\d+$/.test(base) && /^\/v\d+\//.test(requestPath)) {
    return base.replace(/\/v\d+$/, '') + requestPath;
  }
  if (base.endsWith(requestPath)) return base;
  return base + requestPath;
}

function shouldFailOver(status) {
  return status >= 500 || [401, 403, 408, 409, 425, 429].includes(status);
}

function responseHeaders(upstreamHeaders, extra = {}) {
  const headers = new Headers(upstreamHeaders);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}

function createProxyHandler({ accountRepository, usageRepository, fetch: fetchUpstream = fetch, random = Math.random }) {
  const concurrency = createConcurrencyLimiter();
  return async function handleProxy(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/v3/'))) {
      return null;
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: { message: 'Invalid JSON' } }, { status: 400 });
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) return Response.json({ error: { message: 'model is required' } }, { status: 400 });

    const candidates = orderedCandidates(await accountRepository.list(), model, random);
    if (candidates.length === 0) {
      return Response.json({ error: { message: `Model '${model}' not available.` } }, { status: 404 });
    }

    let lastError = '';
    let exhaustedByAllowance = false;
    for (const account of candidates) {
      const upstreamModel = mappedModel(account, model);
      if (!hasRemainingAllowance(account)) {
        exhaustedByAllowance = true;
        lastError = `[${account.name || account.id}] allowance exhausted`;
        continue;
      }
      const upstreamBody = upstreamModel === model ? body : { ...body, model: upstreamModel };
      const release = concurrency.acquire(account);
      if (!release) {
        lastError = `[${account.name || account.id}] concurrency limit`;
        continue;
      }
      const startedAt = Date.now();
      try {
        const response = account.format === 'anthropic'
          ? await proxyAnthropic({ account, body: upstreamBody, requestedModel: model, upstreamModel })
          : await fetchUpstream(targetUrl(account.base_url, url.pathname), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${account.api_key}`,
            },
            body: JSON.stringify(upstreamBody),
            signal: request.signal,
          });
        const headers = responseHeaders(response.headers, {
          'X-Upstream-Account': account.name || account.id,
          'X-Upstream-Time': `${Date.now() - startedAt}ms`,
        });
        let responseUsage = {};
        if (body.stream !== true && response.headers.get('content-type')?.includes('application/json')) {
          try { responseUsage = (await response.clone().json()).usage || {}; } catch { /* upstream usage is optional */ }
        }
        if (usageRepository) {
          await usageRepository.record(usageEntry({
            account,
            model,
            upstreamModel,
            status: response.status,
            durationMs: Date.now() - startedAt,
            stream: body.stream === true,
            usage: responseUsage,
          }));
        }
        if (!shouldFailOver(response.status)) {
          if (response.ok && typeof accountRepository.debitAllowance === 'function') {
            const debit = allowanceDebit(account, upstreamModel, responseUsage);
            if (debit > 0) await accountRepository.debitAllowance(account.id, debit);
          }
          const responseBody = body.stream === true
            ? finalizeStream(response.body, release)
            : (release(), response.body);
          return new Response(responseBody, { status: response.status, headers });
        }
        lastError = `[${account.name || account.id}] upstream ${response.status}`;
        await response.body?.cancel().catch(() => {});
        release();
      } catch (error) {
        release();
        lastError = `[${account.name || account.id}] ${error.message}`;
        if (usageRepository) {
          await usageRepository.record(usageEntry({
            account,
            model,
            upstreamModel,
            status: 0,
            durationMs: Date.now() - startedAt,
            stream: body.stream === true,
            error: error.message,
          }));
        }
      }
    }

    const status = exhaustedByAllowance && lastError.includes('allowance exhausted') ? 503 : 502;
    return Response.json({
      error: { message: `${status === 503 ? 'No upstream account with remaining allowance' : 'All upstream accounts failed'}. Last: ${lastError}` },
    }, { status });
  };
}

module.exports = { createProxyHandler, mappedModel, orderedCandidates, shouldFailOver };
