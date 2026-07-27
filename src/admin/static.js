'use strict';

const fs = require('fs/promises');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const ASSETS = new Map([
  ['/admin', ['admin/index.html', 'text/html; charset=utf-8']],
  ['/admin/', ['admin/index.html', 'text/html; charset=utf-8']],
  ['/assets/admin.css', ['admin/admin.css', 'text/css; charset=utf-8']],
  ['/assets/admin.js', ['admin/admin.js', 'text/javascript; charset=utf-8']],
  ['/assets/login.css', ['admin/login.css', 'text/css; charset=utf-8']],
  ['/assets/lucide.js', [path.join('..', 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'), 'text/javascript; charset=utf-8']],
]);

async function serveAdminAsset(request) {
  const pathname = new URL(request.url).pathname;
  const asset = ASSETS.get(pathname);
  if (!asset || request.method !== 'GET') return null;
  const [relativePath, contentType] = asset;
  const filePath = relativePath.startsWith('..')
    ? path.resolve(PUBLIC_DIR, relativePath)
    : path.join(PUBLIC_DIR, relativePath);
  try {
    return new Response(await fs.readFile(filePath), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=300' : 'no-store',
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

module.exports = { serveAdminAsset };
