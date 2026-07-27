'use strict';

const { createAuth, expiredSessionCookie, sessionCookie } = require('./auth');
const { loadAdminCredentials } = require('./config');
const { renderLoginPage } = require('./admin/login-page');
const { createAccountsHandler } = require('./accounts');
const { createProxyHandler } = require('./proxy');
const { createFileAccountRepository } = require('./storage/file-account-repository');
const { isAdminShellPath, serveAdminAsset, serveAdminShell } = require('./admin/static');
const { createFileUsageRepository } = require('./storage/file-usage-repository');
const { createMemoryUsageRepository, createUsageHandler } = require('./usage');
const { createMemoryStatusRepository, createStatusHandler, createStatusMonitor } = require('./status');
const { createFileStatusRepository } = require('./storage/file-status-repository');
const { createCoreHandler } = require('./core');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  const accountRepository = options.accountRepository || createFileAccountRepository(dataFile);
  const usageRepository = options.usageRepository || (options.accountRepository
    ? createMemoryUsageRepository()
    : createFileUsageRepository(dataFile, { retention: options.usageRetention }));
  const appHandler = options.appHandler || createCoreHandler(accountRepository);
  const statusRepository = options.statusRepository || (options.accountRepository
    ? createMemoryStatusRepository()
    : createFileStatusRepository(dataFile));
  const statusMonitor = options.statusMonitor || createStatusMonitor({
    accountRepository,
    statusRepository,
    testAccountFn: options.accountTester,
  });
  const accountsHandler = createAccountsHandler(accountRepository, { statusRepository });
  const usageHandler = createUsageHandler(usageRepository);
  const statusHandler = createStatusHandler(statusMonitor);
  const proxyHandler = createProxyHandler({
    accountRepository,
    usageRepository,
    fetch: options.upstreamFetch,
    random: options.random,
  });

  return async function handle(request) {
    const url = new URL(request.url);
    const isAdmin = url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname.startsWith('/admin/');
    const isPublicApi = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v3/');

    if (isPublicApi && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
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
  };
}

function requestFromNode(req, body) {
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
  });
}

async function sendNodeResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  if (response.body) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
}

function createHttpHandler(options = {}) {
  const handle = createWebHandler(options);
  return async function httpHandler(req, res) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = requestFromNode(req, Buffer.concat(chunks));
      await sendNodeResponse(res, await handle(request));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  };
}

module.exports = { createHttpHandler, createWebHandler };
