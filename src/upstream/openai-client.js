'use strict';

function targetUrl(baseUrl, requestPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/v\d+$/.test(base) && /^\/v\d+\//.test(requestPath)) {
    return base.replace(/\/v\d+$/, '') + requestPath;
  }
  if (base.endsWith(requestPath)) return base;
  return base + requestPath;
}

function proxyOpenAI({ account, body, requestPath, signal, fetch: fetchUpstream = fetch }) {
  return fetchUpstream(targetUrl(account.base_url, requestPath), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.api_key}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

module.exports = { proxyOpenAI, targetUrl };
