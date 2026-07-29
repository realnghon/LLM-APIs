'use strict';

function targetUrl(baseUrl, requestPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v\d+$/.test(base) && /^\/v\d+\//.test(requestPath)) {
    return base.replace(/\/v\d+$/, '') + requestPath;
  }
  if (base.endsWith(requestPath)) return base;
  return base + requestPath;
}

function createDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('upstream request timeout')), Math.max(1, Number(timeoutMs || 120_000)));
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function proxyOpenAI({ account, body, requestPath, signal, fetch: fetchUpstream = fetch }) {
  const deadline = createDeadline(signal, account.request_timeout_ms);
  return {
    deadline,
    response: fetchUpstream(targetUrl(account.base_url, requestPath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${account.api_key}`,
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    }),
  };
}

module.exports = { proxyOpenAI, targetUrl };
