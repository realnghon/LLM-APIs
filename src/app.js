'use strict';

const { createAuth, expiredSessionCookie, sessionCookie } = require('./auth');
const { loadAdminCredentials } = require('./config');
const { renderLoginPage } = require('./admin/login-page');
const { createAccountsHandler } = require('./accounts');
const { createProxyHandler } = require('./proxy');
const { isAdminShellPath, serveAdminAsset, serveAdminShell } = require('./admin/static');
const { createMemoryUsageRepository, createUsageHandler } = require('./usage');
const { createMemoryStatusRepository, createStatusHandler, createStatusMonitor } = require('./status');
const { createCoreHandler } = require('./core');
const { createSqliteStore } = require('./storage/sqlite-store');
const { bearerToken, createApiKeyRepository, createApiKeysHandler } = require('./api-keys');
const { createPricingHandler } = require('./pricing');
const { createLogger } = require('./logger');
const { once } = require('events');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function redirect(location, status = 302, headers = {}) {
  return new Response(null, { status, headers: { Location: location, ...headers } });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createWebHandler(options = {}) {
  const auth = createAuth(options.credentials || loadAdminCredentials(options.configPath));
  const dataFile = options.dataFile || process.env.DATA_FILE || require('path').join(__dirname, '..', 'apis-data', 'kv.json');
  const store = options.store || (!options.accountRepository ? createSqliteStore(dataFile, options) : null);
  const accountRepository = options.accountRepository || store?.accountRepository;
  if (!accountRepository) throw new Error('An account repository or complete SQLite store is required');
  const usageRepository = options.usageRepository || store?.usageRepository || createMemoryUsageRepository();
  const appHandler = options.appHandler || createCoreHandler(accountRepository);
  const statusRepository = options.statusRepository || store?.statusRepository || createMemoryStatusRepository();
  const statusMonitor = options.statusMonitor || createStatusMonitor({
    accountRepository,
    statusRepository,
    testAccountFn: options.accountTester,
  });
  const accountsHandler = createAccountsHandler(accountRepository, { statusRepository });
  const apiKeySettings = options.apiKeySettingsRepository || store?.settingsRepository || null;
  const apiKeyRepository = options.apiKeyRepository || (store ? createApiKeyRepository(store.db, apiKeySettings) : null);
  const apiKeysHandler = apiKeyRepository && apiKeySettings && createApiKeysHandler(apiKeyRepository, apiKeySettings);
  const pricingHandler = store && createPricingHandler(store.priceRepository, accountRepository);
  const usageHandler = createUsageHandler(usageRepository);
  const statusHandler = createStatusHandler(statusMonitor);
  const proxyHandler = createProxyHandler({
    accountRepository,
    usageRepository,
    fetch: options.upstreamFetch,
    random: options.random,
  });

  async function handle(request) {
    const url = new URL(request.url);
    const isAdmin = url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/');
    const isPublicApi = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v3/');

    if (isPublicApi && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (isPublicApi && apiKeyRepository) {
      const required = apiKeySettings?.get('api_auth_required', false) === true;
      const token = bearerToken(request);
      const key = token ? await apiKeyRepository.authenticate(token) : null;
      if ((required && !key) || (token && !key)) return withCors(Response.json({ error: { message: 'Invalid or missing API key', type: 'authentication_error' } }, {
        status: 401, headers: { 'WWW-Authenticate': 'Bearer' },
      }));
      if (!key) {
        request.apiKey = null;
      } else {
        const allowedModels = key.models || [];
        if (request.method === 'POST') {
          const clone = request.clone();
          try { request.parsedBody = await clone.json(); } catch {}
          const model = String(request.parsedBody?.model || '');
          if (allowedModels.length && model && !allowedModels.some(item => item.toLowerCase() === model.toLowerCase())) {
            return withCors(Response.json({ error: { message: `Model '${model}' is not allowed for this API key` } }, { status: 403 }));
          }
        }
        request.apiKey = key;
      }
    }

    if (url.pathname.startsWith('/assets/')) {
      const asset = await serveAdminAsset(request);
      if (asset) return asset;
    }

    if (url.pathname === '/login' && request.method === 'GET') {
      if (auth.isAuthenticated(request.headers.get('cookie'))) return redirect('/admin');
      return html(renderLoginPage());
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      const form = await request.formData();
      const token = auth.authenticate(form.get('username'), form.get('password'));
      if (!token) return html(renderLoginPage(true), 401);
      return redirect('/admin', 303, { 'Set-Cookie': sessionCookie(token) });
    }

    if (url.pathname === '/logout' && request.method === 'POST') {
      auth.clear(request.headers.get('cookie'));
      return redirect('/login', 303, { 'Set-Cookie': expiredSessionCookie() });
    }

    if (isAdmin && !auth.isAuthenticated(request.headers.get('cookie'))) {
      if (isAdminShellPath(url.pathname, request)) return redirect('/login');
      return json({ success: false, error: 'Unauthorized' }, 401);
    }

    if (isAdminShellPath(url.pathname, request)) {
      return serveAdminShell();
    }

    if (accountsHandler) {
      const response = await accountsHandler(request);
      if (response) return response;
    }

    if (apiKeysHandler) {
      const response = await apiKeysHandler(request);
      if (response) return response;
    }

    if (pricingHandler) {
      const response = await pricingHandler(request);
      if (response) return response;
    }

    if (statusHandler) {
      const response = await statusHandler(request);
      if (response) return response;
    }

    if (usageHandler) {
      const response = await usageHandler(request);
      if (response) return response;
    }

    if (proxyHandler) {
      const response = await proxyHandler(request);
      if (response) return isPublicApi ? withCors(response) : response;
    }

    const response = await appHandler(request);
    return isPublicApi ? withCors(response) : response;
  }
  handle.dispose = async () => {
    statusMonitor.dispose?.();
    store?.close();
  };
  return handle;
}

function requestFromNode(req, body, signal) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['x-llm-remote-address'] = req.socket?.remoteAddress || '';
  return new Request(url, {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
    signal,
  });
}

async function sendNodeResponse(res, response, signal) {
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  if (response.body) {
    try {
      for await (const chunk of response.body) {
        if (signal.aborted || res.destroyed) break;
        if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
    } finally {
      if (signal.aborted || res.destroyed) await response.body.cancel(signal.reason).catch(() => {});
    }
  }
  if (!res.destroyed) res.end();
}

function createHttpHandler(options = {}) {
  const handle = createWebHandler(options);
  const logger = options.logger || createLogger();
  const configuredBodyBytes = Number(options.maximumBodyBytes || process.env.MAX_REQUEST_BODY_BYTES);
  const maximumBodyBytes = Number.isFinite(configuredBodyBytes)
    ? Math.max(1024, configuredBodyBytes)
    : 10 * 1024 * 1024;
  async function httpHandler(req, res) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('downstream disconnected'));
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableEnded) abort(); });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maximumBodyBytes) {
          res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: { message: 'Request body too large' } }));
          return;
        }
        chunks.push(chunk);
      }
      const request = requestFromNode(req, Buffer.concat(chunks), controller.signal);
      const response = await handle(request);
      await sendNodeResponse(res, response, controller.signal);
      logger.debug('request_completed', { method: req.method, path: req.url, status: response.status, duration_ms: Date.now() - startedAt });
    } catch (error) {
      logger.error('request_failed', { method: req.method, path: req.url, duration_ms: Date.now() - startedAt, error: error.message, stack: error.stack });
      if (res.headersSent) res.destroy(error);
      else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
      }
    }
  }
  httpHandler.dispose = handle.dispose;
  return httpHandler;
}

module.exports = { createHttpHandler, createWebHandler };
