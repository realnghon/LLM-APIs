'use strict';

const fs = require('fs/promises');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const ADMIN_SHELL = ['admin/index.html', 'text/html; charset=utf-8'];
const ADMIN_SHELL_PATHS = new Set([
  '/admin',
  '/admin/',
  '/admin/accounts',
  '/admin/usage',
  '/admin/stats',
  '/admin/status',
]);
const ASSETS = new Map([
  ['/assets/admin.css', ['admin/admin.css', 'text/css; charset=utf-8']],
  ['/assets/admin.js', ['admin/admin.js', 'text/javascript; charset=utf-8']],
  ['/assets/login.css', ['admin/login.css', 'text/css; charset=utf-8']],
  ['/assets/lucide.js', ['admin/vendor/lucide.min.js', 'text/javascript; charset=utf-8']],
  ['/assets/echarts.js', ['admin/vendor/echarts.min.js', 'text/javascript; charset=utf-8']],
]);

function isDocumentRequest(request) {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode === 'navigate' || mode === 'nested-navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

function isAdminShellPath(pathname, request = null) {
  if (!ADMIN_SHELL_PATHS.has(pathname)) return false;
  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/stats') return true;
  if (!request || request.method !== 'GET') return false;
  return isDocumentRequest(request);
}

async function readPublicFile(relativePath, contentType, cacheControl) {
  const filePath = relativePath.startsWith('..')
    ? path.resolve(PUBLIC_DIR, relativePath)
    : path.join(PUBLIC_DIR, relativePath);
  try {
    return new Response(await fs.readFile(filePath), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

async function serveAdminShell() {
  const [relativePath, contentType] = ADMIN_SHELL;
  return readPublicFile(relativePath, contentType, 'no-store');
}

async function serveAdminAsset(request) {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'GET' && isAdminShellPath(pathname, request)) {
    return serveAdminShell();
  }
  const asset = ASSETS.get(pathname);
  if (!asset || request.method !== 'GET') return null;
  const [relativePath, contentType] = asset;
  return readPublicFile(
    relativePath,
    contentType,
    pathname.startsWith('/assets/') ? 'public, max-age=300' : 'no-store',
  );
}

module.exports = {
  isAdminShellPath,
  isDocumentRequest,
  serveAdminAsset,
  serveAdminShell,
};
