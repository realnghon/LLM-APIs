'use strict';

const crypto = require('crypto');
const { clientIp, usageEntry } = require('./usage');
const { proxyAnthropic } = require('./upstream/anthropic-client');
const { proxyOpenAI } = require('./upstream/openai-client');
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

function balancedOrder(accounts, random = Math.random, active = () => 0) {
  return accounts
    .map(account => ({
      account,
      load: Math.max(0, Number(active(account) || 0)),
      score: random(),
    }))
    .sort((left, right) => left.load - right.load || left.score - right.score)
    .map(item => item.account);
}

function orderedCandidates(accounts, model, random, active) {
  const candidates = accounts.filter(account => account.enabled !== false && mappedModel(account, model) !== null);
  return balancedOrder(candidates, random, active);
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

function createSseUsageObserver(usage, onFirstToken = () => {}) {
  const decoder = new TextDecoder();
  let buffered = '';
  return chunk => {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage && typeof parsed.usage === 'object') Object.assign(usage, parsed.usage);
        const content = parsed.choices?.some(choice => choice.delta?.content || choice.text)
          || parsed.delta?.text || parsed.content_block?.text;
        if (content) onFirstToken();
      } catch { /* non-JSON SSE events do not carry usage */ }
    }
  };
}

function createProxyHandler({ accountRepository, usageRepository, fetch: fetchUpstream = fetch, random = Math.random }) {
  const concurrency = createConcurrencyLimiter();
  return async function handleProxy(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/v3/'))) {
      return null;
    }

    const requestId = `usage_${crypto.randomUUID()}`;
    const requestStartedAt = Date.now();
    const callerIp = clientIp(request);
    const apiKey = request.apiKey || null;
    let firstTokenMs = null;
    const attempts = [];
    async function record(result) {
      if (!usageRepository) return;
      try {
        await usageRepository.record(usageEntry({
          requestId,
          requestPath: url.pathname,
          clientIp: callerIp,
          durationMs: Date.now() - requestStartedAt,
          firstTokenMs,
          attempts,
          apiKey,
          ...result,
        }));
      } catch (error) {
        console.error(`[LLM-APIs] usage record failed: ${error.message}`);
      }
    }

    let body;
    try {
      body = request.parsedBody || await request.json();
    } catch {
      await record({ status: 400, error: 'Invalid JSON' });
      return Response.json({ error: { message: 'Invalid JSON' } }, { status: 400 });
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      await record({ status: 400, error: 'model is required' });
      return Response.json({ error: { message: 'model is required' } }, { status: 400 });
    }

    const candidates = orderedCandidates(await accountRepository.list(), model, random, account => concurrency.active(account));
    if (candidates.length === 0) {
      await record({ model, status: 404, error: `Model '${model}' not available.` });
      return Response.json({ error: { message: `Model '${model}' not available.` } }, { status: 404 });
    }

    let lastError = '';
    let exhaustedByAllowance = false;
    let lastAccount = null;
    let lastUpstreamModel = model;
    for (const account of candidates) {
      const upstreamModel = mappedModel(account, model);
      lastAccount = account;
      lastUpstreamModel = upstreamModel;
      if (!hasRemainingAllowance(account)) {
        exhaustedByAllowance = true;
        lastError = `[${account.name || account.id}] allowance exhausted`;
        attempts.push({ account_id: account.id, account_name: account.name, status: 0, duration_ms: 0, error: 'allowance exhausted' });
        continue;
      }
      let countReserved = false;
      if (account.allowance?.quota_mode === 'count' && typeof accountRepository.reserveCountAllowance === 'function') {
        countReserved = await accountRepository.reserveCountAllowance(account.id);
        if (!countReserved) {
          exhaustedByAllowance = true;
          lastError = `[${account.name || account.id}] allowance exhausted`;
          attempts.push({ account_id: account.id, account_name: account.name, status: 0, duration_ms: 0, error: 'allowance exhausted' });
          continue;
        }
      }
      let upstreamBody = upstreamModel === model ? body : { ...body, model: upstreamModel };
      if (body.stream === true && account.format !== 'anthropic') {
        upstreamBody = { ...upstreamBody, stream_options: { ...(body.stream_options || {}), include_usage: true } };
      }
      const release = concurrency.acquire(account);
      if (!release) {
        if (countReserved && typeof accountRepository.refundCountAllowance === 'function') await accountRepository.refundCountAllowance(account.id);
        lastError = `[${account.name || account.id}] concurrency limit`;
        attempts.push({ account_id: account.id, account_name: account.name, status: 0, duration_ms: 0, error: 'concurrency limit' });
        continue;
      }
      const startedAt = Date.now();
      let deadline = null;
      try {
        let response;
        if (account.format === 'anthropic') {
          response = await proxyAnthropic({ account, body: upstreamBody, requestedModel: model, upstreamModel, signal: request.signal });
        } else {
          const upstream = proxyOpenAI({ account, body: upstreamBody, requestPath: url.pathname, signal: request.signal, fetch: fetchUpstream });
          deadline = upstream.deadline;
          response = await upstream.response;
        }
        const headers = responseHeaders(response.headers, {
          'X-Upstream-Account': account.name || account.id,
          'X-Upstream-Time': `${Date.now() - startedAt}ms`,
        });
        let responseUsage = {};
        let responseData = null;
        if (body.stream !== true) {
          responseData = await response.arrayBuffer();
          deadline?.cleanup();
          if (response.headers.get('content-type')?.includes('application/json')) {
            try { responseUsage = JSON.parse(new TextDecoder().decode(responseData)).usage || {}; } catch { /* upstream usage is optional */ }
          }
        }
        attempts.push({ account_id: account.id, account_name: account.name, status: response.status, duration_ms: Date.now() - startedAt, error: '' });
        if (!shouldFailOver(response.status)) {
          if (body.stream === true) {
            const observeUsage = createSseUsageObserver(responseUsage, () => {
              if (firstTokenMs === null) firstTokenMs = Date.now() - requestStartedAt;
            });
            const responseBody = finalizeStream(response.body, async () => {
              deadline?.cleanup();
              release();
              if (response.ok && !countReserved && typeof accountRepository.debitAllowance === 'function') {
                const debit = allowanceDebit(account, upstreamModel, responseUsage);
                if (debit > 0) await accountRepository.debitAllowance(account.id, debit);
              }
              await record({ account, model, upstreamModel, status: response.status, stream: true, usage: responseUsage });
            }, observeUsage);
            return new Response(responseBody, { status: response.status, headers });
          }
          const responseBody = new Response(responseData, { status: response.status, headers });
           if (response.ok && !countReserved && typeof accountRepository.debitAllowance === 'function') {
            const debit = allowanceDebit(account, upstreamModel, responseUsage);
            if (debit > 0) await accountRepository.debitAllowance(account.id, debit);
          }
          await record({ account, model, upstreamModel, status: response.status, stream: false, usage: responseUsage });
          release();
          return responseBody;
        }
        lastError = `[${account.name || account.id}] upstream ${response.status}`;
        if (countReserved && typeof accountRepository.refundCountAllowance === 'function') await accountRepository.refundCountAllowance(account.id);
        await response.body?.cancel().catch(() => {});
        deadline?.cleanup();
        release();
      } catch (error) {
        if (countReserved && typeof accountRepository.refundCountAllowance === 'function') await accountRepository.refundCountAllowance(account.id);
        deadline?.cleanup();
        release();
        lastError = `[${account.name || account.id}] ${error.message}`;
        attempts.push({ account_id: account.id, account_name: account.name, status: 0, duration_ms: Date.now() - startedAt, error: error.message });
      }
    }

    const status = exhaustedByAllowance && lastError.includes('allowance exhausted') ? 503 : 502;
    await record({ account: lastAccount, model, upstreamModel: lastUpstreamModel, status, stream: body.stream === true, error: lastError });
    return Response.json({
      error: { message: `${status === 503 ? 'No upstream account with remaining allowance' : 'All upstream accounts failed'}. Last: ${lastError}` },
    }, { status });
  };
}

module.exports = { createProxyHandler, mappedModel, orderedCandidates, shouldFailOver };
