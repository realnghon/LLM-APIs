// APIs.js - 本地 LLM-APIs 服务器
// 从 Cloudflare Worker 适配而来，可在 Node.js 本地运行
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ==================== 连接池：复用 TCP/TLS 连接 ====================
// 用 https.Agent 管理到上游的 keep-alive 连接，避免每次请求都重新握手
const upstreamAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,    // 连接空闲 60 秒后才关闭（默认 10s）
  maxSockets: 16,            // 每个域名最多 16 个并发连接
  maxTotalSockets: 64,       // 总共最多 64 个连接
  timeout: 300000,           // 连接 5 分钟超时
});

// 用 http.Agent 统一处理 HTTP（虽然上游都是 HTTPS，但保持一致）
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 16,
  maxTotalSockets: 64,
});

const { Readable } = require('stream');

/**
 * 高性能上游请求函数（替代原生 fetch()）
 * 使用 node:https Agent 复用 TCP/TLS 连接，避免重复握手
 * 支持流式（body.getReader()）和非流式（text()/json()）两种模式
 * 注意：body 和 text() 互斥，只能调其中一个
 * 返回 { ok, status, statusText, headers, body, text(), json() }
 */
function poolFetch(url, options = {}) {
  const { method = 'GET', headers = {}, body, timeout } = options;
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const agent = isHttps ? upstreamAgent : httpAgent;
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      agent,
    };

    const req = mod.request(reqOptions, (res) => {
      let consumed = false;

      const wrap = {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: res.headers,

        /** 用于流式读取：获取 Web ReadableStream（转自 Node Readable） */
        get body() {
          if (consumed) throw new Error('Body already consumed');
          consumed = true;
          return Readable.toWeb(res);
        },

        /** 用于非流式：缓冲全文后返回字符串 */
        text() {
          if (consumed) return Promise.reject(new Error('Body already consumed'));
          consumed = true;
          return new Promise((resolveText, rejectText) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolveText(Buffer.concat(chunks).toString()));
            res.on('error', rejectText);
          });
        },

        /** 用于非流式：缓冲全文后解析 JSON */
        async json() {
          const t = await this.text();
          return JSON.parse(t);
        },
      };

      resolve(wrap);
    });

    req.on('error', reject);
    req.setTimeout(timeout || 300000, () => req.destroy(new Error('Request timed out')));

    if (options.signal) {
      const ac = options.signal;
      if (ac.aborted) { req.destroy(ac.reason || new Error('Aborted')); return; }
      ac.addEventListener('abort', () => req.destroy(ac.reason || new Error('Aborted')), { once: true });
    }

    if (body) {
      const bodyStr = typeof body === 'string' ? body
        : Buffer.isBuffer(body) ? body.toString()
        : JSON.stringify(body);
      req.write(bodyStr);
    }
    req.end();
  });
}

// ==================== 文件存储 KV ====================
const DATA_DIR = path.join(__dirname, 'apis-data');
const KV_FILE = path.join(DATA_DIR, 'kv.json');
let kvData = {};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 启动时加载一次，之后只在内存中操作
function loadKV() {
  ensureDataDir();
  try {
    if (fs.existsSync(KV_FILE)) kvData = JSON.parse(fs.readFileSync(KV_FILE, 'utf8'));
  } catch { kvData = {}; }
}

// 异步写入 + debounce（500ms 内合并多次写入）
let saveKVTimer = null;
function saveKV() {
  if (saveKVTimer) clearTimeout(saveKVTimer);
  saveKVTimer = setTimeout(() => {
    ensureDataDir();
    const raw = JSON.stringify(kvData, null, 2);
    kvFileMtime = Date.now() + 1000; // 标记为自己写入，避免 fs.watchFile 重复加载
    fs.writeFile(KV_FILE, raw, (err) => {
      if (err) console.error('saveKV error:', err);
    });
  }, 500);
}
// 启动时同步写一次（确保目录存在）
function saveKVSync() {
  ensureDataDir();
  fs.writeFileSync(KV_FILE, JSON.stringify(kvData, null, 2));
}

// 解析缓存：避免每次 kvGetJSON() 都调 JSON.parse()
const _jsonParseCache = {};  // key → { raw, parsed }
function kvGet(key) { return kvData[key] !== undefined ? kvData[key] : null; }
function kvGetJSON(key) {
  const v = kvGet(key);
  if (v === null) return null;
  // 如果原始字符串没变，直接返回缓存的解析结果
  const cached = _jsonParseCache[key];
  if (cached && cached.raw === v) return cached.parsed;
  let parsed;
  if (typeof v === 'string') { try { parsed = JSON.parse(v); } catch { return null; } }
  else { parsed = v; }
  _jsonParseCache[key] = { raw: v, parsed };
  return parsed;
}
function kvPut(key, value) {
  kvData[key] = value;
  delete _jsonParseCache[key];  // 写入时清除该 key 的解析缓存
  saveKV();
}
function kvPutJSON(key, value) { kvPut(key, JSON.stringify(value)); }

// ==================== Responses API 对话历史存储 ====================
// 存储 conversation history, key: resp_{responseId}, value: { messages: [], created_at: ms }
// TTL: 6 小时
const RESP_CONV_TTL = 6 * 60 * 60 * 1000;

function loadConversation(responseId) {
  if (!responseId) return null;
  const key = 'resp_' + responseId;
  const data = kvGetJSON(key);
  if (!data || !Array.isArray(data.messages)) return null;
  if (Date.now() - data.created_at > RESP_CONV_TTL) {
    kvPut(key, null);
    return null;
  }
  return data.messages;
}

function saveConversation(responseId, messages) {
  if (!responseId || !Array.isArray(messages)) return;
  const key = 'resp_' + responseId;
  kvPutJSON(key, { messages, created_at: Date.now() });
}

function deleteConversation(responseId) {
  if (!responseId) return;
  kvPut('resp_' + responseId, null);
}

// ==================== 内存 DO 实现 ====================
const concurrencyDO = {
  counts: {}, requests: {},
  cleanup() {
    const now = Date.now();
    for (const [rid, item] of Object.entries(this.requests)) {
      if (!item || item.expiresAt <= now) { delete this.requests[rid]; if (item && item.accountId) this.dec(item.accountId); }
    }
  },
  dec(aid) { const n = Math.max(0, (this.counts[aid] || 0) - 1); if (n === 0) delete this.counts[aid]; else this.counts[aid] = n; },
  handleStart(b) {
    this.cleanup();
    const { accountId: aid, requestId: rid, maxConcurrency: mc } = b;
    if (!aid || !rid) return { success: false, error: 'accountId and requestId required' };
    const cur = this.counts[aid] || 0;
    if (mc > 0 && cur >= mc) return { success: true, allowed: false, current: cur, max: mc };
    this.requests[rid] = { accountId: aid, expiresAt: Date.now() + 600000 };
    this.counts[aid] = cur + 1;
    return { success: true, allowed: true, current: this.counts[aid], max: mc };
  },
  handleEnd(b) { this.cleanup(); const item = this.requests[b.requestId]; if (item) { delete this.requests[b.requestId]; this.dec(item.accountId); } return { success: true }; },
  handleState() { this.cleanup(); return { success: true, counts: this.counts, active: Object.keys(this.requests).length }; }
};

const allowanceDO = {
  items: {},
  _dirty: false,
  _saveTimer: null,
  _persist() {
    // debounce 200ms 写入 kv.json
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      if (!this._dirty) return;
      kvData['allowance_status'] = JSON.stringify(this.items);
      saveKV();
      this._dirty = false;
    }, 200);
  },
  _load() {
    try {
      const raw = kvGet('allowance_status');
      if (raw) this.items = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}
  },
  handleCheck(b) {
    const t = normTarget(b.target); const ru = Math.max(0, Math.ceil(Number(b.requiredUnits || 0)));
    if (!t) return { success: true, allowed: true, reason: 'no_allowance' };
    const item = this.ensure(t); const exp = isAllowanceExpired(item.expiresAt);
    const ok = !exp && (Number(item.remainingUnits) || 0) >= (ru > 0 ? ru : 1);
    return { success: true, allowed: ok, reason: exp ? 'expired' : (ok ? '' : 'exhausted'), item };
  },
  handleDebit(b) {
    const t = normTarget(b.target); const au = Math.max(0, Math.ceil(Number(b.amountUnits || 0)));
    if (!t || au <= 0) return { success: true, skipped: true };
    const item = this.ensure(t);
    item.remainingUnits = Math.max(0, (Number(item.remainingUnits) || 0) - au);
    item.usedUnits = (Number(item.usedUnits) || 0) + au;
    item.updatedAt = new Date().toISOString();
    this.items['target:' + t.targetId] = item;
    this._persist();
    return { success: true, item };
  },
  handleStatus(b) {
    const targets = Array.isArray(b.targets) ? b.targets : []; const items = {};
    for (const raw of targets) { const t = normTarget(raw); if (!t) continue; items[t.targetId] = this.ensure(t); }
    return { success: true, items };
  },
  handleReset(b) {
    const t = normTarget(b.target); if (!t) return { success: false, error: 'target required' };
    const item = this.mkState(t); this.items['target:' + t.targetId] = item;
    this._persist();
    return { success: true, item };
  },
  handleSetRemaining(b) {
    const tid = String(b.targetId || ''); if (!tid) return { success: false, error: 'targetId required' };
    const rem = Math.max(0, Math.ceil(Number(b.remainingUnits || 0))); const key = 'target:' + tid;
    let item = this.items[key];
    if (!item) item = this.mkState({ targetId: tid, kind: b.kind || 'unknown', totalUnits: rem });
    item.remainingUnits = rem; item.updatedAt = new Date().toISOString(); this.items[key] = item;
    this._persist();
    return { success: true, item };
  },
  ensure(t) {
    const key = 'target:' + t.targetId; let item = this.items[key];
    if (!item) { item = this.mkState(t); this.items[key] = item; return item; }
    let ch = false;
    if (Number(item.totalUnits) !== Number(t.totalUnits)) {
      const diff = Number(t.totalUnits || 0) - Number(item.totalUnits || 0);
      item.totalUnits = Number(t.totalUnits || 0);
      if (diff > 0) item.remainingUnits = (Number(item.remainingUnits) || 0) + diff;
      else if ((Number(item.remainingUnits) || 0) > item.totalUnits) item.remainingUnits = item.totalUnits;
      ch = true;
    }
    if ((item.kind || '') !== (t.kind || '')) { item.kind = t.kind; ch = true; }
    if ((item.expiresAt || '') !== (t.expiresAt || '')) { item.expiresAt = t.expiresAt || ''; ch = true; }
    if (ch) { item.updatedAt = new Date().toISOString(); this.items[key] = item; }
    return item;
  },
  mkState(t) {
    const tu = Math.max(0, Math.ceil(Number(t.totalUnits || 0))); const now = new Date().toISOString();
    return { targetId: t.targetId, kind: t.kind || 'unknown', totalUnits: tu, remainingUnits: tu, usedUnits: 0, expiresAt: t.expiresAt || '', createdAt: now, updatedAt: now };
  }
};

const usageBufferDO = {
  buffer: [],
  handlePush(entry) {
    this.buffer.push(entry);
    this.flush();  // 每次请求都写入
    return { success: true, buffered: this.buffer.length };
  },
  handleFlush() { this.flush(); return { success: true }; },
  handleStatus() { return { success: true, buffered: this.buffer.length }; },
  flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      let existing = kvGetJSON('usage_logs') || [];
      if (!Array.isArray(existing)) existing = [];
      const merged = batch.concat(existing);
      merged.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      kvPutJSON('usage_logs', merged.slice(0, 1000));
    } catch (err) { console.error('usageBufferDO flush error:', err); this.buffer = batch.concat(this.buffer); }
  }
};

function normTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const tid = String(t.targetId || '').trim(); if (!tid) return null;
  return { targetId: tid, kind: String(t.kind || 'unknown'), totalUnits: Math.max(0, Math.ceil(Number(t.totalUnits || 0))), expiresAt: String(t.expiresAt || '') };
}


// ============================================================
// LLM-APIs Worker — sub2api 风格
// accounts = 上游账号池；本地运行，无认证
// ============================================================

// UTF-8 安全的 base64 编解码（支持中文）
function utf8ToB64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64ToUtf8(b64) { return Buffer.from(b64, 'base64').toString('utf8'); }

// ---- 上游账号缓存 ----
let cachedAccounts = null;
let cachedAccountsAt = 0;
const ACCOUNTS_CACHE_TTL = 3;

// ---- 余量配置缓存 ----
let cachedAllowanceConfig = null;
let cachedAllowanceConfigAt = 0;
const ALLOWANCE_CONFIG_CACHE_TTL = 3;

// 初始化加载数据
loadKV();
allowanceDO._load();

// ---- 监控 kv.json 外部变化，自动重载内存缓存 ----
// 当有人直接编辑 kv.json（不是通过 API），自动同步到内存
let kvFileMtime = 0;
try { kvFileMtime = fs.statSync(KV_FILE).mtimeMs; } catch {}
fs.watchFile(KV_FILE, { interval: 100 }, (current, previous) => {
  if (current.mtimeMs > kvFileMtime && current.mtimeMs !== previous.mtimeMs) {
    kvFileMtime = current.mtimeMs;
    try {
      const newData = JSON.parse(fs.readFileSync(KV_FILE, 'utf8'));
      kvData = newData;
      // 清空所有解析缓存
      for (const k of Object.keys(_jsonParseCache)) delete _jsonParseCache[k];
      // 重载 allowance 状态
      allowanceDO._load();
      // 使 accounts / allowance 配置缓存失效
      cachedAccounts = null;
      cachedAllowanceConfig = null;
      console.log(`[KV] 检测到 kv.json 外部变化，已重载内存缓存`);
    } catch {}
  }
});

// ---- KV Keys ----
const KV_KEY_ACCOUNTS = 'accounts';
const KV_KEY_USAGE_LOGS = 'usage_logs';
const KV_KEY_ALLOWANCE_CONFIG = 'allowance_config';

// 旧 channels key，仅用于迁移兼容（从旧 channels 转换为 accounts）
// KV_KEY_CHANNELS_OLD and migrationDone removed after migration cleanup

// ---- 使用记录 ----
const MAX_USAGE_LOGS = 1000;
const FLUSH_INTERVAL_MS = 7200000;
const KV_KEY_USAGE_STATS = 'usage_stats';
const KV_KEY_USAGE_DAILY_STATS = 'usage_daily_stats';
const KV_KEY_USAGE_MONTHLY_STATS = 'usage_monthly_stats';

let statsAccumulator = { accounts: {}, models: {}, total: 0, success: 0, fail: 0 };
let dailyStatsAccumulator = { accounts: {}, models: {}, total: 0, success: 0, fail: 0 };
let monthlyStatsAccumulator = {};
let backgroundFlushTimer = null;
let statsFlushCounter = 0;  // 每次请求都 flush
const STATS_FLUSH_BATCH_SIZE = 1;  // 每次请求 flush
const STATS_ACC_EMPTY = () => ({ count: 0, input: 0, output: 0, cache: 0, cache_create: 0, consumed: 0 });
function getBeijingDate() {
  return new Intl.DateTimeFormat('sv-CN', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

// ---- 并发控制 ----
const CONCURRENCY_DO_NAME = 'global-concurrency';
const CONCURRENCY_TTL_MS = 10 * 60 * 1000;
const ALLOWANCE_DO_NAME = 'global-allowance';
const ALLOWANCE_SCALE = 1000000;





// ---- 使用记录 DO 缓冲 ----
const USAGE_BUFFER_DO_NAME = 'global-usage-buffer';
const USAGE_BUFFER_FLUSH_INTERVAL = 300000; // 5min 自动 flush（保底用，刷新时手动触发 flush）
const USAGE_BUFFER_FLUSH_THRESHOLD = 50;    // 50 条触发 flush



async function handleRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 后台定时 flush 统计 buffer（只在首次请求初始化）
    if (!backgroundFlushTimer) {
      backgroundFlushTimer = setInterval(() => {
        flushStatsBuffer().catch(() => {});
        flushDailyStatsBuffer().catch(() => {});
        flushMonthlyStatsBuffer().catch(() => {});
      }, FLUSH_INTERVAL_MS);
    }

    try {
      if (path === '/admin' || path === '/admin/') {
        return handleAdmin(request, corsHeaders);
      }

      if (path.startsWith('/admin/')) {
        return handleAdminAPI(request, path, method, corsHeaders);
      }

      if (path.startsWith('/v1/') || path.startsWith('/v3/')) {
        // 本地运行，跳过 API Key 验证

        if (path === '/v1/models' || path === '/v3/models') {
          return handleModels(request, corsHeaders);
        }

        // Responses API 兼容层：/v1/responses → /v1/chat/completions
        if (path === '/v1/responses') {
          return handleResponsesAPI(request, corsHeaders);
        }

        // Image Generation API：/v1/images/generations
        if (path === '/v1/images/generations') {
          return handleImageGenerations(request, corsHeaders);
        }

        return handleProxy(request, path, corsHeaders);
      }

      return new Response(
        JSON.stringify({ error: 'Not found', admin: '/admin' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
}

// ===================== 管理页面 =====================
function handleAdmin(request, corsHeaders) {
  // 本地运行，跳过认证

  const respHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', ...corsHeaders };

  var h = '<!DOCTYPE html><html lang="zh-CN"><head>';
  h += '<meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
  h += '<title>LLM-APIs 管理</title>';
  h += '<style>';
  h += ':root{--primary:#667eea;--primary-hover:#5a6fd6;--bg:#f0f2f5;--sidebar-bg:#fff;--card-bg:#fff;--text:#333;--text-sec:#666;--border:#e5e7eb;--sidebar-w:240px}';
  h += '*{margin:0;padding:0;box-sizing:border-box}';
  h += 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.45;margin:0}';
  // Layout
  h += '.app-layout{display:flex;min-height:100vh}';
  // Sidebar
  h += '.sidebar{position:fixed;top:0;left:0;bottom:0;width:var(--sidebar-w);background:var(--sidebar-bg);border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:200;transition:transform .25s ease;overflow:hidden}';
  h += '.sidebar-brand{padding:20px 24px;font-size:20px;font-weight:700;color:var(--primary);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;white-space:nowrap;user-select:none}';
  h += '.sidebar-avatar{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#667eea,#764ba2);display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;flex-shrink:0;transition:transform .2s,box-shadow .2s}';
  h += '.sidebar-avatar:hover{transform:scale(1.05);box-shadow:0 2px 8px rgba(102,126,234,.4)}';
  h += '.sidebar-avatar img{width:100%;height:100%;object-fit:cover}';
  h += '.sidebar-avatar .avatar-placeholder{font-size:20px;color:#fff;line-height:1}';
  h += '.sidebar-nav{flex:1;padding:12px 0;overflow-y:auto}';
  h += '.sidebar-nav-group{padding:8px 24px 4px;font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:.5px;font-weight:600;user-select:none}';
  h += '.sidebar-item{display:flex;align-items:center;gap:12px;padding:11px 24px;font-size:14px;font-weight:500;color:var(--text-sec);cursor:pointer;border-left:3px solid transparent;transition:all .2s;user-select:none;white-space:nowrap}';
  h += '.sidebar-item:hover{background:#f0f2ff;color:var(--text)}';
  h += '.sidebar-item.active{color:var(--primary);border-left-color:var(--primary);background:rgba(102,126,234,.06);font-weight:600}';
  h += '.sidebar-item .nav-icon{font-size:18px;width:24px;text-align:center;flex-shrink:0}';
  h += '.sidebar-footer{padding:16px 24px;border-top:1px solid var(--border);font-size:12px;color:#bbb;user-select:none}';
  // Overlay
  h += '.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:199;opacity:0;transition:opacity .25s}';
  h += '.sidebar-overlay.show{display:block;opacity:1}';
  // Main wrapper
  h += '.main-wrapper{flex:1;margin-left:var(--sidebar-w);min-width:0;display:flex;flex-direction:column}';
  // Topbar
  h += '.topbar{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid var(--border);padding:0 28px;height:56px;display:flex;align-items:center;gap:16px;flex-shrink:0}';
  h += '.topbar-title{font-size:16px;font-weight:600;color:var(--text);margin:0}';
  h += '.topbar-right{margin-left:auto;font-size:13px;color:var(--text-sec);display:flex;align-items:center;gap:8px}';
  h += '.topbar-avatar{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#667eea,#764ba2);display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;flex-shrink:0;transition:transform .2s}';
  h += '.topbar-avatar:hover{transform:scale(1.05)}';
  h += '.topbar-avatar img{width:100%;height:100%;object-fit:cover}';
  h += '.topbar-avatar .avatar-placeholder{font-size:14px;color:#fff;line-height:1}';
  h += '.topbar-right .admin-badge{background:var(--primary);color:#fff;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:.3px}';
  h += '.hamburger{display:none;background:none;border:none;font-size:22px;cursor:pointer;color:var(--text);padding:4px 8px;border-radius:6px;transition:background .15s}';
  h += '.hamburger:hover{background:#f0f2f5}';
  // Content area
  h += '.content{flex:1;padding:24px 28px 40px}';
  // Cards
  h += '.card{background:var(--card-bg);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);padding:24px;margin-bottom:20px;border:1px solid var(--border)}';
  h += '.bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}';
  h += '.bar h2{font-size:16px;color:#444;font-weight:600}';
  // Tables
  h += '#accountList,#dailyStats,#cumulativeStats,#modalTestBody{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}';
  h += '.cum-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;margin-bottom:4px}';
  h += '#accountList table{min-width:1040px;margin:0 auto;table-layout:auto}';
  h += '#accountList th,#accountList td{white-space:nowrap;vertical-align:middle}';
  h += '#usageLogs{max-width:100%;max-height:70vh;overflow:auto;-webkit-overflow-scrolling:touch}';
  h += '#usageLogs table{width:100%;margin:0 auto;table-layout:auto}';
  h += '#usageLogs th,#usageLogs td{white-space:nowrap;vertical-align:middle}';
  h += '#modalTestBody table{min-width:680px;margin:0 auto}';

  h += 'table{width:auto;min-width:100%;border-collapse:collapse;table-layout:auto}';
  h += 'th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;font-size:14px}';
  h += 'th{font-weight:600;color:#666;font-size:12px;background:#fafafa}';
  h += 'tr:hover td{background:rgba(102,126,234,.04)}';
  // Badges
  h += '.badge{padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500}';
  h += '.bg-green{background:#d4edda;color:#155724}';
  h += '.bg-yellow{background:#fff3cd;color:#856404}';
  h += '.bg-red{background:#f8d7da;color:#721c24}';
  h += '.bg-blue{background:#cce5ff;color:#004085}';
  h += '.bg-purple{background:#e8d5f5;color:#6a1b9a}';
  h += '.bg-orange{background:#ffe0b2;color:#e65100}';
  h += '.bg-teal{background:#d4f5f0;color:#00695c}';
  h += '.bg-pink{background:#fce4ec;color:#880e4f}';
  h += '.tag{display:inline-block;background:#e8ecf1;padding:1px 6px;border-radius:3px;font-size:11px;margin:1px}';
  h += '.badge-toggle{cursor:pointer;user-select:none;transition:transform .15s,box-shadow .15s;display:inline-block}';
  h += '.badge-toggle:hover{transform:scale(1.08);box-shadow:0 2px 8px rgba(0,0,0,.15)}';
  h += '.badge-toggle:active{transform:scale(.95)}';
  // Buttons
  h += '.btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 16px;border:none;border-radius:6px;font-size:14px;cursor:pointer;color:#fff;text-decoration:none;min-height:36px;white-space:nowrap;transition:background .2s,box-shadow .15s}';
  h += '.btn-primary{background:var(--primary)}';
  h += '.btn-primary:hover{background:var(--primary-hover);box-shadow:0 2px 8px rgba(102,126,234,.3)}';
  h += '.btn-sm{padding:4px 10px;font-size:12px}';
  h += '.btn-xs{padding:2px 8px;font-size:11px}';
  h += '.btn-danger{background:#e74c3c}';
  h += '.btn-danger:hover{background:#c0392b}';
  h += '.btn-outline{background:transparent;border:1px solid #ddd;color:#666}';
  h += '.btn-outline:hover{background:#f5f5f5}';
  h += '.btn-test{background:#17a2b8;color:#fff}.btn-test:hover{background:#138496}';
  // Key toggle
  h += '.key-wrap{position:relative}';
  h += '.key-wrap input{padding-right:50px!important}';
  h += '.key-toggle{position:absolute;right:2px;top:50%;transform:translateY(-50%);background:none;border:none;color:#999;cursor:pointer;font-size:12px;padding:6px 10px;border-radius:4px}';
  h += '.key-toggle:hover{background:#f0f0f0;color:#333}';
  // Move buttons
  h += '.btn-move{background:none;border:1px solid #ddd;color:#999;cursor:pointer;padding:2px 6px;font-size:12px;border-radius:3px;margin:0 1px}';
  h += '.btn-move:hover{background:#f5f5f5;color:#333;border-color:#bbb}';
  h += '.btn-move:disabled{opacity:.3;cursor:default}';
  // Utilities
  h += '.mt10{margin-top:10px}';
  h += '.gray{color:#999}';
  h += '.empty{text-align:center;padding:40px 0;color:#999}';
  h += 'code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:13px}';
  // Forms
  h += '.form-group{margin-bottom:12px}';
  h += '.form-group label{display:block;font-size:13px;color:#555;margin-bottom:3px}';
  h += '.form-group input,.form-group textarea,.form-group select{width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;transition:border-color .2s}';
  h += '.form-group input:focus,.form-group textarea:focus,.form-group select:focus{border-color:var(--primary);outline:none;box-shadow:0 0 0 3px rgba(102,126,234,.12)}';
  h += '.form-group textarea{height:80px}';
  h += '.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}';
  // Modal
  h += '.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:300;justify-content:center;align-items:center;padding:16px;backdrop-filter:blur(2px)}';
  h += '.modal.show{display:flex}';
  h += '.modal-box{background:#fff;border-radius:14px;padding:32px;width:800px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.15)}';
  h += '.modal-box h3{font-size:18px;margin-bottom:16px;font-weight:600}';
  h += '.flex-end{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}';
  // Toast
  h += '.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;z-index:999;opacity:0;transition:opacity .3s;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.15)}';
  h += '.toast.show{opacity:1}';
  h += '.toast-ok{background:#28a745}';
  h += '.toast-err{background:#dc3545}';
  // Pages
  h += '.page{display:none}.page.active{display:block}';

  // Focus
  h += '*:focus-visible{outline:2px solid var(--primary);outline-offset:2px;border-radius:4px}';
  h += '.sidebar-item:focus-visible{outline-offset:-2px;border-radius:0}';
  h += '.btn:focus-visible{outline:2px solid #fff;outline-offset:2px;box-shadow:0 0 0 4px var(--primary)}';
  h += '.btn-move:focus-visible,.key-toggle:focus-visible,.rate-btn-del:focus-visible,.rate-btn-add:focus-visible,.rate-btn-move:focus-visible{outline:2px solid var(--primary);outline-offset:1px}';
  h += 'input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:0;border-color:var(--primary)}';
  // Rates editor
  h += '.flex-gap{display:flex;gap:8px}.flex-gap textarea{flex:1}';
  h += '.rates-editor{border:1px solid #ddd;border-radius:6px;padding:8px;background:#fafafa;margin-bottom:6px}';
  h += '.rates-row{display:flex;gap:4px;align-items:center;margin-bottom:4px;flex-wrap:nowrap}';
  h += '.rates-header{font-size:11px;color:#888;font-weight:600;margin-bottom:6px}';
  h += '.rates-header .rate-cell{text-align:center;padding:2px 0}';
  h += '.rate-cell{flex:1 1 0;min-width:0}';
  h += '.rate-cell-model{flex:1.5;min-width:80px}';
  h += '.rate-cell-calls{flex:0.8;min-width:50px}';
  h += '.rate-cell-num{flex:1;min-width:60px}';
  h += '.rate-cell-time{flex:1.8;min-width:100px}';
  h += '.rate-cell-del{flex:0 0 28px}';
  h += '.rates-row input{width:100%;padding:5px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box}';
  h += '.rates-row input:focus{border-color:var(--primary);outline:none}';
  h += '.rate-btn-del{width:26px;height:26px;padding:0;border:1px solid #ddd;border-radius:4px;background:#fff;color:#c00;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center}';
  h += '.rate-btn-del:hover{background:#f8d7da;border-color:#c00}';
  h += '.rate-btn-add{width:100%;padding:5px;background:#f0f2f5;border:1px dashed #ccc;border-radius:5px;color:#888;cursor:pointer;font-size:12px;margin-top:2px}';
  h += '.rate-btn-add:hover{background:#e0e4ea;color:#555}';
  h += '.rate-cell-actions{flex:0 0 70px;text-align:center;display:flex;gap:2px;align-items:center;justify-content:flex-end}';
  h += '.rate-btn-move{width:22px;height:22px;padding:0;border:1px solid #ddd;border-radius:3px;background:#fff;color:#999;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center}';
  h += '.rate-btn-move:hover{background:#f0f2ff;color:var(--primary);border-color:var(--primary)}';
  h += '.rate-btn-move:disabled{opacity:.3;cursor:default}';
  // ===== Responsive =====
  h += '@media(max-width:768px){.sidebar{transform:translateX(-100%);box-shadow:4px 0 24px rgba(0,0,0,.15)}.sidebar.open{transform:translateX(0)}.main-wrapper{margin-left:0}.hamburger{display:block}.topbar{padding:0 16px}.content{padding:16px}.card{padding:16px;border-radius:10px;margin-bottom:14px}.bar{flex-direction:column;align-items:stretch;gap:10px}.bar h2{font-size:15px}.bar>div{display:flex!important;flex-direction:column;gap:8px}.bar .btn{width:100%;margin-left:0!important;margin-right:0!important}.form-row{grid-template-columns:1fr}.flex-end{flex-direction:column-reverse;gap:8px}.flex-end .btn{width:100%}.modal{padding:10px}.modal-box{width:100%!important;max-width:100%;padding:18px;max-height:calc(100vh - 20px);border-radius:14px}.toast{left:12px;right:12px;top:12px;text-align:center}#usageLogs>div[style*="display:flex"]{flex-direction:column!important;gap:6px!important}th,td{padding:9px 10px;font-size:13px}.btn-sm{min-height:34px}.rates-editor{overflow-x:auto;-webkit-overflow-scrolling:touch}.rates-row{flex-wrap:nowrap;min-width:480px}.rate-cell-model{min-width:70px;flex:1.2}.rate-cell-num{min-width:40px;flex:0.8}.rate-cell-time{min-width:80px}.rates-row input{font-size:11px;padding:4px 4px}.rate-btn-add{min-width:480px}#cumAcctTbl input,#cumModelTbl input{width:48px!important;font-size:11px;padding:3px 4px}#cumAcctTbl input.ca-name,#cumModelTbl input.cm-name{width:80px!important}}';
  h += '@media(max-width:480px){body{font-size:13px}.content{padding:12px}.topbar{height:48px;padding:0 12px}.topbar-title{font-size:14px}.card{padding:12px}.sidebar-item{font-size:13px;padding:10px 20px}.btn{font-size:13px;padding:8px 12px}.form-group input,.form-group textarea,.form-group select{font-size:13px;padding:8px 10px}.modal-box{padding:14px}.modal-box h3{font-size:16px}th,td{font-size:12px;padding:8px 9px}.badge{font-size:11px}.tag{font-size:10px}code{font-size:12px}}';
  h += '@media(max-width:640px){.rates-editor{overflow-x:auto;-webkit-overflow-scrolling:touch}.rates-row{flex-wrap:nowrap;min-width:520px}.rate-cell-model{min-width:70px;flex:1.2}.rate-cell-num{min-width:50px;flex:0.9}.rate-cell-time{min-width:85px}.rates-row input{font-size:11px;padding:4px 4px}.rate-cell-actions{flex:0 0 60px;gap:1px}.rate-btn-move{width:20px;height:20px;font-size:10px}.rate-btn-add{min-width:520px;font-size:11px}}';
  h += '</style></head><body>';

  // ---- Sidebar overlay (mobile) ----
  h += '<div class="sidebar-overlay" id="sidebarOverlay"></div>';

  h += '<div class="app-layout">';
  // ---- Sidebar ----
  h += '<aside class="sidebar" id="sidebar">';
  h += '<div class="sidebar-brand">';
  h += '<div class="sidebar-avatar" id="sidebarAvatar" title="点击设置头像"><span class="avatar-placeholder">A</span></div>';
  h += 'LLM-APIs</div>';
  h += '<div class="sidebar-nav">';
  h += '<div class="sidebar-nav-group">导航</div>';
  h += '<div class="sidebar-item active" data-page="page-accounts" data-hash="accounts" data-title="\u8D26\u53F7\u7BA1\u7406" role="tab" tabindex="0" aria-selected="true"><span class="nav-icon">\uD83D\uDCCB</span>\u8D26\u53F7\u7BA1\u7406</div>';
  h += '<div class="sidebar-item" data-page="page-usage" data-hash="usage" data-title="\u4F7F\u7528\u8BB0\u5F55" role="tab" tabindex="-1" aria-selected="false"><span class="nav-icon">\uD83D\uDCCA</span>\u4F7F\u7528\u8BB0\u5F55</div>';
  h += '<div class="sidebar-item" data-page="page-cumulative" data-hash="cumulative" data-title="\u7D2F\u8BA1\u7EDF\u8BA1" role="tab" tabindex="-1" aria-selected="false"><span class="nav-icon">\uD83D\uDCC8</span>\u7D2F\u8BA1\u7EDF\u8BA1</div>';
  h += '</div>';
  h += '<div class="sidebar-footer">LLM-APIs \u7BA1\u7406\u540E\u53F0</div>';
  h += '</aside>';

  // ---- Main wrapper ----
  h += '<div class="main-wrapper">';
  // Topbar
  h += '<header class="topbar">';
  h += '<button class="hamburger" id="btnHamburger">\u2630</button>';
  h += '<div class="topbar-title" id="topbarTitle">\u8D26\u53F7\u7BA1\u7406</div>';
  h += '<div class="topbar-right"><div class="topbar-avatar" id="topbarAvatar"></div></div>';
  h += '</header>';

  // Content
  h += '<main class="content">';

  // ---- \u7B2C\u4E00\u9875\uFF1A\u8D26\u53F7\u7BA1\u7406 ----
  h += '<div class="page active" id="page-accounts">';
  h += '<div class="card">';
  h += '<div class="bar"><h2>\u4E0A\u6E38\u8D26\u53F7\u7BA1\u7406</h2><button class="btn btn-primary" id="btnAddAccount">+ \u65B0\u589E\u8D26\u53F7</button></div>';
  h += '<div id="accountList"><div class="empty"><p>\u6682\u65E0\u8D26\u53F7\uFF0C\u70B9\u51FB\u4E0A\u65B9\u6309\u94AE\u6DFB\u52A0</p></div></div>';
  h += '</div>';
  h += '</div>';

  // ---- \u7B2C\u4E8C\u9875\uFF1A\u4F7F\u7528\u8BB0\u5F55 ----
  h += '<div class="page" id="page-usage">';
  // \u4F7F\u7528\u8BB0\u5F55\uFF08\u5206\u9875\uFF09
  h += '<div class="card">';
  h += '<div class="bar"><h2>\u4F7F\u7528\u8BB0\u5F55</h2><div><button class="btn btn-primary btn-sm" id="btnRefreshUsage">\u5237\u65B0</button> <button class="btn btn-danger btn-sm" id="btnClearUsage">\u6E05\u7A7A</button></div></div>';
  h += '<div id="usageLogs"><div class="empty"><p>\u6682\u65E0\u4F7F\u7528\u8BB0\u5F55</p></div></div>';
  h += '<div id="usagePagination" style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"></div>';
  h += '</div>';
  h += '</div>';

  // ---- \u7B2C\u4E09\u9875\uFF1A\u7D2F\u8BA1\u7EDF\u8BA1 ----
  h += '<div class="page" id="page-cumulative">';

  // ---- \u5F53\u5929\u7EDF\u8BA1 ----
  h += '<div class="card">';
  h += '<div class="bar"><h2>\u5F53\u5929\u7EDF\u8BA1 <span style="font-size:12px;color:#999;font-weight:400">\uFF08\u5F53\u5929\u7D2F\u52A0\uFF0C\u4FEE\u6539\u540E\u70B9\u4FDD\u5B58\uFF09</span></h2><div>';
  h += '<button class="btn btn-sm btn-outline" id="btnRefreshDaily">\u5237\u65B0</button>';
  h += ' <button class="btn btn-sm btn-primary" id="btnSaveDaily">\u4FDD\u5B58</button>';
  h += '</div></div>';
  h += '<div id="dailyStats"><div class="empty"><p>\u52A0\u8F7D\u4E2D...</p></div></div>';
  h += '</div>';

  // ---- \u6708\u5EA6\u7EDF\u8BA1\u677F\u5757 ----
  h += '<div class="card">';
  h += '<div class="bar"><h2>\u6708\u5EA6\u7EDF\u8BA1</h2><div>';
  h += '<button class="btn btn-sm btn-outline" id="btnRefreshMonthly">\u5237\u65B0</button>';
  h += '</div></div>';
  h += '<div id="monthlyStats"><div class="empty"><p>\u52A0\u8F7D\u4E2D...</p></div></div>';
  h += '</div>';

  // ---- \u7D2F\u8BA1\u7EDF\u8BA1 ----
  h += '<div class="card">';
  h += '<div class="bar"><h2>\u7D2F\u8BA1\u7EDF\u8BA1 <span style="font-size:12px;color:#999;font-weight:400">\uFF08\u4E00\u76F4\u7D2F\u52A0\uFF0C\u4FEE\u6539\u540E\u70B9\u4FDD\u5B58\uFF09</span></h2><div>';
  h += '<button class="btn btn-sm btn-outline" id="btnRefreshCumulative">\u5237\u65B0</button>';
  h += ' <button class="btn btn-sm btn-primary" id="btnSaveCumulative">\u4FDD\u5B58</button>';
  h += '</div></div>';
  h += '<div id="cumulativeStats"><div class="empty"><p>\u52A0\u8F7D\u4E2D...</p></div></div>';
  h += '</div>';
  h += '</div>';

  h += '</main>';
  h += '</div>';
  h += '</div>';

  // ---- 新增/编辑上游账号弹窗 ----
  h += '<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">';
  h += '<div class="modal-box">';
  h += '<h3 id="modalTitle">新增上游账号</h3>';
  h += '<input type="hidden" id="editId">';

  h += '<div class="form-group"><label>名称 *</label><input type="text" id="f_name" name="account_name" autocomplete="organization" placeholder="例：阿里云百炼"></div>';
  h += '<div class="form-group"><label>接口地址(Base URL) *</label><input type="text" id="f_url" name="account_url" autocomplete="url" placeholder="https://api.openai.com/v1"></div>';
  h += '<div class="form-group"><label>API Key *</label><div class="key-wrap"><input type="password" id="f_key" name="account_key" autocomplete="off" placeholder="sk-..."><button type="button" class="key-toggle" id="btnToggleKey">显示</button></div></div>';
  h += '<div class="form-group"><label>请求格式</label><select id="f_format"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></div>';
  h += '<div class="form-group"><label>支持的模型 *（每行一个）</label><div class="flex-gap"><textarea id="f_models" name="account_models" autocomplete="off" placeholder="gpt-4"></textarea><button type="button" class="btn btn-sm btn-primary" id="btnPickModels" style="height:80px">可选模型</button></div><div id="modelPickerPanel" style="display:none;margin-top:6px;border:1px solid #ddd;border-radius:8px;background:#fff;padding:16px;max-height:60vh;overflow-y:auto;box-shadow:0 2px 8px rgba(0,0,0,.08)"></div></div>';
  h += '<div class="form-group"><label>模型映射（可选）<br><span style="font-size:12px;color:#999">每行一个，客户端模型=上游模型</span></label><textarea id="f_modelMap" name="account_model_map" autocomplete="off" placeholder="gpt-4=gpt-4-turbo"></textarea></div>';

  h += '<div class="form-row">';
  h += '<div class="form-group"><label>优先级（数字越小越优先，1 最高）</label><input type="number" id="f_priority" name="account_priority" autocomplete="off" value="1" min="1"></div>';
  h += '<div class="form-group"><label>权重（1-10）</label><input type="number" id="f_weight" name="account_weight" autocomplete="off" value="1" min="1" max="10" placeholder="例：6"></div>';
  h += '</div>';

  h += '<div class="form-row">';
  h += '<div class="form-group"><label>最大并发数（0=不限制）</label><input type="number" id="f_maxConcurrency" value="0" min="0" placeholder="0"></div>';
  h += '<div class="form-group"></div>';
  h += '</div>';

  h += '<div class="form-row">';
  h += '<div class="form-group"><label>池模式</label><select id="f_poolMode"><option value="false">关闭</option><option value="true">开启</option></select></div>';
  h += '<div class="form-group" id="f_retryCountGroup"><label>同账号重试次数（0-10）</label><input type="number" id="f_retryCount" value="3" min="0" max="10"></div>';
  h += '</div>';
  h += '<div class="form-group" id="f_retryStatusesGroup"><label>重试状态码（逗号分隔）</label><input type="text" id="f_retryStatuses" value="401,403,429" placeholder="401,403,429"></div>';

  h += '<div class="card" style="box-shadow:none;border:1px solid #eee;padding:12px;margin:12px 0">';
  h += '<div class="bar" style="margin-bottom:8px"><h2 style="font-size:14px">余量设置</h2></div>';
  h += '<div id="allowanceSharedBox">';
  h += '<div class="form-row"><div class="form-group"><label>中转共享组名称</label><input type="text" id="f_sharedGroupName" placeholder="例：OpenRouter"></div><div class="form-group"><label>共享余额（剩多少钱）</label><input type="number" step="0.01" id="f_sharedBalance" placeholder="100.00"></div></div>';
  h += '<div class="form-group"><label>同一中转账号（勾选共享余额）</label><div id="f_sharedAccounts" style="max-height:120px;overflow:auto;border:1px solid #ddd;border-radius:6px;padding:8px"></div></div>';
  h += '<div class="form-group"><label>账号倍率（必填）</label><textarea id="f_accountRates" style="display:none"></textarea><div id="accountRatesEditor" class="rates-editor"></div></div>';
  h += '</div>';
  h += '<div id="allowanceTotalBox" style="display:none">';
  h += '<div class="form-row"><div class="form-group"><label>总量模式</label><select id="f_quotaMode"><option value="count">按次数</option><option value="usage">按余额</option><option value="points">按积分</option></select></div><div class="form-group"><label>到期日</label><input type="date" id="f_quotaExpires"></div></div>';
  h += '<div class="form-group"><label id="f_quotaTotalLabel">总量/总次数</label><input type="number" step="0.01" id="f_quotaTotal" placeholder="1000"></div>';
  h += '<div class="form-group" id="f_quotaRemainingRow"><label>余量（显示值，留空不修改）</label><input type="number" step="0.01" id="f_quotaRemaining" placeholder="留空=自动"></div>';
  h += '<div class="form-group" id="f_quotaDisplayCurrencyRow"><label><input type="checkbox" id="f_quotaDisplayCurrency"> 显示余额金额(¥)</label></div>';
  h += '<div class="form-group"><label>消耗规则</label><textarea id="f_quotaRates" style="display:none"></textarea><div id="quotaRatesEditor" class="rates-editor"></div></div>';
  h += '</div>';
  h += '</div>';

  h += '<div class="form-group"><label>状态</label><select id="f_enabled"><option value="true">启用</option><option value="false">禁用</option></select></div>';
  h += '<div class="form-group"><label>备注</label><input type="text" id="f_note" placeholder="可选备注"></div>';

  h += '<div class="flex-end">';
  h += '<button class="btn btn-outline" id="btnCancel">取消</button>';
  h += '<button class="btn btn-primary" id="btnSave">保存</button>';
  h += '</div></div></div>';

  h += '<div class="toast" id="toast" role="alert" aria-live="polite"></div>';

  // ---- 测试结果弹窗 ----
  h += '<div class="modal" id="modalTest" role="dialog" aria-modal="true" aria-labelledby="modalTestTitle">';
  h += '<div class="modal-box" style="width:900px">';
  h += '<h3 id="modalTestTitle">测试结果</h3>';
  h += '<div id="modalTestBody"></div>';
  h += '<div class="flex-end"><button class="btn btn-outline" id="btnCloseTest">关闭</button></div>';
  h += '</div></div>';

  // JS - 使用 addEventListener，无 inline onclick
  h += '<script>';
  h += 'var base="";var accounts=[];var allowanceConfig={shared_groups:[],account_quotas:{}};var allowanceStatus={};';

  // 统一 fetch（本地运行无需 auth）
  h += 'async function adminFetch(url,opt){';
  h += 'if(!opt)opt={};';
  h += 'if(!opt.headers)opt.headers={};';
  h += 'opt.cache="no-cache";';
  h += 'return await fetch(url,opt);';
  h += '}';

  // 加载上游账号列表
  h += 'async function loadAccountsList(){';
  h += 'try{var r=await adminFetch(base+"/admin/accounts");var d=await r.json();';
  h += 'accounts=d.accounts||[];allowanceConfig=d.allowance_config||{shared_groups:[],account_quotas:{}};allowanceStatus=d.allowance_status||{};renderAccounts()}catch(e){}';
  h += '}';

  // 渲染上游账号表格
  h += 'function renderAccounts(){';
  h += 'var el=document.getElementById("accountList");';
  h += 'if(!accounts.length){el.innerHTML=\'<div class="empty"><p>暂无账号，点击上方按钮添加</p></div>\';return}';
  h += 'var t="<table><thead><tr><th>名称</th><th>负载</th><th>余量</th><th>操作</th><th>模型</th><th>状态</th><th>映射</th><th>优先级/权重</th><th>池模式</th><th>备注</th></tr></thead><tbody>";';
  h += 'for(var i=0;i<accounts.length;i++){';
  h += 'var a=accounts[i];';
  h += 'var s=(a.enabled!==false)?"<span class=\\"badge bg-green badge-toggle\\" data-toggle-enabled=\\""+a.id+"\\">启用</span>":"<span class=\\"badge bg-red badge-toggle\\" data-toggle-enabled=\\""+a.id+"\\">禁用</span>";';
  h += 'var ms="<div style=\\"display:block;max-height:76px;overflow-y:auto;padding:2px\\">";for(var j=0;j<(a.models||[]).length;j++){ms+="<div style=\\"background:#e8ecf1;padding:1px 6px;border-radius:3px;font-size:11px;white-space:nowrap;margin:1px 0\\">"+esc(a.models[j])+"</div>"}ms+="</div>"';
  h += ';';
  h += 'var mc=0;if(a.model_map){for(var mk in a.model_map){if(a.model_map.hasOwnProperty(mk))mc++}}';
  h += 't+="<tr><td><b>"+esc(a.name)+"</b></td>";';
  h += 't+="<td><span id=\\"conc-"+a.id+"\\" class=\\"gray\\">-</span></td>";';
  h += 't+="<td>"+renderAllowanceCell(a)+"</td>";';
  h += 't+="<td><button class=\\"btn btn-primary btn-sm\\" data-edit=\\""+a.id+"\\">编辑</button> ";';
  h += 't+="<button class=\\"btn btn-sm btn-test\\" data-test=\\""+a.id+"\\">测试</button> ";';
  h += 't+="<span class=\\"move-group\\">";';
  h += 'if(i>0){t+="<button class=\\"btn-move\\" data-move-up=\\""+a.id+"\\" title=\\"上移\\">▲</button>"}';
  h += 'if(i<accounts.length-1){t+="<button class=\\"btn-move\\" data-move-down=\\""+a.id+"\\" title=\\"下移\\">▼</button>"}';
  h += 't+="</span>";';
  h += 't+="<button class=\\"btn btn-danger btn-sm\\" data-del=\\""+a.id+"\\">删除</button></td>";';
  h += 't+="<td>"+ms+"</td>";';
  h += 't+="<td>"+s+"</td>";';
  h += 't+="<td>"+(mc>0?mc:"<span class=\\"gray\\">-</span>")+"</td>";';
  h += 't+="<td>"+(a.priority||0)+"/"+(a.weight||1)+"</td>";';
  h += 'var pm=a.pool_mode===true?"<span class=\\"badge bg-green\\">是</span>":"<span class=\\"badge bg-red\\">否</span>";';
  h += 't+="<td>"+pm+"</td>";';
  // 格式列已移除
  h += 't+="<td>"+esc(a.note||"-")+"</td></tr>"';
  h += '}';
  h += 't+="</tbody></table>";el.innerHTML=t;';
  h += 'el.querySelectorAll("[data-edit]").forEach(function(b){b.addEventListener("click",function(){openEditAccount(b.getAttribute("data-edit"))})});';
  h += 'el.querySelectorAll("[data-del]").forEach(function(b){b.addEventListener("click",function(){deleteAccount(b.getAttribute("data-del"))})});';
  h += 'el.querySelectorAll("[data-test]").forEach(function(b){b.addEventListener("click",function(){testAccount(b.getAttribute("data-test"))})});';
  h += 'el.querySelectorAll("[data-move-up]").forEach(function(b){b.addEventListener("click",function(){moveAccount(b.getAttribute("data-move-up"),-1)})});';
  h += 'el.querySelectorAll("[data-move-down]").forEach(function(b){b.addEventListener("click",function(){moveAccount(b.getAttribute("data-move-down"),1)})});';
  h += 'el.querySelectorAll("[data-ae]").forEach(function(b){b.addEventListener("click",function(){openEditAccount(b.getAttribute("data-ae"))})});';
  h += 'el.querySelectorAll("[data-toggle-enabled]").forEach(function(b){b.addEventListener("click",function(){toggleAccountEnabled(b.getAttribute("data-toggle-enabled"))})});';
  h += '}';

  h += 'function esc(s){if(!s)return "";return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\x27/g,"&#x27;")}';
  h += 'function scaleVal(n){return Number(n||0)/1000000}';
  // ---- Rates 结构化编辑器 ----
  h += 'function parseRatesToRows(text){var rows=[];String(text||"").split("\\n").forEach(function(line){line=line.trim();if(!line||line.startsWith("#"))return;var parts=line.split(/\\s+/).filter(Boolean);if(!parts.length)return;var row={model:parts.shift(),input:"",output:"",cache_hit:"",cache_create:"",multiplier:"",time_mult:"",calls:""};for(var i=0;i<parts.length;i++){var eq=parts[i].indexOf("=");if(eq<=0)continue;var k=parts[i].substring(0,eq).trim();var v=parts[i].substring(eq+1).trim();if(k==="time_mult")row.time_mult=v;else if(k in row)row[k]=v}rows.push(row)});if(!rows.length)rows.push({model:"*",input:"",output:"",cache_hit:"",cache_create:"",multiplier:"",time_mult:"",calls:""});return rows}';
  h += 'function rowsToRatesText(rows){var lines=[];for(var i=0;i<rows.length;i++){var r=rows[i];if(!r.model)continue;var parts=[r.model];if(r.calls){parts.push("calls="+r.calls)}else{if(r.input)parts.push("input="+r.input);if(r.output)parts.push("output="+r.output);if(r.cache_hit)parts.push("cache_hit="+r.cache_hit);if(r.cache_create)parts.push("cache_create="+r.cache_create)}if(r.multiplier)parts.push("multiplier="+r.multiplier);if(r.time_mult)parts.push("time_mult="+r.time_mult);lines.push(parts.join(" "))}return lines.join("\\n")}';
  h += 'window._rateEditors={};';
  h += 'function ratesSync(edId){var s=window._rateEditors[edId];if(!s)return;var rows=[];var els=s.ed.querySelectorAll(".rates-row:not(.rates-header)");for(var ri=0;ri<els.length;ri++){var el=els[ri];var row={model:el.querySelector(".rate-cell-model").value.trim()||""};if(s.showCalls==="mixed"){row.input=el.querySelector(".rate-input").value;row.output=el.querySelector(".rate-output").value;row.cache_hit=el.querySelector(".rate-cache_hit").value;row.cache_create=el.querySelector(".rate-cache_create").value;row.multiplier=el.querySelector(".rate-multiplier").value;row.time_mult=el.querySelector(".rate-time_mult").value.trim();row.calls=el.querySelector(".rate-cell-calls").value}else if(s.showCalls){row.calls=el.querySelector(".rate-cell-calls").value}else{row.input=el.querySelector(".rate-input").value;row.output=el.querySelector(".rate-output").value;row.cache_hit=el.querySelector(".rate-cache_hit").value;row.cache_create=el.querySelector(".rate-cache_create").value;row.multiplier=el.querySelector(".rate-multiplier").value;row.time_mult=el.querySelector(".rate-time_mult").value.trim()}rows.push(row)}s.rows=rows;s.ta.value=rowsToRatesText(rows)}';
  h += 'function ratesMoveUp(edId,i){ratesSync(edId);var rr=window._rateEditors[edId].rows;if(i>0&&i<rr.length){var t=rr[i];rr[i]=rr[i-1];rr[i-1]=t}ratesRender(edId)}';
  h += 'function ratesMoveDown(edId,i){ratesSync(edId);var rr=window._rateEditors[edId].rows;if(i>=0&&i<rr.length-1){var t=rr[i];rr[i]=rr[i+1];rr[i+1]=t}ratesRender(edId)}';
  h += 'function ratesDelete(edId,i){ratesSync(edId);window._rateEditors[edId].rows.splice(i,1);ratesRender(edId)}';
  h += 'function ratesAddRow(edId){ratesSync(edId);var s=window._rateEditors[edId];if(!s)return;var nr={model:""};if(s.showCalls==="mixed"){nr.input="";nr.output="";nr.cache_hit="";nr.cache_create="";nr.multiplier="";nr.time_mult="";nr.calls=""}else if(s.showCalls){nr.calls=""}else{nr.input="";nr.output="";nr.cache_hit="";nr.cache_create="";nr.multiplier="";nr.time_mult=""}s.rows.push(nr);ratesRender(edId)}';
  h += 'function ratesRender(edId){var s=window._rateEditors[edId];if(!s)return;var rows=s.rows;var showCalls=s.showCalls;var h2="";h2+="<div class=\\"rates-row rates-header\\"><span class=\\"rate-cell rate-cell-model\\">模型</span>";if(showCalls==="mixed"){h2+="<span class=\\"rate-cell rate-cell-num\\">input</span><span class=\\"rate-cell rate-cell-num\\">output</span><span class=\\"rate-cell rate-cell-num\\">cache_hit</span><span class=\\"rate-cell rate-cell-num\\">cache_create</span><span class=\\"rate-cell rate-cell-num\\">multiplier</span><span class=\\"rate-cell rate-cell-time\\">time_mult</span><span class=\\"rate-cell rate-cell-calls\\">calls</span>"}else if(showCalls){h2+="<span class=\\"rate-cell rate-cell-calls\\">calls</span>"}else{h2+="<span class=\\"rate-cell rate-cell-num\\">input</span><span class=\\"rate-cell rate-cell-num\\">output</span><span class=\\"rate-cell rate-cell-num\\">cache_hit</span><span class=\\"rate-cell rate-cell-num\\">cache_create</span><span class=\\"rate-cell rate-cell-num\\">multiplier</span><span class=\\"rate-cell rate-cell-time\\">time_mult</span>"}h2+="<span class=\\"rate-cell rate-cell-actions\\">操作</span></div>";for(var i=0;i<rows.length;i++){var r=rows[i];h2+="<div class=\\"rates-row\\" data-idx=\\""+i+"\\"><input class=\\"rate-cell rate-cell-model\\" value=\\""+esc(r.model||"")+"\\" placeholder=\\"*\\">";if(showCalls==="mixed"){h2+="<input class=\\"rate-cell rate-cell-num rate-input\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.input||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-output\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.output||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-cache_hit\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.cache_hit||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-cache_create\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.cache_create||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-multiplier\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.multiplier||"")+"\\" placeholder=\\"1\\"><input class=\\"rate-cell rate-cell-time rate-time_mult\\" value=\\""+esc(r.time_mult||"")+"\\" placeholder=\\"HH:MM-HH:MM=系数\\"><input class=\\"rate-cell rate-cell-calls\\" type=\\"number\\" step=\\"1\\" min=\\"0\\" value=\\""+esc(r.calls||"")+"\\" placeholder=\\"0\\">"}else if(showCalls){h2+="<input class=\\"rate-cell rate-cell-calls\\" type=\\"number\\" step=\\"1\\" min=\\"0\\" value=\\""+esc(r.calls||"")+"\\" placeholder=\\"0\\">"}else{h2+="<input class=\\"rate-cell rate-cell-num rate-input\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.input||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-output\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.output||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-cache_hit\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.cache_hit||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-cache_create\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.cache_create||"")+"\\" placeholder=\\"0\\"><input class=\\"rate-cell rate-cell-num rate-multiplier\\" type=\\"number\\" step=\\"0.01\\" min=\\"0\\" value=\\""+esc(r.multiplier||"")+"\\" placeholder=\\"1\\"><input class=\\"rate-cell rate-cell-time rate-time_mult\\" value=\\""+esc(r.time_mult||"")+"\\" placeholder=\\"HH:MM-HH:MM=系数\\">"}h2+="<span class=\\"rate-cell-actions\\"><button class=\\"rate-btn-move\\" onclick=\\"ratesMoveUp(\u0027"+edId+"\u0027,"+i+")\\""+(i===0?" disabled":"")+">▲</button><button class=\\"rate-btn-move\\" onclick=\\"ratesMoveDown(\u0027"+edId+"\u0027,"+i+")\\""+(i===rows.length-1?" disabled":"")+">▼</button><button class=\\"rate-btn-del\\" onclick=\\"ratesDelete(\u0027"+edId+"\u0027,"+i+")\\">✕</button></span></div>"}h2+="<button class=\\"rate-btn-add\\" onclick=\\"ratesAddRow(\u0027"+edId+"\u0027)\\">+ ✚ 添加定价</button>";s.ed.innerHTML=h2;s.ta.value=rowsToRatesText(rows)}';
  h += 'function initRatesEditor(textareaId,editorId,showCalls){var ta=document.getElementById(textareaId);var ed=document.getElementById(editorId);var rows=parseRatesToRows(ta.value);window._rateEditors[editorId]={ta:ta,ed:ed,rows:rows,showCalls:showCalls};ratesRender(editorId);ta.style.display="none"}';  h += 'function findAllowanceInfo(a){';
  h += 'var groups=allowanceConfig.shared_groups||[];';
  h += 'for(var i=0;i<groups.length;i++){var g=groups[i];if(g&&g.enabled!==false&&(g.account_ids||[]).indexOf(a.id)!==-1)return{type:"shared",group:g,targetId:"shared:"+g.id}}';
  h += 'var q=(allowanceConfig.account_quotas||{})[a.id];if(q&&q.enabled!==false)return{type:"total",quota:q,targetId:"account:"+a.id};';
  h += 'return null}';
  h += 'function groupColor(name){var pal=["bg-green","bg-blue","bg-purple","bg-orange","bg-teal","bg-pink"];var h=0;for(var i=0;i<name.length;i++){h=(h*31+name.charCodeAt(i))>>>0}return pal[h%pal.length]}';
  h += 'function renderAllowanceCell(a){';
  h += 'var ae="data-ae=\\""+a.id+"\\" style=\\"cursor:pointer\\"";';
  h += 'var info=findAllowanceInfo(a);if(!info)return "<span class=\\"gray\\">-</span>";';
  h += 'var st=allowanceStatus[info.targetId]||{};var fallbackTotal=info.type==="shared"?Number(info.group.initial_balance||0)*1000000:Number(info.quota.initial_total||0);var rem=Number(st.remainingUnits!=null?st.remainingUnits:(st.remaining_units!=null?st.remaining_units:fallbackTotal));var total=Number(st.totalUnits!=null?st.totalUnits:(st.total_units!=null?st.total_units:fallbackTotal));';
  h += 'if(info.type==="shared"){var v=Math.max(0,scaleVal(rem));if(v<=0)return "<span "+ae+" class=\\"badge bg-red\\">¥0.00</span>";return "<span "+ae+" class=\\"badge bg-green\\">¥"+v.toFixed(2)+"</span>"}';
  h += 'var exp=(st.expiresAt||info.quota.expires_at||"");var expired=false;if(exp){expired=(new Date(exp+"T23:59:59").getTime()<Date.now())}';
  h += 'if(expired)return "<span "+ae+" class=\\"badge bg-red\\">已过期</span>";';
h += 'if(info.quota.mode==="count"){var cls2=rem<=0?"badge bg-red":"badge bg-green";return "<span "+ae+" class=\\""+cls2+"\\">"+rem+"次</span>"}';
h += 'if(info.quota.display_currency){var v=Math.max(0,scaleVal(rem));var cls2=v<=0?"badge bg-red":"badge bg-green";return "<span "+ae+" class=\\""+cls2+"\\"> ¥"+v.toFixed(2)+"</span>"}';
  h += 'var pct=total>0?Math.max(0,rem/total*100):0;var disp=pct.toFixed(2)+"%";var cls2=pct<=0?"badge bg-red":"badge bg-green";return "<span "+ae+" class=\\""+cls2+"\\">"+disp+"</span>"';
  h += '}';
  h += 'function getAllowanceFormData(){';
  h += 'var type=document.getElementById("f_poolMode").value==="true"?"shared":"total";var data={type:type};';
  h += 'if(type==="shared"){var ids=[];document.querySelectorAll(".allow-acct:checked").forEach(function(cb){ids.push(cb.value)});data.shared_group_name=document.getElementById("f_sharedGroupName").value.trim();data.shared_balance=parseFloat(document.getElementById("f_sharedBalance").value)||0;data.shared_account_ids=ids;data.account_rates_text=document.getElementById("f_accountRates").value}';
  h += 'if(type==="total"){data.quota_mode=document.getElementById("f_quotaMode").value;data.quota_expires_at=document.getElementById("f_quotaExpires").value;data.quota_total=parseFloat(document.getElementById("f_quotaTotal").value)||0;data.quota_rates_text=document.getElementById("f_quotaRates").value;data.quota_display_currency=document.getElementById("f_quotaDisplayCurrency").checked;var remEl=document.getElementById("f_quotaRemaining");var remVal=remEl&&remEl.closest(".form-group").style.display!=="none"?remEl.value:"";if(remVal!==""&&data.quota_mode==="points"){var total=data.quota_total||1;remVal=Math.ceil(Number(remVal)/100*total)}data.remaining=remVal}';
  h += 'return data}';
  h += 'function renderAllowanceAccounts(currentId,selectedIds){var el=document.getElementById("f_sharedAccounts");if(!el)return;var html="";selectedIds=selectedIds||[];for(var i=0;i<accounts.length;i++){var a=accounts[i];var checked=(a.id===currentId||selectedIds.indexOf(a.id)!==-1)?" checked":"";html+="<label style=\\"display:block;margin:4px 0\\"><input type=\\"checkbox\\" class=\\"allow-acct\\" value=\\""+a.id+"\\""+checked+"> "+esc(a.name)+"</label>"}el.innerHTML=html||"<span class=\\"gray\\">暂无账号</span>"}';
  h += 'function toggleAllowanceSections(){var pm=document.getElementById("f_poolMode").value==="true";var type=pm?"shared":"total";document.getElementById("allowanceSharedBox").style.display=type==="shared"?"block":"none";document.getElementById("allowanceTotalBox").style.display=type==="total"?"block":"none";var rc=document.getElementById("f_retryCountGroup");if(rc)rc.style.display=pm?"":"none";var rs=document.getElementById("f_retryStatusesGroup");if(rs)rs.style.display=pm?"":"none"}';
  h += 'function currentYearEnd(){var d=new Date();return d.getFullYear()+"-12-31"}';
  h += 'function refreshRatesEditors(){var quotaTa=document.getElementById("f_quotaRates");var quotaEd=document.getElementById("quotaRatesEditor");var accountTa=document.getElementById("f_accountRates");var accountEd=document.getElementById("accountRatesEditor");if(quotaTa&&quotaEd){var showCalls=document.getElementById("f_quotaMode").value==="count";initRatesEditor("f_quotaRates","quotaRatesEditor",showCalls)}if(accountTa&&accountEd){initRatesEditor("f_accountRates","accountRatesEditor","mixed")}}';
  h += 'function updateQuotaRates(){var mode=document.getElementById("f_quotaMode").value;var row=document.getElementById("f_quotaDisplayCurrencyRow");if(row)row.style.display=mode==="usage"?"block":"none";var dc=document.getElementById("f_quotaDisplayCurrency");if(dc&&mode!=="usage")dc.checked=false;var remRow=document.getElementById("f_quotaRemainingRow");if(remRow){remRow.style.display=mode==="usage"?"none":"block";var remLabel=remRow.querySelector("label");if(remLabel)remLabel.textContent=mode==="points"?"余量(%)":"余量"}var tl=document.getElementById("f_quotaTotalLabel");if(tl){if(mode==="count")tl.textContent="总次数";else if(mode==="usage")tl.textContent="总量";else if(mode==="points")tl.textContent="总积分"}var re=document.getElementById("f_quotaRates");if(re&&!re.value.trim()){if(mode==="count")re.value="* calls=1";else re.value="* input=1 output=4 cache_hit=0.15 cache_create=1"}refreshRatesEditors()}';
  h += 'function showModelPicker(){var el=document.getElementById("modelPickerPanel");if(el.style.display!=="none"){el.style.display="none";return}var url=document.getElementById("f_url").value.trim();var key=document.getElementById("f_key").value.trim();if(!url||!key){toast("请先填写接口地址和API Key","err");return}el.innerHTML="<div style=\\"text-align:center;padding:20px;color:#999\\">正在获取模型列表...</div>";el.style.display="block";adminFetch(base+"/admin/accounts/fetch-models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({base_url:url,api_key:key})}).then(function(r){return r.json()}).then(function(d){if(!d.success){el.innerHTML="<div style=\\"padding:12px;color:#c00\\">获取失败: "+esc(d.error||"")+"</div><div style=\\"margin-top:8px\\"><button class=\\"btn btn-sm btn-outline\\" id=\\"btnPickerCancel\\">返回</button></div>";document.getElementById("btnPickerCancel").addEventListener("click",function(){el.style.display="none"});return}if(!d.models||!d.models.length){el.innerHTML="<div style=\\"padding:12px;color:#888\\">上游无可用模型</div><div style=\\"margin-top:8px\\"><button class=\\"btn btn-sm btn-outline\\" id=\\"btnPickerCancel\\">返回</button></div>";document.getElementById("btnPickerCancel").addEventListener("click",function(){el.style.display="none"});return}var html="<div style=\\"font-size:12px;color:#888;margin-bottom:8px\\">共 "+d.models.length+" 个模型，勾选后点确定</div><div style=\\"max-height:40vh;overflow-y:auto;border:1px solid #eee;border-radius:6px;padding:8px;display:flex;flex-wrap:wrap;align-items:flex-start\\">";for(var i=0;i<d.models.length;i++){var mid=d.models[i];html+="<label style=\\"display:inline-flex;align-items:center;gap:4px;padding:4px 10px;cursor:pointer;user-select:none;font-size:13px;white-space:nowrap\\"><input type=\\"checkbox\\" class=\\"picker-cb\\" value=\\""+esc(mid)+"\\">"+esc(mid)+"</label>"}html+="</div><div style=\\"display:flex;justify-content:flex-end;gap:8px;margin-top:10px\\"><button class=\\"btn btn-sm btn-outline\\" id=\\"btnPickerCancel\\">返回</button><button class=\\"btn btn-sm btn-primary\\" id=\\"btnPickerConfirm\\">确定</button></div>";el.innerHTML=html;document.getElementById("btnPickerCancel").addEventListener("click",function(){el.style.display="none"});document.getElementById("btnPickerConfirm").addEventListener("click",function(){var ta=document.getElementById("f_models");var cbs=el.querySelectorAll(".picker-cb:checked");var added=[];for(var j=0;j<cbs.length;j++){added.push(cbs[j].value)}if(!added.length){toast("请至少勾选一个模型","err");return}if(ta.value&&!ta.value.endsWith("\\n"))ta.value+="\\n";ta.value+=added.join("\\n");el.style.display="none";var allowanceType=document.getElementById("f_allowanceType").value;if(allowanceType==="shared"||allowanceType==="total"){var ratesTa=allowanceType==="shared"?document.getElementById("f_sharedRates"):document.getElementById("f_quotaRates");var editorId=allowanceType==="shared"?"sharedRatesEditor":"quotaRatesEditor";var showCalls=allowanceType==="total"&&document.getElementById("f_quotaMode").value==="count";var ratesRows=parseRatesToRows(ratesTa.value);var exist={};for(var j=0;j<ratesRows.length;j++){exist[ratesRows[j].model]=true}var changed=false;for(var j=0;j<added.length;j++){if(!exist[added[j]]&&added[j]!=="*"){ratesRows.push(showCalls?{model:added[j],calls:""}:{model:added[j],input:"",output:"",cache_hit:"",cache_create:"",multiplier:"",time_mult:""});exist[added[j]]=true;changed=true}}if(changed){ratesTa.value=rowsToRatesText(ratesRows);initRatesEditor(ratesTa.id,editorId,showCalls)}}})}).catch(function(e){el.innerHTML="<div style=\\"padding:12px;color:#c00\\">请求失败: "+esc(e.message)+"</div><div style=\\"margin-top:8px\\"><button class=\\"btn btn-sm btn-outline\\" id=\\"btnPickerCancel\\">返回</button></div>";document.getElementById("btnPickerCancel").addEventListener("click",function(){el.style.display="none"})})}';
  h += 'function fillAllowanceForm(a){';
  h += 'var info=findAllowanceInfo(a);';
  h += 'document.getElementById("f_sharedGroupName").value="";document.getElementById("f_sharedBalance").value="";document.getElementById("f_accountRates").value="";';
  h += 'document.getElementById("f_quotaMode").value="count";document.getElementById("f_quotaExpires").value=currentYearEnd();document.getElementById("f_quotaTotal").value="";document.getElementById("f_quotaRemaining").value="";updateQuotaRates();';
  h += 'if(!info){document.getElementById("f_quotaRates").value="";renderAllowanceAccounts(a?a.id:"",[]);toggleAllowanceSections();refreshRatesEditors();return}';
  h += 'if(info.type==="shared"){document.getElementById("f_sharedGroupName").value=info.group.name||"";var sharedSt=allowanceStatus[info.targetId]||{};var sharedRem=sharedSt.remainingUnits!=null?Number(sharedSt.remainingUnits)/1000000:(info.group.initial_balance||0);document.getElementById("f_sharedBalance").value=sharedRem;var accountQuota=(allowanceConfig.account_quotas||{})[a.id];document.getElementById("f_accountRates").value=accountQuota&&accountQuota.rates_text?accountQuota.rates_text:"";renderAllowanceAccounts(a.id,info.group.account_ids||[])}';
  h += 'else{document.getElementById("f_quotaMode").value=info.quota.mode||"count";document.getElementById("f_quotaExpires").value=info.quota.expires_at||"";document.getElementById("f_quotaRates").value=info.quota.rates_text||"";document.getElementById("f_quotaDisplayCurrency").checked=info.quota.display_currency===true;var st=allowanceStatus[info.targetId]||{};var isCur=info.quota.display_currency===true;var mode=info.quota.mode;var remVal="";var totalVal=info.quota.initial_total||"";if(st.remainingUnits!=null){if(mode==="points"&&st.totalUnits>0){remVal=(Number(st.remainingUnits)/Number(st.totalUnits)*100).toFixed(2)}else if(isCur){remVal=Number(st.remainingUnits)/1000000;totalVal=remVal}else{remVal=st.remainingUnits}}document.getElementById("f_quotaTotal").value=totalVal;document.getElementById("f_quotaRemaining").value=remVal;renderAllowanceAccounts(a.id,[])}';
  h += 'var sr=document.getElementById("f_quotaRates").value;updateQuotaRates();document.getElementById("f_quotaRates").value=sr;toggleAllowanceSections();refreshRatesEditors()}';

  // 打开新增弹窗
  h += 'function openAddAccount(){';
  h += '_lastActive=document.activeElement;';
  h += 'document.getElementById("modalTitle").textContent="新增上游账号";';
  h += 'document.getElementById("editId").value="";';
  h += 'document.getElementById("f_name").value="";';
  h += 'document.getElementById("f_url").value="";';
  h += 'document.getElementById("f_key").value="";';
  h += 'document.getElementById("f_models").value="";';
  h += 'document.getElementById("f_modelMap").value="";';
  h += 'document.getElementById("f_priority").value="1";';
  h += 'document.getElementById("f_weight").value="1";';
  h += 'document.getElementById("f_poolMode").value="false";';
  h += 'document.getElementById("f_retryCount").value="3";';
  h += 'document.getElementById("f_retryStatuses").value="401,403,429";';
  h += 'document.getElementById("f_maxConcurrency").value="0";';
  h += 'document.getElementById("f_enabled").value="true";';
  h += 'document.getElementById("f_note").value="";';
  h += 'fillAllowanceForm({id:"",name:""});';
  h += 'document.getElementById("modal").classList.add("show");';
  h += 'setTimeout(function(){document.getElementById("f_name").focus()},50)';
  h += '}';

  // 关闭弹窗
  h += 'var _lastActive=null;function closeModal(){document.getElementById("modal").classList.remove("show");if(_lastActive){try{_lastActive.focus()}catch(e){}_lastActive=null}}';

  // API Key 显示/隐藏切换
  h += 'function toggleKey(){';
  h += 'var el=document.getElementById("f_key");';
  h += 'var btn=document.getElementById("btnToggleKey");';
  h += 'if(el.type==="password"){el.type="text";btn.textContent="隐藏"}';
  h += 'else{el.type="password";btn.textContent="显示"}';
  h += '}';

  // 保存上游账号
  h += 'async function saveAccount(){';
  h += 'ratesSync("quotaRatesEditor");ratesSync("accountRatesEditor");';
  h += 'var id=document.getElementById("editId").value;';
  h += 'var name=document.getElementById("f_name").value.trim();';
  h += 'var url=document.getElementById("f_url").value.trim();';
  h += 'var key=document.getElementById("f_key").value.trim();';
  h += 'var mtext=document.getElementById("f_models").value.trim();';
  h += 'var p=parseInt(document.getElementById("f_priority").value)||0;';
  h += 'var w=parseInt(document.getElementById("f_weight").value)||1;';
  h += 'var mc=parseInt(document.getElementById("f_maxConcurrency").value)||0;if(mc<0)mc=0;';
  h += 'var en=document.getElementById("f_enabled").value==="true";';
  h += 'var note=document.getElementById("f_note").value.trim();';
  h += 'if(!name){toast("名称不能为空","err");return}if(en&&(!url||!key||!mtext)){toast("启用账号请填完所有必填项","err");return}';
    h += 'var models=mtext.split("\\n").map(function(s){return s.trim()}).filter(Boolean);';
  h += 'var pm=document.getElementById("f_poolMode").value==="true";';
  h += 'var rc=parseInt(document.getElementById("f_retryCount").value)||0;';
  h += 'if(rc<0)rc=0;if(rc>10)rc=10;';
  h += 'var allowType=pm?"shared":"total";var ratesText=allowType==="shared"?document.getElementById("f_accountRates").value:document.getElementById("f_quotaRates").value;var rr=parseRatesToRows(ratesText);if(en){var rMap={};var hasStar=false;for(var ri=0;ri<rr.length;ri++){rMap[rr[ri].model]=rr[ri];if(rr[ri].model==="*")hasStar=true}if(hasStar){var wc=rMap["*"];if(!wc.input&&!wc.output&&!wc.cache_hit&&!wc.cache_create&&!wc.calls)hasStar=false}if(!hasStar){var missing=[];for(var mi=0;mi<models.length;mi++){var mm=models[mi];var rm=rMap[mm];if(!rm||(!rm.input&&!rm.output&&!rm.cache_hit&&!rm.cache_create&&!rm.calls))missing.push(mm)}if(missing.length){toast("以下模型缺少消耗规则: "+missing.join(", "),"err");return}}};'
  h += 'var format=document.getElementById("f_format").value;';
  h += 'var mmtext=document.getElementById("f_modelMap").value.trim();';
  h += 'var model_map={};';
  h += 'if(mmtext){mmtext.split("\\n").map(function(s){return s.trim()}).filter(Boolean).forEach(function(line){var eq=line.indexOf("=");if(eq>0){var keyName=line.substring(0,eq).trim();var val=line.substring(eq+1).trim();if(keyName&&val)model_map[keyName]=val}})}';
  h += 'var rsText=document.getElementById("f_retryStatuses").value.trim();';
  h += 'var rs=[];if(rsText){rs=rsText.split(",").map(function(s){return parseInt(s.trim())}).filter(function(n){return!isNaN(n)})}';
  h += 'if(!rs.length)rs=[401,403,429];';
  h += 'var body={name:name,base_url:url,api_key:key,format:format,models:models,model_map:model_map,priority:p,weight:w,max_concurrency:mc,enabled:en,note:note,pool_mode:pm,pool_mode_retry_count:rc,pool_retry_statuses:rs,allowance:getAllowanceFormData()};';
  h += 'if(id)body.id=id;';
  h += 'try{var r=await adminFetch(base+"/admin/accounts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});';
  h += 'var d=await r.json();';
  h += 'if(d.success){toast("保存成功","ok");closeModal();loadAccountsList()}else{toast("保存失败: "+d.error,"err")}';
  h += '}catch(e){toast("保存失败","err")}';
  h += '}';

  // 打开编辑弹窗
  h += 'async function openEditAccount(id){';
  h += '_lastActive=document.activeElement;';
  h += 'var a=null;for(var i=0;i<accounts.length;i++){if(accounts[i].id===id){a=accounts[i];break}}';
  h += 'if(!a){toast("账号不存在","err");return}';
  h += 'document.getElementById("modalTitle").textContent="编辑上游账号";';
  h += 'document.getElementById("editId").value=a.id;';
  h += 'document.getElementById("f_name").value=a.name||"";';
  h += 'document.getElementById("f_url").value=a.base_url||"";';
  h += 'document.getElementById("f_key").value=a.api_key||"";';
  h += 'document.getElementById("f_models").value=(a.models||[]).join("\\n");';
  h += 'var mmLines=[];if(a.model_map){for(var mk in a.model_map){if(a.model_map.hasOwnProperty(mk))mmLines.push(mk+"="+a.model_map[mk])}}';
  h += 'document.getElementById("f_modelMap").value=mmLines.join("\\n");';
  h += 'document.getElementById("f_format").value=a.format||"openai";';
  h += 'document.getElementById("f_priority").value=a.priority||1;';
  h += 'document.getElementById("f_weight").value=a.weight||1;';
  h += 'document.getElementById("f_maxConcurrency").value=a.max_concurrency!=null?a.max_concurrency:0;';
  h += 'document.getElementById("f_poolMode").value=a.pool_mode===true?"true":"false";';
  h += 'document.getElementById("f_retryCount").value=(a.pool_mode_retry_count!=null?a.pool_mode_retry_count:3);';
  h += 'var rsArr=a.pool_retry_statuses||[401,403,429];';
  h += 'document.getElementById("f_retryStatuses").value=rsArr.join(",");';
  h += 'document.getElementById("f_enabled").value=(a.enabled!==false)?"true":"false";';
  h += 'document.getElementById("f_note").value=a.note||"";';
  h += 'fillAllowanceForm(a);';
  h += 'document.getElementById("modal").classList.add("show");';
  h += 'setTimeout(function(){document.getElementById("f_name").focus()},50)';
  h += '}';

  // 删除上游账号
  h += 'async function deleteAccount(id){';
  h += 'if(!confirm("确定要删除此账号吗？"))return;';
  h += 'try{var r=await adminFetch(base+"/admin/accounts?id="+encodeURIComponent(id),{method:"DELETE"});';
  h += 'var d=await r.json();';
  h += 'if(d.success){toast("已删除","ok");loadAccountsList()}else{toast("删除失败","err")}';
  h += '}catch(e){toast("删除失败","err")}';
  h += '}';

  // 切换账号启用/禁用状态
  h += 'async function toggleAccountEnabled(id){';
  h += 'var a=null;for(var i=0;i<accounts.length;i++){if(accounts[i].id===id){a=accounts[i];break}}';
  h += 'if(!a){toast("账号不存在","err");return}';
  h += 'var newEnabled=a.enabled===false?true:false;';
  h += 'try{';
  h += 'var body={name:a.name,base_url:a.base_url,api_key:a.api_key,format:a.format||"openai",models:a.models||[],model_map:a.model_map||{},priority:a.priority||1,weight:a.weight||1,max_concurrency:a.max_concurrency||0,enabled:newEnabled,note:a.note||"",pool_mode:a.pool_mode===true,pool_mode_retry_count:a.pool_mode_retry_count!=null?a.pool_mode_retry_count:3,pool_retry_statuses:a.pool_retry_statuses||[401,403,429],id:id};';
  h += 'var r=await adminFetch(base+"/admin/accounts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});';
  h += 'var d=await r.json();';
  h += 'if(d.success){toast(newEnabled?"已启用":"已禁用","ok");loadAccountsList()}else{toast("切换失败: "+d.error,"err")}';
  h += '}catch(e){toast("切换失败","err")}';
  h += '}';

  // 测试：先弹选单再测试
  h += 'async function testAccount(id){';
  h += 'var a=null;for(var i=0;i<accounts.length;i++){if(accounts[i].id===id){a=accounts[i];break}}';
  h += 'if(!a){toast("账号不存在","err");return}';
  // 收集可选测试项
  h += 'var items=[];';
  h += 'for(var j=0;j<(a.models||[]).length;j++){items.push({label:esc(a.models[j])+"（原始）"})}';
  h += 'if(a.model_map){for(var mk in a.model_map){if(a.model_map.hasOwnProperty(mk)){items.push({label:esc(mk)+" → "+esc(a.model_map[mk])})}}}';
  h += 'if(items.length===0){toast("没有可测试的模型或映射","err");return}';
  // 渲染选择界面
  h += 'var el=document.getElementById("modalTestBody");';
  h += 'var html="<p style=\\"margin-bottom:10px;color:#333\\">账号: <b>"+esc(a.name)+"</b> &nbsp; 共 "+items.length+" 项可测</p>";';
  h += 'html+="<div style=\\"margin-bottom:10px\\"><label style=\\"font-weight:600;cursor:pointer;user-select:none\\"><input type=\\"checkbox\\" id=\\"chkAll\\" checked> 全测</label></div>";';
  h += 'html+="<div style=\\"max-height:300px;overflow-y:auto;border:1px solid #ddd;border-radius:6px;padding:8px\\">";';
  h += 'for(var i=0;i<items.length;i++){';
  h += 'html+="<label style=\\"display:flex;align-items:center;gap:6px;padding:4px 0;cursor:pointer;user-select:none\\"><input type=\\"checkbox\\" class=\\"test-item\\" checked> "+items[i].label+"</label>"';
  h += '}';
  h += 'html+="</div>";';
  h += 'html+="<div class=\\"flex-end\\" style=\\"margin-top:12px;gap:8px\\"><button class=\\"btn btn-outline\\" id=\\"btnCancelTest\\">取消</button><button class=\\"btn btn-primary\\" id=\\"btnRunTest\\">开始测试</button></div>";';
  h += 'el.innerHTML=html;';
  h += 'document.getElementById("modalTestTitle").textContent="选择测试项 — "+esc(a.name);';
  h += 'document.getElementById("modalTest").classList.add("show");';
  // 全测勾选框
  h += 'document.getElementById("chkAll").addEventListener("change",function(){var c=this.checked;document.querySelectorAll(".test-item").forEach(function(cb){cb.checked=c})});';
  // 取消
  h += 'document.getElementById("btnCancelTest").addEventListener("click",function(){document.getElementById("modalTest").classList.remove("show")});';
  // 开始测试
  h += 'document.getElementById("btnRunTest").addEventListener("click",async function(){';
  h += 'var indices=[];var cbs=document.querySelectorAll(".test-item");';
  h += 'for(var i=0;i<cbs.length;i++){if(cbs[i].checked)indices.push(i)}';
  h += 'if(!indices.length){toast("请至少选择一项","err");return}';
  h += 'this.disabled=true;this.textContent="测试中...";';
  h += 'try{';
  h += 'var r=await adminFetch(base+"/admin/accounts/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:a.id,testIndices:indices})});';
  h += 'var d=await r.json();';
  h += 'if(d.success){showTestResults(a.name,d.results)}else{toast("测试失败: "+d.error,"err")}';
  h += '}catch(e){toast("测试请求失败: "+e.message,"err")}';
  h += '});';
  h += '}';

  // 显示测试结果弹窗
  h += 'function showTestResults(name,results){';
  h += 'var el=document.getElementById("modalTestBody");';
  h += 'var html="<p style=\\"margin-bottom:10px;color:#333\\">账号: <b>"+esc(name)+"</b> &nbsp; 共 "+results.length+" 项</p>";';
  h += 'html+="<table><thead><tr><th>模型</th><th>耗时</th><th>错误信息</th><th>重试</th><th>结果</th><th>状态码</th></tr></thead><tbody>";';
  h += 'for(var i=0;i<results.length;i++){var r=results[i];';
  h += 'var icon=r.ok?"✅":"❌";';
  h += 'var cls=r.ok?"bg-green":"bg-red";';
  h += 'html+="<tr><td style=\\"max-width:200px;word-break:break-all\\">"+esc(r.label)+"</td>";';
  h += 'html+="<td>"+((r.latency_ms/1000).toFixed(2)+"s")+"</td>";';
  h += 'html+="<td style=\\"max-width:250px;word-break:break-all;color:#c00;font-size:12px\\">"+esc(r.error||"-")+"</td>";';
  h += 'html+="<td>"+(r.retries?r.retries+"次":"0")+"</td>";';
  h += 'html+="<td><span class=\\"badge "+cls+"\\">"+icon+"</span></td>";';
  h += 'html+="<td>"+(r.status||"-")+"</td></tr>"';
  h += '}';
  h += 'html+="</tbody></table>";';
  h += 'el.innerHTML=html;';
  h += 'document.getElementById("modalTestTitle").textContent="测试结果 — "+esc(name);';
  h += 'document.getElementById("modalTest").classList.add("show")';
  h += '}';

  // toast 提示
  h += 'function toast(msg,tp){';
  h += 'var el=document.getElementById("toast");el.textContent=msg;';
  h += 'el.className="toast toast-"+(tp==="ok"?"ok":"err")+" show";';
  h += 'setTimeout(function(){el.classList.remove("show")},2500)';
  h += '}';

  // ========== 使用记录函数 ==========
  h += 'async function loadUsageLogs(){';
  h += 'try{await adminFetch(base+"/admin/usage/flush")}catch(e){}';
  h += 'try{var r=await adminFetch(base+"/admin/usage?limit="+usagePageSize+"&offset="+(usagePage*usagePageSize));var d=await r.json();';
  h += 'if(d.success){renderUsage(d.logs||[],d.stats||{},d.total||0)}else{renderUsage([],{},0)}}catch(e){renderUsage([],{},0)}';
  h += '}';
  h += 'function goUsagePage(p){usagePage=p;loadUsageLogs()}';
  h += 'function changeUsagePageSize(sz){usagePageSize=Number(sz);usagePage=0;loadUsageLogs()}';
  h += 'function toggleUsageSort(field){if(usageSortField===field){usageSortDir=usageSortDir==="asc"?"desc":"asc"}else{usageSortField=field;usageSortDir="asc"}usagePage=0;loadUsageLogs()}';

  h += 'function renderUsage(logs,stats,total){';
  h += 'var el=document.getElementById("usageLogs");';
  h += 'var pagEl=document.getElementById("usagePagination");';
  h += 'var html="";';
  h += 'if(total){';
  h += 'html+=\'<div style="margin-bottom:10px;font-size:13px;color:#666;display:flex;gap:16px">\';';
  h += 'html+="<span>总记录: "+total+"</span>";';
  h += 'html+="<span>成功: <b style=\\"color:#28a745\\">"+stats.success_count+"</b></span>";';
  h += 'html+="<span>失败: <b style=\\"color:#dc3545\\">"+stats.error_count+"</b></span>";';
  h += 'html+="</div>"';
  h += '}';
  h += 'if(!logs.length){html=\'<div class="empty"><p>暂无使用记录</p></div>\';el.innerHTML=html;';
  h += 'if(pagEl)pagEl.innerHTML="";return}';
  // 排序
  h += 'if(usageSortField==="account"){logs=logs.slice().sort(function(a,b){var na=(a.account_name||a.channel_name||"").toLowerCase();var nb=(b.account_name||b.channel_name||"").toLowerCase();if(na<nb)return usageSortDir==="asc"?-1:1;if(na>nb)return usageSortDir==="asc"?1:-1;return 0})}';
  h += 'if(usageSortField==="status"){logs=logs.slice().sort(function(a,b){var sa=(a.status||0);var sb=(b.status||0);if(sa<sb)return usageSortDir==="asc"?-1:1;if(sa>sb)return usageSortDir==="asc"?1:-1;return 0})}';
  h += 'html+="<table><thead><tr><th style=\\"cursor:pointer;user-select:none\\" data-sort=\\"account\\">上游账号"+(usageSortField==="account"?(usageSortDir==="asc"?" ▲":" ▼"):"")+"</th><th>时间</th><th>耗时</th><th>Tokens</th><th>请求模型</th><th>上游模型</th><th style=\\"cursor:pointer;user-select:none\\" data-sort=\\"status\\">状态"+(usageSortField==="status"?(usageSortDir==="asc"?" ▲":" ▼"):"")+"</th></tr></thead><tbody>";';
  h += 'for(var i=0;i<logs.length;i++){';
  h += 'var l=logs[i];';
  h += 'var time="-";if(l.created_at){var d=new Date(l.created_at);var MM=String(d.getMonth()+1).padStart(2,"0");var DD=String(d.getDate()).padStart(2,"0");var hh=String(d.getHours()).padStart(2,"0");var mm=String(d.getMinutes()).padStart(2,"0");var ss=String(d.getSeconds()).padStart(2,"0");time=MM+"/"+DD+" "+hh+":"+mm+":"+ss}';
  h += 'var statusClass=(l.status>=200&&l.status<300)?"badge bg-green":(l.status>=400?"badge bg-red":"badge");';
  h += 'var statusStr=l.status?String(l.status):(l.error?"Error":"-");';
  h += 'var inp=l.input_tokens||0;var out=l.output_tokens||0;var cache=l.cache_tokens||0;';
  h += 'var tokHtml="<span style=\\"font-size:13px\\">↑"+ft(inp)+" ↓"+ft(out)+"</span>";';
  h += 'if(cache>0){tokHtml+="<br><span style=\\"font-size:11px;color:#999\\">缓存 "+ft(cache)+"</span>"}';
  h += 'html+="<tr><td>"+esc(l.account_name||l.channel_name||"-")+"</td><td>"+time+"</td><td>"+(l.duration_ms?(l.duration_ms/1000).toFixed(2)+"s":"-")+"</td><td>"+tokHtml+"</td><td>"+esc(l.requested_model||"-")+"</td><td>"+esc(l.upstream_model||"-")+"</td><td><span class=\\""+statusClass+"\\">"+statusStr+"</span></td></tr>"';
  h += '}';
  h += 'html+="</tbody></table>";el.innerHTML=html;';
  h += 'var hdr=el.querySelector("thead tr");if(hdr){var th=document.createElement("th");th.textContent="用量";hdr.insertBefore(th,hdr.children[4]||null)}';
  h += 'var bodyRows=el.querySelectorAll("tbody tr");for(var ui=0;ui<bodyRows.length;ui++){var l2=logs[ui]||{};var td=document.createElement("td");td.textContent=(l2.consumed!==undefined&&l2.consumed!==null)?formatConsumed(l2.account_name||l2.channel_name||"",l2.consumed):"-";bodyRows[ui].insertBefore(td,bodyRows[ui].children[4]||null)}';
  h += 'el.querySelectorAll("[data-sort]").forEach(function(th){th.addEventListener("click",function(){toggleUsageSort(th.getAttribute("data-sort"))})});';
  // 页码
  h += 'if(!pagEl)return;';
  h += 'var totalPages=Math.ceil(total/usagePageSize)||1;';
  h += 'var ph="<span style=\\"font-size:13px;color:#666\\">每页</span>";';
  h += 'var szOpts=[25,50,100,1000];ph+="<select id=\\"pageSizeSelect\\" style=\\"font-size:12px;padding:2px 4px\\">";';
  h += 'for(var si=0;si<szOpts.length;si++){ph+="<option value=\\""+szOpts[si]+"\\""+(usagePageSize===szOpts[si]?" selected":"")+">"+szOpts[si]+"</option>"}';
  h += 'ph+="</select>";';
  h += 'ph+="<span style=\\"font-size:13px;color:#666;margin-left:4px\\">条</span>";';
  h += 'function pgBtn(txt,pg){return"<button class=\\"btn btn-xs btn-outline\\" data-page=\\""+pg+"\\">"+txt+"</button>"}';
  h += 'ph+="<span style=\\"margin:0 8px;font-size:13px;color:#666\\">共 "+total+" 条，第 "+(usagePage+1)+"/"+totalPages+" 页</span>";';
  h += 'if(usagePage>0){ph+=pgBtn("首页",0);ph+=pgBtn("上一页",usagePage-1)}';
  h += 'if(usagePage<totalPages-1){ph+=pgBtn("下一页",usagePage+1);ph+=pgBtn("末页",totalPages-1)}';
  h += 'pagEl.innerHTML=ph;';
  h += 'pagEl.querySelectorAll("[data-page]").forEach(function(b){b.addEventListener("click",function(){goUsagePage(parseInt(b.getAttribute("data-page"))||0)})});';
  h += 'document.getElementById("pageSizeSelect").addEventListener("change",function(){changeUsagePageSize(this.value)});';
  h += '}';

  h += 'async function clearUsageLogs(){';
  h += 'if(!confirm("确定要清空所有使用记录吗？"))return;';
  h += 'try{var r=await adminFetch(base+"/admin/usage",{method:"DELETE"});';
  h += 'var d=await r.json();';
  h += 'if(d.success){usagePage=0;loadUsageLogs()}else{toast("清空失败","err")}';
  h += '}catch(e){toast("清空失败","err")}';
  h += '}';

  // 上移/下移上游账号
  h += 'async function moveAccount(id,direction){';
  h += 'var idx=-1;for(var i=0;i<accounts.length;i++){if(accounts[i].id===id){idx=i;break}}';
  h += 'if(idx===-1)return;';
  h += 'var target=idx+direction;';
  h += 'if(target<0||target>=accounts.length)return;';
  h += 'var tmp=accounts[idx];';
  h += 'accounts[idx]=accounts[target];';
  h += 'accounts[target]=tmp;';
  h += 'renderAccounts();';
  h += 'var ids=accounts.map(function(a){return a.id});';
  h += 'try{var r=await adminFetch(base+"/admin/accounts/reorder",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:ids})});';
  h += 'var d=await r.json();';
  h += 'if(!d.success){loadAccountsList()}';
  h += '}catch(e){loadAccountsList()}';
  h += '}';

  // ========== 并发状态函数 ==========

  // 刷新并发状态（更新账号管理表的负载列 + 使用记录页的并发卡片）
  h += 'async function updateConcurrency(){';
  h += 'try{var r=await adminFetch(base+"/admin/concurrency");var d=await r.json();';
  h += 'if(!d.success)return;';
  // 更新账号管理表的负载列
  h += 'for(var i=0;i<d.accounts.length;i++){var a=d.accounts[i];';
  h += 'var cell=document.getElementById("conc-"+a.id);';
  h += 'if(cell){';
  h += 'var pct=a.max>0?Math.round(a.current/a.max*100):0;';
  h += 'var sc=a.max>0?(a.current>=a.max?"bg-red":(a.current>0?"bg-yellow":"bg-green")):(a.current>0?"bg-yellow":"bg-green");';
  h += '  var text=a.max>0?a.current+"/"+a.max:(a.current>0?String(a.current):"空闲");';
  h += 'cell.innerHTML="<span class=\\"badge "+sc+"\\">"+text+"</span>";';
  h += 'cell.className=""}}';
  h += '}catch(e){}';
  h += '}';
  h += 'var concurrencyTimer=null;';
  h += 'function startConcurrencyPolling(){updateConcurrency();if(!concurrencyTimer&&!document.hidden){concurrencyTimer=setInterval(updateConcurrency,1000)}}';
  h += 'function stopConcurrencyPolling(){if(concurrencyTimer){clearInterval(concurrencyTimer);concurrencyTimer=null}}';
  h += 'document.addEventListener("visibilitychange",function(){if(document.hidden){stopConcurrencyPolling()}else{startConcurrencyPolling()}});';

  // ========== 调用统计函数 ==========
  h += 'var statsData=null;var usagePage=0;var usagePageSize=25;var usageSortField="";var usageSortDir="desc";';
  h += 'function ft(n){if(!n&&n!==0)return"-";if(n>=1000000000)return(n/1000000000).toFixed(1)+"b";if(n>=1000000)return(n/1000000).toFixed(1)+"m";if(n>=1000)return(n/1000).toFixed(1)+"k";return String(n)}';
  h += 'function pf(v){if(!v&&v!==0)return 0;v=String(v).toLowerCase().trim();if(v.endsWith("b"))return Math.round(parseFloat(v)*1000000000);if(v.endsWith("m"))return Math.round(parseFloat(v)*1000000);if(v.endsWith("k"))return Math.round(parseFloat(v)*1000);return Math.round(parseFloat(v)||0)}';
  h += 'function findAcctByName(n){for(var i=0;i<accounts.length;i++){if(accounts[i].name===n)return accounts[i]}return null}';
  h += 'function findAcctForModel(m){for(var i=0;i<accounts.length;i++){var ms=accounts[i].models||[];for(var j=0;j<ms.length;j++){if(ms[j]===m)return accounts[i]}}return null}';
  h += 'function formatConsumed(name,value){var acct=findAcctByName(name);if(!acct){return ft(value)}var info=findAllowanceInfo(acct);if(info&&info.type==="shared"){return"¥"+scaleVal(value).toFixed(4)}if(info&&info.type==="total"){if(info.quota.display_currency)return"¥"+scaleVal(value).toFixed(4);if(info.quota.mode==="count")return value+"次";var t=Number(info.quota.initial_total||0);if(t>0)return(value/t*100).toFixed(2)+"%"}return ft(value)}';
  h += 'function parseConsumed(name,value){var s=String(value||"").trim();if(s.indexOf("¥")===0)return Math.round(parseFloat(s.substring(1))*1000000);if(s.indexOf("次")===s.length-1&&s.length>1)return parseInt(s)||0;if(s.indexOf("%")===s.length-1&&s.length>1){var acct=findAcctByName(name);if(acct){var info=findAllowanceInfo(acct);if(info&&info.type==="total"){var t=Number(info.quota.initial_total||0);if(t>0)return Math.round(parseFloat(s)/100*t)}}return parseFloat(s)||0}return pf(s)}';
  h += 'async function loadStats(){';
  h += 'try{var r=await adminFetch(base+"/admin/usage/stats");var d=await r.json();';
  h += 'if(d.success){statsData=d;renderDaily();renderCumulative();loadMonthlyStats()}}catch(e){}';
  h += '}';
  // ---- renderStats 已删除 ----
  // ---- 当天统计（可编辑） ----
  h += 'function renderDaily(){';
  h += 'if(!statsData||!statsData.daily)return;';
  h += 'var cu=statsData.daily;';
  h += 'var el=document.getElementById("dailyStats");';
  h += 'var h2="<div style=\\"margin-bottom:10px;font-size:13px;color:#666\\"><span>总调用: <b>"+cu.total_count+"</b> 成功: <b style=\\"color:#28a745\\">"+cu.success_count+"</b> 失败: <b style=\\"color:#dc3545\\">"+cu.fail_count+"</b></span></div>";';
  h += 'h2+="<div style=\\"margin-bottom:6px\\"><h3 style=\\"font-size:14px;color:#555;display:inline\\">按账号</h3> <button class=\\"btn btn-xs btn-outline\\" id=\\"btnAddDailyAcct\\" style=\\"margin-left:8px\\">+添加</button></div>";';
  h += 'h2+="<div class=\\"cum-table-wrap\\"><table id=\\"dailyAcctTbl\\"><thead><tr><th>账号</th><th>调用次数</th><th>输入tokens</th><th>输出tokens</th><th>缓存tokens</th><th>创建缓存tokens</th><th>用量</th><th></th></tr></thead><tbody>";';
  h += 'for(var i=0;i<cu.byAccount.length;i++){var a=cu.byAccount[i];';
  h += 'h2+="<tr><td><input class=\\"da-name\\" value=\\""+esc(a.name)+"\\" style=\\"width:100px\\"></td><td><input class=\\"da-count\\" type=\\"number\\" value=\\""+(a.count||0)+"\\" style=\\"width:60px\\"></td><td><input class=\\"da-input\\" value=\\""+ft(a.input)+"\\" style=\\"width:70px\\"></td><td><input class=\\"da-output\\" value=\\""+ft(a.output)+"\\" style=\\"width:70px\\"></td><td><input class=\\"da-cache\\" value=\\""+ft(a.cache)+"\\" style=\\"width:70px\\"></td><td><input class=\\"da-cache_create\\" value=\\""+ft(a.cache_create)+"\\" style=\\"width:70px\\"></td><td><input class=\\"da-consumed\\" value=\\""+formatConsumed(a.name,a.consumed)+"\\" style=\\"width:80px\\"></td><td><span class=\\"move-group\\">"+(i>0?"<button class=\\"btn-move\\" data-da-move=\\"up\\" title=\\"上移\\">▲</button>":"")+(i<cu.byAccount.length-1?"<button class=\\"btn-move\\" data-da-move=\\"down\\" title=\\"下移\\">▼</button>":"")+"</span> <button class=\\"btn btn-xs btn-danger da-del\\">删除</button></td></tr>"';
  h += '}h2+="</tbody></table></div>";';
  h += 'h2+="<div style=\\"margin-top:14px;margin-bottom:6px\\"><h3 style=\\"font-size:14px;color:#555;display:inline\\">按模型</h3> <button class=\\"btn btn-xs btn-outline\\" id=\\"btnAddDailyModel\\" style=\\"margin-left:8px\\">+添加</button></div>";';
  h += 'h2+="<div class=\\"cum-table-wrap\\"><table id=\\"dailyModelTbl\\"><thead><tr><th>模型</th><th>调用次数</th><th>输入tokens</th><th>输出tokens</th><th>缓存tokens</th><th>创建缓存tokens</th><th>缓存率</th><th></th></tr></thead><tbody>";';
  h += 'for(var i=0;i<cu.byModel.length;i++){var m=cu.byModel[i];var cr=(m.input||0)+(m.cache||0)>0?Math.round((m.cache||0)/((m.input||0)+(m.cache||0))*100):0;';
  h += 'h2+="<tr><td><input class=\\"dm-name\\" value=\\""+esc(m.name)+"\\" style=\\"width:130px\\"></td><td><input class=\\"dm-count\\" type=\\"number\\" value=\\""+(m.count||0)+"\\" style=\\"width:60px\\"></td><td><input class=\\"dm-input\\" value=\\""+ft(m.input)+"\\" style=\\"width:70px\\"></td><td><input class=\\"dm-output\\" value=\\""+ft(m.output)+"\\" style=\\"width:70px\\"></td><td><input class=\\"dm-cache\\" value=\\""+ft(m.cache)+"\\" style=\\"width:70px\\"></td><td><input class=\\"dm-cache_create\\" value=\\""+ft(m.cache_create)+"\\" style=\\"width:70px\\"></td><td><input class=\\"dm-cacherate\\" type=\\"number\\" min=\\"0\\" max=\\"100\\" value=\\""+cr+"\\" style=\\"width:60px\\"></td><td><span class=\\"move-group\\">"+(i>0?"<button class=\\"btn-move\\" data-dm-move=\\"up\\" title=\\"上移\\">▲</button>":"")+(i<cu.byModel.length-1?"<button class=\\"btn-move\\" data-dm-move=\\"down\\" title=\\"下移\\">▼</button>":"")+"</span> <button class=\\"btn btn-xs btn-danger dm-del\\">删除</button></td></tr>"';
  h += '}h2+="</tbody></table></div>";';
  h += 'el.innerHTML=h2;';
  h += 'document.getElementById("btnAddDailyAcct").addEventListener("click",function(){var tb=document.querySelector("#dailyAcctTbl tbody");var tr=document.createElement("tr");tr.innerHTML="<td><input class=\\"da-name\\" value=\\"\\" style=\\"width:100px\\"></td><td><input class=\\"da-count\\" type=\\"number\\" value=\\"0\\" style=\\"width:60px\\"></td><td><input class=\\"da-input\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"da-output\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"da-cache\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"da-cache_create\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"da-consumed\\" value=\\"0\\" style=\\"width:70px\\"></td><td><span class=\\"move-group\\"><button class=\\"btn-move\\" data-da-move=\\"up\\" title=\\"上移\\">▲</button><button class=\\"btn-move\\" data-da-move=\\"down\\" title=\\"下移\\">▼</button></span> <button class=\\"btn btn-xs btn-danger da-del\\">删除</button></td>";tb.appendChild(tr);tr.querySelector(".da-del").addEventListener("click",function(){tr.remove()});tr.querySelectorAll("[data-da-move]").forEach(function(mb){mb.addEventListener("click",function(){moveRow(mb,mb.getAttribute("data-da-move")==="up"?-1:1)})})});';
  h += 'document.getElementById("btnAddDailyModel").addEventListener("click",function(){var tb=document.querySelector("#dailyModelTbl tbody");var tr=document.createElement("tr");tr.innerHTML="<td><input class=\\"dm-name\\" value=\\"\\" style=\\"width:130px\\"></td><td><input class=\\"dm-count\\" type=\\"number\\" value=\\"0\\" style=\\"width:60px\\"></td><td><input class=\\"dm-input\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"dm-output\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"dm-cache\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"dm-cache_create\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"dm-cacherate\\" type=\\"number\\" min=\\"0\\" max=\\"100\\" value=\\"0\\" style=\\"width:60px\\"></td><td><span class=\\"move-group\\"><button class=\\"btn-move\\" data-dm-move=\\"up\\" title=\\"上移\\">▲</button><button class=\\"btn-move\\" data-dm-move=\\"down\\" title=\\"下移\\">▼</button></span> <button class=\\"btn btn-xs btn-danger dm-del\\">删除</button></td>";tb.appendChild(tr);tr.querySelector(".dm-del").addEventListener("click",function(){tr.remove()});tr.querySelectorAll("[data-dm-move]").forEach(function(mb){mb.addEventListener("click",function(){moveRow(mb,mb.getAttribute("data-dm-move")==="up"?-1:1)})})});';
  h += 'document.querySelectorAll(".da-del").forEach(function(b){b.addEventListener("click",function(){b.closest("tr").remove()})});';
  h += 'document.querySelectorAll(".dm-del").forEach(function(b){b.addEventListener("click",function(){b.closest("tr").remove()})});';
  h += 'document.querySelectorAll("[data-da-move]").forEach(function(b){b.addEventListener("click",function(){moveRow(b,b.getAttribute("data-da-move")==="up"?-1:1)})});';
  h += 'document.querySelectorAll("[data-dm-move]").forEach(function(b){b.addEventListener("click",function(){moveRow(b,b.getAttribute("data-dm-move")==="up"?-1:1)})});';
  h += '}';
  h += 'var _savingDaily=false;async function saveDaily(){if(_savingDaily)return;_savingDaily=true;var btn=document.getElementById("btnSaveDaily");btn.disabled=true;btn.textContent="保存中...";';
  h += 'try{var accts=collect("da");var models=collect("dm");var r=await adminFetch(base+"/admin/usage/stats/daily",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({accounts:accts.rows,models:models.rows,account_order:accts.order,model_order:models.order})});var d=await r.json();if(d.success){toast("保存成功","ok");loadStats()}else{toast("保存失败: "+(d.error||""),"err")}}catch(e){toast("保存失败: "+e.message,"err")}';
  h += 'btn.disabled=false;btn.textContent="保存";_savingDaily=false';
  h += '}';
  h += 'function collect(prefix){var rows={};var order=[];var isModel=prefix[1]==="m";var trs=document.querySelectorAll("[id$=Tbl] tbody tr");trs.forEach(function(tr){var eName=tr.querySelector("."+prefix+"-name");if(!eName)return;var name=eName.value.trim();if(!name)return;order.push(name);var o={count:Number(tr.querySelector("."+prefix+"-count").value)||0,input:pf(tr.querySelector("."+prefix+"-input").value),output:pf(tr.querySelector("."+prefix+"-output").value),cache:pf(tr.querySelector("."+prefix+"-cache").value),cache_create:pf(tr.querySelector("."+prefix+"-cache_create").value)};if(isModel){o.cache_rate=Number(tr.querySelector("."+prefix+"-cacherate").value)||0}else{o.consumed=parseConsumed(name,tr.querySelector("."+prefix+"-consumed").value)};rows[name]=o;});return {rows:rows,order:order}}';
  h += 'async function autoSave(tableEl){try{var tid=tableEl.id;var isDaily=tid.indexOf("daily")>=0;var accts,isModels;if(isDaily){accts=collect("da");isModels=collect("dm")}else{accts=collect("ca");isModels=collect("cm")}var ep=isDaily?"/admin/usage/stats/daily":"/admin/usage/stats";var r=await adminFetch(base+ep,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({accounts:accts.rows,models:isModels.rows,account_order:accts.order,model_order:isModels.order})});var d=await r.json();if(d.success){toast("排序已保存","ok")}else{toast("保存失败: "+(d.error||JSON.stringify(d)),"err");loadStats()}}catch(e){toast("保存失败: "+e.message,"err");loadStats()}}';
  h += 'function updateMoveButtons(table){var tbody=table.querySelector("tbody");if(!tbody)return;var rows=tbody.querySelectorAll("tr");if(rows.length<=1)return;var tid=table.id;var prefix="";if(tid.indexOf("dailyAcct")>=0)prefix="da";else if(tid.indexOf("dailyModel")>=0)prefix="dm";else if(tid.indexOf("cumAcct")>=0)prefix="ca";else if(tid.indexOf("cumModel")>=0)prefix="cm";else return;for(var i=0;i<rows.length;i++){var mg=rows[i].querySelector(".move-group");if(!mg)continue;var html="";if(i>0)html+="<button class=\\"btn-move\\" data-"+prefix+"-move=\\"up\\" title=\\"上移\\">▲</button>";if(i<rows.length-1)html+="<button class=\\"btn-move\\" data-"+prefix+"-move=\\"down\\" title=\\"下移\\">▼</button>";mg.innerHTML=html;var btns=mg.querySelectorAll(".btn-move");for(var j=0;j<btns.length;j++){(function(b){var attr="data-"+prefix+"-move";b.addEventListener("click",function(){moveRow(b,b.getAttribute(attr)==="up"?-1:1)})})(btns[j])}}}';
  h += 'function moveRow(btn,dir){var tr=btn.closest("tr");var tb=tr.parentNode;var rows=tb.children;var idx=-1;for(var i=0;i<rows.length;i++){if(rows[i]===tr){idx=i;break}}if(idx<0)return;var tgt=idx+dir;if(tgt<0||tgt>=rows.length)return;if(dir<0)tb.insertBefore(tr,rows[tgt]);else if(rows[tgt].nextSibling)tb.insertBefore(tr,rows[tgt].nextSibling);else tb.appendChild(tr);var table=tb.closest("table");if(table){updateMoveButtons(table);autoSave(table)}}';
  // ---- 累计统计（可编辑） ----
  h += 'function renderCumulative(){';
  h += 'if(!statsData||!statsData.cumulative)return;';
  h += 'var cu=statsData.cumulative;';
  h += 'var el=document.getElementById("cumulativeStats");';
  h += 'var h2="<div style=\\"margin-bottom:10px;font-size:13px;color:#666\\"><span>总调用: <b>"+cu.total_count+"</b> 成功: <b style=\\"color:#28a745\\">"+cu.success_count+"</b> 失败: <b style=\\"color:#dc3545\\">"+cu.fail_count+"</b></span></div>";';
  h += 'h2+="<div style=\\"margin-bottom:6px\\"><h3 style=\\"font-size:14px;color:#555;display:inline\\">按账号</h3> <button class=\\"btn btn-xs btn-outline\\" id=\\"btnAddAcct\\" style=\\"margin-left:8px\\">+添加</button></div>";';
  h += 'h2+="<div class=\\"cum-table-wrap\\"><table id=\\"cumAcctTbl\\"><thead><tr><th>账号</th><th>调用次数</th><th>输入tokens</th><th>输出tokens</th><th>缓存tokens</th><th>创建缓存tokens</th><th>用量</th><th></th></tr></thead><tbody>";';
  h += 'for(var i=0;i<cu.byAccount.length;i++){var a=cu.byAccount[i];';
  h += 'h2+="<tr><td><input class=\\"ca-name\\" value=\\""+esc(a.name)+"\\" style=\\"width:100px\\"></td><td><input class=\\"ca-count\\" type=\\"number\\" value=\\""+(a.count||0)+"\\" style=\\"width:60px\\"></td><td><input class=\\"ca-input\\" value=\\""+ft(a.input)+"\\" style=\\"width:70px\\"></td><td><input class=\\"ca-output\\" value=\\""+ft(a.output)+"\\" style=\\"width:70px\\"></td><td><input class=\\"ca-cache\\" value=\\""+ft(a.cache)+"\\" style=\\"width:70px\\"></td><td><input class=\\"ca-cache_create\\" value=\\""+ft(a.cache_create)+"\\" style=\\"width:70px\\"></td><td><input class=\\"ca-consumed\\" value=\\""+formatConsumed(a.name,a.consumed)+"\\" style=\\"width:80px\\"></td><td><span class=\\"move-group\\">"+(i>0?"<button class=\\"btn-move\\" data-ca-move=\\"up\\" title=\\"上移\\">▲</button>":"")+(i<cu.byAccount.length-1?"<button class=\\"btn-move\\" data-ca-move=\\"down\\" title=\\"下移\\">▼</button>":"")+"</span> <button class=\\"btn btn-xs btn-danger ca-del\\">删除</button></td></tr>"';
h += '}h2+="</tbody></table></div>";';
h += 'h2+="<div style=\\"margin-top:14px;margin-bottom:6px\\"><h3 style=\\"font-size:14px;color:#555;display:inline\\">按模型</h3> <button class=\\"btn btn-xs btn-outline\\" id=\\"btnAddModel\\" style=\\"margin-left:8px\\">+添加</button></div>";';
  h += 'h2+="<div class=\\"cum-table-wrap\\"><table id=\\"cumModelTbl\\"><thead><tr><th>模型</th><th>调用次数</th><th>输入tokens</th><th>输出tokens</th><th>缓存tokens</th><th>创建缓存tokens</th><th>缓存率</th><th></th></tr></thead><tbody>";';
  h += 'for(var i=0;i<cu.byModel.length;i++){var m=cu.byModel[i];var cr=(m.input||0)+(m.cache||0)>0?Math.round((m.cache||0)/((m.input||0)+(m.cache||0))*100):0;';
  h += 'h2+="<tr><td><input class=\\"cm-name\\" value=\\""+esc(m.name)+"\\" style=\\"width:130px\\"></td><td><input class=\\"cm-count\\" type=\\"number\\" value=\\""+(m.count||0)+"\\" style=\\"width:60px\\"></td><td><input class=\\"cm-input\\" value=\\""+ft(m.input)+"\\" style=\\"width:70px\\"></td><td><input class=\\"cm-output\\" value=\\""+ft(m.output)+"\\" style=\\"width:70px\\"></td><td><input class=\\"cm-cache\\" value=\\""+ft(m.cache)+"\\" style=\\"width:70px\\"></td><td><input class=\\"cm-cache_create\\" value=\\""+ft(m.cache_create)+"\\" style=\\"width:70px\\"></td><td><input class=\\"cm-cacherate\\" type=\\"number\\" min=\\"0\\" max=\\"100\\" value=\\""+cr+"\\" style=\\"width:60px\\"></td><td><span class=\\"move-group\\">"+(i>0?"<button class=\\"btn-move\\" data-cm-move=\\"up\\" title=\\"上移\\">▲</button>":"")+(i<cu.byModel.length-1?"<button class=\\"btn-move\\" data-cm-move=\\"down\\" title=\\"下移\\">▼</button>":"")+"</span> <button class=\\"btn btn-xs btn-danger cm-del\\">删除</button></td></tr>"';
h += '}h2+="</tbody></table></div>";';
h += 'el.innerHTML=h2;';
  h += 'document.getElementById("btnAddAcct").addEventListener("click",function(){var tb=document.querySelector("#cumAcctTbl tbody");var tr=document.createElement("tr");tr.innerHTML="<td><input class=\\"ca-name\\" value=\\"\\" style=\\"width:100px\\"></td><td><input class=\\"ca-count\\" type=\\"number\\" value=\\"0\\" style=\\"width:60px\\"></td><td><input class=\\"ca-input\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"ca-output\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"ca-cache\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"ca-cache_create\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"ca-consumed\\" value=\\"0\\" style=\\"width:70px\\"></td><td><span class=\\"move-group\\"><button class=\\"btn-move\\" data-ca-move=\\"up\\" title=\\"上移\\">▲</button><button class=\\"btn-move\\" data-ca-move=\\"down\\" title=\\"下移\\">▼</button></span> <button class=\\"btn btn-xs btn-danger ca-del\\">删除</button></td>";tb.appendChild(tr);tr.querySelector(".ca-del").addEventListener("click",function(){tr.remove()});tr.querySelectorAll("[data-ca-move]").forEach(function(mb){mb.addEventListener("click",function(){moveRow(mb,mb.getAttribute("data-ca-move")==="up"?-1:1)})})});';
  h += 'document.getElementById("btnAddModel").addEventListener("click",function(){var tb=document.querySelector("#cumModelTbl tbody");var tr=document.createElement("tr");tr.innerHTML="<td><input class=\\"cm-name\\" value=\\"\\" style=\\"width:130px\\"></td><td><input class=\\"cm-count\\" type=\\"number\\" value=\\"0\\" style=\\"width:60px\\"></td><td><input class=\\"cm-input\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"cm-output\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"cm-cache\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"cm-cache_create\\" value=\\"0\\" style=\\"width:70px\\"></td><td><input class=\\"cm-cacherate\\" type=\\"number\\" min=\\"0\\" max=\\"100\\" value=\\"0\\" style=\\"width:60px\\"></td><td><span class=\\"move-group\\"><button class=\\"btn-move\\" data-cm-move=\\"up\\" title=\\"上移\\">▲</button><button class=\\"btn-move\\" data-cm-move=\\"down\\" title=\\"下移\\">▼</button></span> <button class=\\"btn btn-xs btn-danger cm-del\\">删除</button></td>";tb.appendChild(tr);tr.querySelector(".cm-del").addEventListener("click",function(){tr.remove()});tr.querySelectorAll("[data-cm-move]").forEach(function(mb){mb.addEventListener("click",function(){moveRow(mb,mb.getAttribute("data-cm-move")==="up"?-1:1)})})});';
  h += 'document.querySelectorAll(".ca-del").forEach(function(b){b.addEventListener("click",function(){b.closest("tr").remove()})});';
  h += 'document.querySelectorAll(".cm-del").forEach(function(b){b.addEventListener("click",function(){b.closest("tr").remove()})});';
  h += 'document.querySelectorAll("[data-ca-move]").forEach(function(b){b.addEventListener("click",function(){moveRow(b,b.getAttribute("data-ca-move")==="up"?-1:1)})});';
  h += 'document.querySelectorAll("[data-cm-move]").forEach(function(b){b.addEventListener("click",function(){moveRow(b,b.getAttribute("data-cm-move")==="up"?-1:1)})});';
  h += '}';
  // ---- 月度统计 ----
  h += 'async function loadMonthlyStats(){';
  h += 'try{var r=await adminFetch(base+"/admin/usage/stats/monthly");var d=await r.json();';
  h += 'if(d.success)renderMonthly(d.monthly||{})}catch(e){}';
  h += '}';
  h += 'function renderMonthly(monthly){';
  h += 'var el=document.getElementById("monthlyStats");';
  h += 'if(!el)return;';
  h += 'var months=Object.keys(monthly).sort().reverse();';
  h += 'if(!months.length){el.innerHTML="<div class=\\"empty\\"><p>暂无月度数据</p></div>";return}';
  h += 'var current=months[0];var cur=monthly[current];';
  // 当月每天请求次数柱状图
  h += 'var days=Object.keys(cur.daily||{}).sort();';
  h += 'var maxDay=0;for(var i=0;i<days.length;i++){var c=cur.daily[days[i]]||0;if(c>maxDay)maxDay=c}';
  h += 'var h2="<div style=\\"margin-bottom:16px\\">";';
  h += 'h2+="<h3 style=\\"font-size:14px;color:#555;margin-bottom:10px\\">"+current+" 每日请求次数</h3>";';
  h += 'h2+="<div style=\\"display:flex;align-items:flex-end;gap:3px;height:120px;padding:0 4px\\">";';
  h += 'for(var d=1;d<=31;d++){var dd=String(d).padStart(2,"0");var cnt=cur.daily[dd]||0;';
  h += 'var pct=maxDay>0?Math.round(cnt/maxDay*100):0;';
  h += 'var color=cnt>0?"#667eea":"#e8ecf1";';
  h += 'h2+="<div style=\\"flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%\\">";';
  h += 'h2+="<div style=\\"font-size:10px;color:#888;margin-bottom:2px\\">"+(cnt>0?cnt:"")+"</div>";';
  h += 'h2+="<div style=\\"width:100%;height:"+Math.max(2,pct)+"%;background:"+color+";border-radius:2px 2px 0 0;min-height:2px\\"></div>";';
  h += 'h2+="<div style=\\"font-size:9px;color:#aaa;margin-top:2px\\">"+dd+"</div></div>"';
  h += '}h2+="</div></div>";';
  // 汇总数据
  h += '  var now2=new Date();var curMonth=current;var todayStr=now2.getFullYear()+"-"+String(now2.getMonth()+1).padStart(2,"0");var totalDays;if(curMonth===todayStr){totalDays=now2.getDate()}else{totalDays=new Date(parseInt(curMonth.substring(0,4)),parseInt(curMonth.substring(5,7)),0).getDate()}var avgDaily=totalDays>0?Math.round(cur.total/totalDays*10)/10:0;';
  h += 'h2+="<div style=\\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px\\">";';
  h += 'h2+="<div style=\\"background:#f8f9ff;padding:12px;border-radius:8px;text-align:center\\"><div style=\\"font-size:20px;font-weight:700;color:#667eea\\">"+cur.total+"</div><div style=\\"font-size:12px;color:#888\\">当月总请求</div></div>";';
  h += 'h2+="<div style=\\"background:#f8f9ff;padding:12px;border-radius:8px;text-align:center\\"><div style=\\"font-size:20px;font-weight:700;color:#667eea\\">"+avgDaily+"</div><div style=\\"font-size:12px;color:#888\\">月均每天请求</div></div>";';
  h += 'h2+="<div style=\\"background:#f8f9ff;padding:12px;border-radius:8px;text-align:center\\"><div style=\\"font-size:20px;font-weight:700;color:#28a745\\">"+cur.success+"</div><div style=\\"font-size:12px;color:#888\\">当月成功</div></div>";';
  h += 'h2+="</div>";';
  // 各月总请求次数
  h += 'h2+="<h3 style=\\"font-size:14px;color:#555;margin-bottom:8px\\">各月总请求次数</h3>";';
  h += 'h2+="<table><thead><tr><th>月份</th><th>总请求</th><th>成功</th><th>失败</th></tr></thead><tbody>";';
  h += 'for(var i=0;i<months.length;i++){var m=months[i];var md=monthly[m];';
  h += 'h2+="<tr><td>"+m+"</td><td><b>"+md.total+"</b></td><td style=\\"color:#28a745\\">"+md.success+"</td><td style=\\"color:#dc3545\\">"+md.fail+"</td></tr>"';
  h += '}h2+="</tbody></table>";';
  h += 'el.innerHTML=h2;';
  h += '}';
  h += 'var _savingCumulative=false;async function saveCumulative(){if(_savingCumulative)return;_savingCumulative=true;var btn=document.getElementById("btnSaveCumulative");btn.disabled=true;btn.textContent="保存中...";';
  h += 'try{var accts=collect("ca");var models=collect("cm");var r=await adminFetch(base+"/admin/usage/stats",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({accounts:accts.rows,models:models.rows,account_order:accts.order,model_order:models.order})});var d=await r.json();if(d.success){toast("保存成功","ok");loadStats()}else{toast("保存失败: "+(d.error||""),"err")}}catch(e){toast("保存失败: "+e.message,"err")}';
  h += 'btn.disabled=false;btn.textContent="保存";_savingCumulative=false';
  h += '}';

  // 事件绑定（全用 addEventListener，无 inline onclick）
  h += 'document.getElementById("btnAddAccount").addEventListener("click",openAddAccount);';
  h += 'document.getElementById("btnSave").addEventListener("click",saveAccount);';
  h += 'document.getElementById("btnCancel").addEventListener("click",closeModal);';
  h += 'document.getElementById("btnToggleKey").addEventListener("click",toggleKey);';
  h += 'document.getElementById("f_poolMode").addEventListener("change",toggleAllowanceSections);';
  h += 'document.getElementById("btnPickModels").addEventListener("click",showModelPicker);';
  h += 'document.getElementById("f_quotaMode").addEventListener("change",updateQuotaRates);';
  h += 'document.getElementById("modal").addEventListener("click",function(e){if(e.target===this)closeModal()});';
  h += 'document.addEventListener("keydown",function(e){if(e.key==="Escape"){if(document.getElementById("modal").classList.contains("show")){closeModal()}else if(document.getElementById("modalTest").classList.contains("show")){document.getElementById("modalTest").classList.remove("show")}}});';

  // \u5BFC\u822A\u680F\u5207\u6362
  h += 'function switchNav(item){';
  h += 'document.querySelectorAll(".sidebar-item").forEach(function(n){n.classList.remove("active");n.setAttribute("aria-selected","false");n.tabIndex=-1});';
  h += 'document.querySelectorAll(".page").forEach(function(p){p.classList.remove("active")});';
  h += 'item.classList.add("active");';
  h += 'item.setAttribute("aria-selected","true");item.tabIndex=0;';
  h += 'var page=item.getAttribute("data-page");';
  h += 'document.getElementById(page).classList.add("active");';
  h += 'var title=item.getAttribute("data-title")||"";';
  h += 'document.getElementById("topbarTitle").textContent=title;';
  h += 'var hash=item.getAttribute("data-hash")||"";';
  h += 'if(hash&&window.location.hash!=="#"+hash){history.pushState(null,"","#"+hash)}';
  // Close mobile sidebar
  h += 'document.getElementById("sidebar").classList.remove("open");';
  h += 'document.getElementById("sidebarOverlay").classList.remove("show");';
  h += 'if(page==="page-accounts"){startConcurrencyPolling();loadAccountsList()}';
  h += 'else{stopConcurrencyPolling()}';
  h += 'if(page==="page-usage"){loadStats();loadUsageLogs()}';
  h += 'if(page==="page-cumulative"){loadStats()}';
  h += '}';
  h += 'function switchNavByHash(){';
  h += 'var hash=window.location.hash.replace("#","");';
  h += 'var target=document.querySelector(".sidebar-item[data-hash=\\""+hash+"\\"]");';
  h += 'if(target)switchNav(target);';
  h += '}';
  h += 'window.addEventListener("hashchange",switchNavByHash);';
  h += 'document.querySelectorAll(".sidebar-item").forEach(function(item){';
  h += 'item.addEventListener("click",function(){switchNav(item)});';
  h += 'item.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();switchNav(item)}});';
  h += '});';
  h += 'if(window.location.hash)switchNavByHash();';

  // Mobile hamburger menu
  h += '(function(){';
  h += 'var btn=document.getElementById("btnHamburger");';
  h += 'var sidebar=document.getElementById("sidebar");';
  h += 'var overlay=document.getElementById("sidebarOverlay");';
  h += 'function openMenu(){sidebar.classList.add("open");overlay.classList.add("show")}';
  h += 'function closeMenu(){sidebar.classList.remove("open");overlay.classList.remove("show")}';
  h += 'btn.addEventListener("click",function(){if(sidebar.classList.contains("open")){closeMenu()}else{openMenu()}});';
  h += 'overlay.addEventListener("click",closeMenu);';
  h += '})();';

  // 使用记录事件
  h += 'document.getElementById("btnRefreshUsage").addEventListener("click",loadUsageLogs);';
  h += 'document.getElementById("btnClearUsage").addEventListener("click",clearUsageLogs);';

  // 测试弹窗事件
  h += 'document.getElementById("btnCloseTest").addEventListener("click",function(){document.getElementById("modalTest").classList.remove("show")});';
  h += 'document.getElementById("modalTest").addEventListener("click",function(e){if(e.target===this)this.classList.remove("show")});';

  // 统计事件

  h += 'document.getElementById("btnRefreshDaily").addEventListener("click",loadStats);';
  h += 'document.getElementById("btnSaveDaily").addEventListener("click",saveDaily);';
h += 'document.getElementById("btnRefreshMonthly").addEventListener("click",loadMonthlyStats);';
h += 'document.getElementById("btnRefreshCumulative").addEventListener("click",loadStats);';
h += 'document.getElementById("btnSaveCumulative").addEventListener("click",saveCumulative);';

  // 启动（默认页：账号管理）
  // ---- 头像功能 ----
  h += 'function loadAvatar(){var saved=localStorage.getItem("apis_avatar");var sidebarEl=document.getElementById("sidebarAvatar");var topbarEl=document.getElementById("topbarAvatar");var html=saved?\'<img src="\'+saved+\'" alt="avatar">\':\'<span class="avatar-placeholder">A</span>\';if(sidebarEl)sidebarEl.innerHTML=html;if(topbarEl)topbarEl.innerHTML=html}';
  h += 'function setupAvatar(){var el=document.getElementById("sidebarAvatar");if(!el)return;el.addEventListener("click",function(){var input=document.createElement("input");input.type="file";input.accept="image/*";input.onchange=function(e){var file=e.target.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(ev){var img=new Image();img.onload=function(){var canvas=document.createElement("canvas");var size=Math.min(img.width,img.height);canvas.width=80;canvas.height=80;var ctx=canvas.getContext("2d");var sx=(img.width-size)/2;var sy=(img.height-size)/2;ctx.drawImage(img,sx,sy,size,size,0,0,80,80);var dataUrl=canvas.toDataURL("image/png");localStorage.setItem("apis_avatar",dataUrl);loadAvatar()};img.src=ev.target.result};reader.readAsDataURL(file)};input.click()})}';
  h += 'loadAvatar();setupAvatar();';
  
  // 初始化
  h += 'loadAccountsList();startConcurrencyPolling();loadStats();';
  h += '</script></body></html>';

  return new Response(h, { headers: respHeaders });
}

// ===================== 管理 API =====================
async function handleAdminAPI(request, path, method, corsHeaders) {
  // 本地运行，跳过认证

  // ================== 上游账号管理 ==================

  // GET /admin/accounts
  if (path === '/admin/accounts' && method === 'GET') {
    const accounts = await loadAccounts();
    const allowance_config = await loadAllowanceConfig();
    const allowance_status = await getAllowanceStatus(collectAllowanceTargets(accounts, allowance_config));
    return new Response(JSON.stringify({ success: true, accounts, allowance_config, allowance_status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' },
    });
  }

  // POST /admin/accounts — 新增/更新上游账号
  if (path === '/admin/accounts' && method === 'POST') {
    const body = await request.json();
    let accounts = await loadAccounts();
    const now = new Date().toISOString();

    let savedAccountId = body.id || '';
    if (body.id) {
      const idx = accounts.findIndex(a => a.id === body.id);
      if (idx === -1) {
        savedAccountId = body.id;
        accounts.push({
          id: savedAccountId,
          name: body.name,
          base_url: body.base_url,
          api_key: body.api_key,
          format: body.format || 'openai',
          models: body.models || [],
          model_map: normalizeModelMap(body.model_map),
          priority: normalizePriority(body),
          weight: normalizeWeight(body),
          max_concurrency: normalizeMaxConcurrency(body),
          enabled: body.enabled !== false,
          note: body.note || '',
          pool_mode: body.pool_mode === true,
          pool_mode_retry_count: normalizePoolRetryCount(body),
          pool_retry_statuses: normalizePoolRetryStatuses(body),
          created_at: now,
          updated_at: now,
        });
      } else if (body.name != null) {
        // 只更新 body 中明确传入的字段，防止 undefined 覆盖已有值
        accounts[idx] = { ...accounts[idx] };
        if (body.name !== undefined) accounts[idx].name = body.name;
        if (body.base_url !== undefined) accounts[idx].base_url = body.base_url;
        if (body.api_key !== undefined) accounts[idx].api_key = body.api_key;
        if (body.format !== undefined) accounts[idx].format = body.format;
        if (body.models !== undefined) accounts[idx].models = body.models;
        if (body.model_map !== undefined) accounts[idx].model_map = normalizeModelMap(body.model_map);
        if (body.priority !== undefined) accounts[idx].priority = normalizePriority(body);
        if (body.weight !== undefined) accounts[idx].weight = normalizeWeight(body);
        if (body.max_concurrency !== undefined) accounts[idx].max_concurrency = normalizeMaxConcurrency(body);
        if (body.enabled !== undefined) accounts[idx].enabled = body.enabled !== false;
        if (body.note !== undefined) accounts[idx].note = body.note || '';
        if (body.pool_mode !== undefined) accounts[idx].pool_mode = body.pool_mode === true;
        if (body.pool_mode_retry_count !== undefined) accounts[idx].pool_mode_retry_count = normalizePoolRetryCount(body);
        if (body.pool_retry_statuses !== undefined) accounts[idx].pool_retry_statuses = normalizePoolRetryStatuses(body);
        accounts[idx].updated_at = now;
      } else {
        // 纯余量更新（无 name 等字段），只标记更新时间
        accounts[idx].updated_at = now;
      }
    } else {
      savedAccountId = genId();
      accounts.push({
        id: savedAccountId,
        name: body.name,
        base_url: body.base_url,
        api_key: body.api_key,
        format: body.format || 'openai',
        models: body.models || [],
        model_map: normalizeModelMap(body.model_map),
        priority: normalizePriority(body),
        weight: normalizeWeight(body),
        max_concurrency: normalizeMaxConcurrency(body),
        enabled: body.enabled !== false,
        note: body.note || '',
        pool_mode: body.pool_mode === true,
        pool_mode_retry_count: normalizePoolRetryCount(body),
        pool_retry_statuses: normalizePoolRetryStatuses(body),
        created_at: now,
        updated_at: now,
      });
    }

    if (body.allowance) {
      try { await updateAllowanceConfigForAccount(savedAccountId, body.allowance, accounts); }
      catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message || '余量配置保存失败' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }
    await saveAccounts(accounts);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // DELETE /admin/accounts
  if (path === '/admin/accounts' && method === 'DELETE') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ success: false, error: 'id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    let accounts = await loadAccounts();
    accounts = accounts.filter(a => a.id !== id);
    await saveAccounts(accounts);
    const config = await loadAllowanceConfig();
    config.shared_groups = (config.shared_groups || []).map(g => ({ ...g, account_ids: (g.account_ids || []).filter(x => x !== id) }))
      .filter(g => (g.account_ids || []).length > 0);
    if (config.account_quotas) delete config.account_quotas[id];
    await saveAllowanceConfig(config);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // POST /admin/accounts/test — 测试上游连通性（所有模型+映射）
  if (path === '/admin/accounts/test' && method === 'POST') {
    const body = await request.json();
    const { id, testIndices } = body;
    if (!id) {
      return new Response(JSON.stringify({ success: false, error: 'id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    const accounts = await loadAccounts();
    const acct = accounts.find(a => a.id === id);
    if (!acct) {
      return new Response(JSON.stringify({ success: false, error: 'Account not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    const allowanceConfig = await loadAllowanceConfig();
    const allowanceStatus = await getAllowanceStatus(collectAllowanceTargets(accounts, allowanceConfig));
    const allowanceInfo = resolveAllowanceForAccount(acct, allowanceConfig);

    const isAnthropic = acct.format === 'anthropic';
    const testEndpoint = isAnthropic ? '/v1/messages' : '/v1/chat/completions';
    const baseUrl = String(acct.base_url).replace(/\/+$/, '');
    const testUrl = buildTargetUrl(baseUrl, testEndpoint);
    const headers = isAnthropic ? {
      'Content-Type': 'application/json',
      'x-api-key': acct.api_key,
      'anthropic-version': '2023-06-01',
    } : {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + acct.api_key,
    };

    // 收集所有要测的模型
    const allModels = [];
    // models 列表中的每个模型
    for (const m of (acct.models || [])) {
      allModels.push({ label: m + '（原始）', model: m });
    }
    // model_map 中的映射目标
    if (acct.model_map) {
      for (const [client, upstream] of Object.entries(acct.model_map)) {
        allModels.push({ label: client + ' → ' + upstream, model: upstream });
      }
    }

    // 如果传了 testIndices，只测选中的项
    const testModels = Array.isArray(testIndices) && testIndices.length > 0
      ? testIndices.filter(i => i >= 0 && i < allModels.length).map(i => allModels[i])
      : allModels;

    const results = [];
    const poolMode = isPoolMode(acct);
    const maxRetries = poolMode ? normalizePoolRetryCount(acct) : 0;
    const retryStatuses = poolMode ? normalizePoolRetryStatuses(acct) : [];

    for (const { label, model } of testModels) {
      const start = Date.now();
      let lastErr = '';
      let lastStatus = 0;
      let ok = false;
      let attempt = 0;
      // 重试循环：超时/网络异常 + 可重试状态码都重试
      while (true) {
        const t0 = Date.now();
        try {
          const testBody = isAnthropic
            ? { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }
            : { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
          const resp = await poolFetch(testUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(testBody),
            timeout: 15000,
          });
          const text = await resp.text();
          if (resp.ok) {
            try {
              let jsonText = text;
              // 兼容上游强制返回 SSE 流式格式的情况（data: {...}）
              if (text.trimStart().startsWith('data:')) {
                const lines = text.split('\n');
                const dataLines = lines.filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
                if (dataLines.length > 0) {
                  jsonText = dataLines[dataLines.length - 1].replace(/^data:\s*/, '');
                }
              }
              const j = JSON.parse(jsonText);
              if (isAnthropic) {
                ok = !!(j.content && j.content.length > 0);
                if (!ok) lastErr = '响应无 content 字段';
              } else {
                ok = !!j.choices;
                if (!ok) lastErr = '响应无 choices 字段';
              }
            } catch { lastErr = '响应非 JSON: ' + text.slice(0, 100); }
            lastStatus = resp.status;
            break; // 成功或不可重试的响应，跳出重试
          }
          // HTTP 错误
          lastStatus = resp.status;
          if (resp.status >= 500) {
            // 5xx：池模式重试
            if (poolMode && attempt < maxRetries) { attempt++; await sleep(300 + Math.random() * 200); continue; }
            try { const j = JSON.parse(text); lastErr = j.error?.message || j.error || resp.statusText; } catch { lastErr = resp.statusText || 'HTTP ' + resp.status; }
            break;
          }
          if (resp.status >= 400) {
            // 池模式 + 可重试状态码 + 还有次数
            if (poolMode && retryStatuses.indexOf(resp.status) !== -1 && attempt < maxRetries) { attempt++; await sleep(300 + Math.random() * 200); continue; }
            // 池模式 + 可重试但次数耗尽
            if (poolMode && retryStatuses.indexOf(resp.status) !== -1) { lastErr = '重试耗尽，最后状态 ' + resp.status; break; }
            // 不可重试 4xx
            try { const j = JSON.parse(text); lastErr = j.error?.message || j.error || resp.statusText; } catch { lastErr = resp.statusText || 'HTTP ' + resp.status; }
            break;
          }
          break;
        } catch (err) {
          // 超时/网络异常
          if (poolMode && attempt < maxRetries) { attempt++; await sleep(300 + Math.random() * 200); continue; }
          lastErr = err.message;
          break;
        }
      }
      const latencyMs = Date.now() - start;
      // 记录测试使用
      const testUsage = ok ? { inputTokens: 10, outputTokens: 10, totalTokens: 20, cacheTokens: 0, cacheCreateTokens: 0 } : { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheTokens: 0, cacheCreateTokens: 0 };
      recordUsageAndDebit(allowanceInfo, acct, model, model, testUsage, {}, latencyMs, lastStatus, false, ok ? '' : lastErr, request, '', '').catch(() => {});
      results.push({
        label,
        model,
        ok,
        status: lastStatus,
        latency_ms: latencyMs,
        error: ok ? '' : lastErr,
        retries: attempt,
      });
    }

    return new Response(JSON.stringify({ success: true, name: acct.name, results }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // POST /admin/accounts/fetch-models — 从上游获取模型列表
  if (path === '/admin/accounts/fetch-models' && method === 'POST') {
    const body = await request.json();
    const baseUrl = String(body.base_url || '').replace(/\/+$/, '');
    const apiKey = String(body.api_key || '').trim();
    if (!baseUrl || !apiKey) {
      return new Response(JSON.stringify({ success: false, error: 'base_url and api_key required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    try {
      const modelsUrl = baseUrl.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '') + '/models';
      const resp = await poolFetch(modelsUrl, {
        headers: { 'Authorization': 'Bearer ' + apiKey },
        timeout: 10000,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return new Response(JSON.stringify({ success: false, error: '上游返回 ' + resp.status + ': ' + text.slice(0, 200) }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const data = await resp.json();
      const models = (data.data || data.models || [])
        .map(m => String(m.id || m.model || m).trim())
        .filter(Boolean);
      return new Response(JSON.stringify({ success: true, models }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message || '请求上游失败' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  }

  // POST /admin/accounts/reorder — 调整上游账号顺序
  if (path === '/admin/accounts/reorder' && method === 'POST') {
    const body = await request.json();
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.length) {
      return new Response(JSON.stringify({ success: false, error: 'ids array required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    let accounts = await loadAccounts();
    const reordered = [];
    for (const id of ids) {
      const acct = accounts.find(a => a.id === id);
      if (acct) reordered.push(acct);
    }
    // 补上 ids 里没提到的账号（容错）
    for (const acct of accounts) {
      if (!ids.includes(acct.id)) reordered.push(acct);
    }
    await saveAccounts(reordered);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // ================== 并发 & 全局配置 ==================

  // GET /admin/concurrency — 实时并发状态
  if (path === '/admin/concurrency' && method === 'GET') {
    const accounts = await loadAccounts();
    const state = await concurrencyDO.handleState();
    const counts = state.counts || {};
    const accountStats = accounts.map(a => ({
      id: a.id,
      name: a.name,
      current: counts[a.id] || 0,
      max: a.max_concurrency || 0,
    }));
    return new Response(JSON.stringify({
      success: true,
      accounts: accountStats,
    }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // ================== 使用记录管理 ==================

  // GET /admin/usage/flush — 强制 flush 所有 buffer 到 KV
  if (path === '/admin/usage/flush' && method === 'GET') {
    // flush UsageBufferDO (内存实现)
    usageBufferDO.handleFlush();
    // flush 统计 buffer
    await flushStatsBuffer();
    await flushDailyStatsBuffer();
    await flushMonthlyStatsBuffer();
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // GET /admin/usage — 分页
  if (path === '/admin/usage' && method === 'GET') {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    const accountId = url.searchParams.get('account_id') || '';
    let logs = [];
    try {
      logs = kvGetJSON(KV_KEY_USAGE_LOGS) || [];
    } catch {}
    if (!Array.isArray(logs)) logs = [];

    let filtered = logs;
    if (accountId) {
      filtered = logs.filter(l => l.account_id === accountId);
    }

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    const stats = {
      total_count: total,
      success_count: filtered.filter(l => l.status >= 200 && l.status < 400).length,
      error_count: filtered.filter(l => !l.status || l.status >= 400 || l.error).length,
    };

    return new Response(JSON.stringify({ success: true, logs: page, stats, total }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // GET /admin/usage/stats — 最近1000条 + 累计统计
  if (path === '/admin/usage/stats' && method === 'GET') {
    await flushStatsBuffer();
    await flushDailyStatsBuffer();
    await flushMonthlyStatsBuffer();
    let logs = [];
    try { logs = kvGetJSON(KV_KEY_USAGE_LOGS) || []; } catch {}
    if (!Array.isArray(logs)) logs = [];
    function agg(items) {
      const ba = {}, bm = {}; let t = 0, su = 0, f = 0;
      for (const l of items) {
        t++; if (l.status >= 200 && l.status < 400) su++; else f++;
        const an = l.account_name || l.channel_name || '未知', md = l.requested_model || l.model || '未知';
        const ip = Number(l.input_tokens || 0), op = Number(l.output_tokens || 0), ca = Number(l.cache_tokens || 0), cc = Number(l.cache_create_tokens || 0);
        if (!ba[an]) ba[an] = { count: 0, input: 0, output: 0, cache: 0, cache_create: 0 };
        ba[an].count++; ba[an].input += ip; ba[an].output += op; ba[an].cache += ca; ba[an].cache_create += cc;
        if (!bm[md]) bm[md] = { count: 0, input: 0, output: 0, cache: 0, cache_create: 0 };
        bm[md].count++; bm[md].input += ip; bm[md].output += op; bm[md].cache += ca; bm[md].cache_create += cc;
      }
      return { total: t, success: su, fail: f,
        byAccount: Object.entries(ba).map(([n, d]) => ({ name: n, ...d })).sort((a, b) => b.count - a.count),
        byModel: Object.entries(bm).map(([n, d]) => ({ name: n, ...d })).sort((a, b) => b.count - a.count) };
    }
    // 累计统计
    let stats = {};
    try { stats = kvGetJSON(KV_KEY_USAGE_STATS) || {}; } catch {}
    if (!stats.accounts) stats.accounts = {};
    if (!stats.models) stats.models = {};
    const acctOrder = stats.account_order || [];
    const modelOrder = stats.model_order || [];
    const orderByCount = function(arr, order) {
      arr.sort(function(a, b) {
        var ia = order.indexOf(a.name), ib = order.indexOf(b.name);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return b.count - a.count;
      });
    };
    const caArr = Object.entries(stats.accounts).map(([n, d]) => ({ name: n, ...d }));
    orderByCount(caArr, acctOrder);
    const cmArr = Object.entries(stats.models).map(([n, d]) => ({ name: n, ...d }));
    orderByCount(cmArr, modelOrder);
    // 当天统计
    let daily = {};
    try { daily = kvGetJSON(KV_KEY_USAGE_DAILY_STATS) || {}; } catch {}
    const today = getBeijingDate();
    let dailyResult;
    if (daily.date !== today) {
      dailyResult = { total_count: 0, success_count: 0, fail_count: 0, byAccount: [], byModel: [] };
    } else {
      if (!daily.accounts) daily.accounts = {};
      if (!daily.models) daily.models = {};
      const dAcctOrder = daily.account_order || [];
      const dModelOrder = daily.model_order || [];
      const dcaArr = Object.entries(daily.accounts).map(([n, d]) => ({ name: n, ...d }));
      dcaArr.sort(function(a, b) { var ia = dAcctOrder.indexOf(a.name), ib = dAcctOrder.indexOf(b.name); if (ia >= 0 && ib >= 0) return ia - ib; if (ia >= 0) return -1; if (ib >= 0) return 1; return b.count - a.count; });
      const dcmArr = Object.entries(daily.models).map(([n, d]) => ({ name: n, ...d }));
      dcmArr.sort(function(a, b) { var ia = dModelOrder.indexOf(a.name), ib = dModelOrder.indexOf(b.name); if (ia >= 0 && ib >= 0) return ia - ib; if (ia >= 0) return -1; if (ib >= 0) return 1; return b.count - a.count; });
      dailyResult = { total_count: daily.total || 0, success_count: daily.success || 0, fail_count: daily.fail || 0, byAccount: dcaArr, byModel: dcmArr };
    }
    return new Response(JSON.stringify({
      success: true,
      last1000: agg(logs),
      daily: dailyResult,
      cumulative: { total_count: stats.total || 0, success_count: stats.success || 0, fail_count: stats.fail || 0, byAccount: caArr, byModel: cmArr },
    }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // PUT /admin/usage/stats — 保存累计统计（编辑后提交）
  if (path === '/admin/usage/stats' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== 'object') return new Response(JSON.stringify({ success: false, error: 'invalid body' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    // 只保存 accounts 和 models
    const out = { accounts: body.accounts || {}, models: body.models || {}, account_order: body.account_order || [], model_order: body.model_order || [] };
    let total = 0;
    for (const d of Object.values(out.accounts)) { total += d.count || 0; }
    // 保留 success/fail：优先用 body 传入，其次用已有 KV 值，最终兜底 total/0
    let existingSuccess, existingFail;
    try { const existing = kvGetJSON(KV_KEY_USAGE_STATS) || {}; existingSuccess = existing.success; existingFail = existing.fail; } catch {}
    out.success = body.success !== undefined ? body.success : (existingSuccess !== undefined ? existingSuccess : total);
    out.fail = body.fail !== undefined ? body.fail : (existingFail !== undefined ? existingFail : 0);
    out.total = total;
    kvPutJSON(KV_KEY_USAGE_STATS, out);
    statsAccumulator = { accounts: {}, models: {}, total: 0, success: 0, fail: 0 };
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // PUT /admin/usage/stats/daily — 保存当天统计（编辑后提交）
  if (path === '/admin/usage/stats/daily' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== 'object') return new Response(JSON.stringify({ success: false, error: 'invalid body' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    const today = getBeijingDate();
    const out = { date: today, accounts: body.accounts || {}, models: body.models || {}, account_order: body.account_order || [], model_order: body.model_order || [] };
    let total = 0;
    for (const d of Object.values(out.accounts)) { total += d.count || 0; }
    // 保留 success/fail：优先用 body 传入，其次用已有 KV 值，最终兜底 total/0
    let existingSuccess, existingFail;
    try { const existing = kvGetJSON(KV_KEY_USAGE_DAILY_STATS) || {}; existingSuccess = existing.success; existingFail = existing.fail; } catch {}
    out.success = body.success !== undefined ? body.success : (existingSuccess !== undefined ? existingSuccess : total);
    out.fail = body.fail !== undefined ? body.fail : (existingFail !== undefined ? existingFail : 0);
    out.total = total;
    kvPutJSON(KV_KEY_USAGE_DAILY_STATS, out);
    dailyStatsAccumulator = { accounts: {}, models: {}, total: 0, success: 0, fail: 0 };
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  // GET /admin/usage/stats/monthly — 月度统计
  if (path === '/admin/usage/stats/monthly' && method === 'GET') {
    await flushMonthlyStatsBuffer();
    let monthly = {};
    try { monthly = kvGetJSON(KV_KEY_USAGE_MONTHLY_STATS) || {}; } catch {}
    return new Response(JSON.stringify({ success: true, monthly }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // DELETE /admin/usage — 清空使用记录（不影响累计统计）
  if (path === '/admin/usage' && method === 'DELETE') {
    await flushStatsBuffer();
    await flushDailyStatsBuffer();
    kvPutJSON(KV_KEY_USAGE_LOGS, []);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ===================== 模型列表 =====================
async function handleModels(request, corsHeaders) {
  const accounts = await loadAccounts();
  const modelSet = new Set();
  for (const acct of accounts) {
    if (isAccountEnabled(acct)) {
      if (acct.models) {
        for (const m of acct.models) modelSet.add(m);
      }
      if (acct.model_map) {
        for (const key of Object.keys(acct.model_map)) {
          modelSet.add(key);
        }
      }
    }
  }

  const models = Array.from(modelSet).map(m => ({
    id: m,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'system',
  }));

  return new Response(JSON.stringify({ object: 'list', data: models }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ===================== Responses API 兼容层 =====================
// Codex Desktop 使用 /v1/responses (responses API)
// 上游只支持 /v1/chat/completions (chat completions API)
// 这里做双向转换

function generateResponseId() {
  return 'resp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function generateOutputItemId() {
  return 'item_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 将 Responses API input 转为 Chat Completions messages
function responsesInputToMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return input.map(item => {
      // Responses API item 格式: { type: "message", role: "user", content: "..." }
      // 或 { type: "message", role: "assistant", content: [{ type: "output_text", text: "..." }] }
      if (item.type === 'message') {
        let content = item.content;
        if (Array.isArray(content)) {
          content = content.map(c => c.text || c.value || '').join('');
        }
        return { role: item.role, content };
      }
      // function_call / function_call_output 等
      if (item.type === 'function_call') {
        return { role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] };
      }
      if (item.type === 'function_call_output') {
        return { role: 'tool', tool_call_id: item.call_id, content: item.output };
      }
      // 兜底
      return { role: item.role || 'user', content: item.content || item.text || '' };
    });
  }
  return [{ role: 'user', content: String(input || '') }];
}

// 将 Chat Completions response 转为 Responses API 格式
function chatResponseToResponses(chatResp, responseId) {
  const choice = chatResp.choices && chatResp.choices[0];
  const message = choice ? choice.message : {};
  const outputItems = [];

  // reasoning item (if present)
  if (message.reasoning_content) {
    const reasoningItem = {
      type: 'reasoning',
      id: generateOutputItemId(),
      content: [{ type: 'reasoning_text', text: message.reasoning_content }],
    };
    if (message.reasoning_content_signature) {
      reasoningItem.content[0].signature = message.reasoning_content_signature;
    }
    outputItems.push(reasoningItem);
  }

  // message item
  const messageItem = {
    type: 'message',
    id: generateOutputItemId(),
    role: message.role || 'assistant',
    status: 'completed',
    content: [],
  };
  if (message.content) {
    messageItem.content.push({ type: 'output_text', text: message.content });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      outputItems.push({
        type: 'function_call',
        id: generateOutputItemId(),
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: 'completed',
      });
    }
  }
  outputItems.push(messageItem);

  const usage = chatResp.usage || {};
  // cached_tokens can be at top level (Anthropic) or in prompt_tokens_details (OpenAI)
  const cachedTokens = usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0;
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chatResp.model,
    output: outputItems,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      input_tokens_details: {
        cached_tokens: cachedTokens,
      },
      output_tokens_details: {},
    },
    temperature: null,
    max_output_tokens: null,
  };
}

// 将 Chat Completions SSE stream chunk 转为 Responses API SSE
function chatStreamChunkToResponses(chunk, responseId, state) {
  // chunk 是解析后的 JSON 对象
  const choice = chunk.choices && chunk.choices[0];
  const delta = choice ? choice.delta : {};
  const lines = [];

  // 第一个 chunk: 发送 response.created + response.in_progress
  if (!state.started) {
    state.started = true;
    const created = {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model: chunk.model,
        output: [],
      },
    };
    lines.push('data: ' + JSON.stringify(created));
    const inProgress = { type: 'response.in_progress', response: created.response };
    lines.push('data: ' + JSON.stringify(inProgress));
  }

  // content part delta
  if (delta.content) {
    lines.push('data: ' + JSON.stringify({
      type: 'response.output_item.delta',
      delta: {
        type: 'content_delta',
        content_index: 0,
        delta: delta.content,
      },
      output_index: state.outputIndex,
      item_id: state.itemId,
    }));
  }

  // reasoning_content delta
  if (delta.reasoning_content) {
    lines.push('data: ' + JSON.stringify({
      type: 'response.output_item.delta',
      delta: {
        type: 'reasoning_delta',
        delta: delta.reasoning_content,
      },
      output_index: state.outputIndex,
      item_id: state.itemId + '_reasoning',
    }));
  }

  // tool_calls delta
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.index !== undefined && tc.index > 0) {
        // 新的 tool call
        state.outputIndex++;
      }
      lines.push('data: ' + JSON.stringify({
        type: 'response.output_item.delta',
        delta: {
          type: 'function_call_arguments_delta',
          call_id: tc.id || '',
          arguments: tc.function?.arguments || '',
        },
        output_index: state.outputIndex,
        item_id: state.itemId + '_tc' + state.outputIndex,
      }));
    }
  }

  // finish reason → response.completed
  if (choice && choice.finish_reason) {
    const outputItems = [];
    // 构造最终 output items
    if (delta.content || state.hasContent) {
      outputItems.push({
        type: 'message',
        id: state.itemId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: delta.content || '' }],
      });
    }
    // usage
    const usage = chunk.usage || {};
    // cached_tokens can be at top level (Anthropic) or in prompt_tokens_details (OpenAI)
    const cachedTokens = usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0;
    const completed = {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: chunk.model,
        output: outputItems,
        usage: {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
          input_tokens_details: { cached_tokens: cachedTokens },
        },
      },
    };
    lines.push('data: ' + JSON.stringify(completed));
  }

  return lines;
}

async function handleResponsesAPI(request, corsHeaders) {
  const accounts = await loadAccounts();
  const enabledAccounts = accounts.filter(isAccountEnabled);
  const startTime = Date.now();

  if (enabledAccounts.length === 0) {
    return new Response(JSON.stringify({
      error: { message: 'No enabled upstream accounts.' },
    }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  let model = body && body.model;
  if (typeof model !== 'string' || !model.trim()) {
    return new Response(JSON.stringify({ error: { message: 'model is required' } }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  model = model.trim();

  // 处理 previous_response_id：加载历史对话
  const previousResponseId = body.previous_response_id;
  const previousMessages = previousResponseId ? (loadConversation(previousResponseId) || []) : [];
  if (previousResponseId && previousMessages.length > 0) {
    deleteConversation(previousResponseId);
  }

  // 转换为 chat/completions 格式，合并历史消息
  const currentMessages = responsesInputToMessages(body.input);
  const messages = [...previousMessages, ...currentMessages];
  // 深拷贝一份纯数据用于存储，避免 openaiToAnthropicRequest 的 cache_control 原地修改污染
  const allInputMessages = JSON.parse(JSON.stringify(messages));
  const chatBody = {
    model,
    messages,
    stream: body.stream === true,
  };
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.max_output_tokens !== undefined) chatBody.max_tokens = body.max_output_tokens;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.tools) chatBody.tools = body.tools;
  if (body.tool_choice) chatBody.tool_choice = body.tool_choice;
  if (body.reasoning) {
    // reasoning effort → some providers support this
    chatBody.reasoning_effort = body.reasoning.effort || undefined;
    // 【Fix 15】保留完整 reasoning 对象（包含 summary、exclude 等字段）供下游使用
    chatBody.reasoning = body.reasoning;
  }

  const responseId = generateResponseId();
  const isStream = chatBody.stream;

  // 找候选账号
  const allowanceConfig = await loadAllowanceConfig();
  const allowanceStatus = await getAllowanceStatus(collectAllowanceTargets(enabledAccounts, allowanceConfig));
  let candidates = enabledAccounts.filter(c => findMappedModel(c, model) !== null);

  if (candidates.length === 0) {
    return new Response(JSON.stringify({
      error: { message: "Model '" + model + "' not available." },
    }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const ua = request.headers.get('User-Agent') || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';
  let lastError = '';
  const priorityGroups = groupByPriority(candidates);

  for (const group of priorityGroups) {
    const order = weightedShuffle(group);
    for (const acct of order) {
      try {
        const isAnthropic = acct.format === 'anthropic';
        const targetUrl = buildTargetUrl(acct.base_url, isAnthropic ? '/v1/messages' : '/v1/chat/completions');
        const mappedModel = findMappedModel(acct, model);
        let bodyToSend;
        if (isAnthropic) {
          var baseForAnthropic = (mappedModel !== model) ? { ...chatBody, model: mappedModel, messages: JSON.parse(JSON.stringify(chatBody.messages)) } : { ...chatBody, messages: JSON.parse(JSON.stringify(chatBody.messages)) };
          bodyToSend = openaiToAnthropicRequest(baseForAnthropic);
        } else {
          bodyToSend = (mappedModel !== model) ? { ...chatBody, model: mappedModel } : { ...chatBody };
          if (isStream) {
            bodyToSend.stream_options = { ...(bodyToSend.stream_options || {}), include_usage: true };
          }
        }

          const allowanceRuntime = resolveAllowanceRuntime(acct, mappedModel || model, allowanceConfig, allowanceStatus);
          if (allowanceRuntime && !allowanceRuntime.allowed) {
            lastError = '[' + acct.name + '] allowance ' + allowanceRuntime.reason;
            continue;
          }
          const allowanceInfo = allowanceRuntime ? allowanceRuntime.info : null;

          const poolMode = isPoolMode(acct);
        const maxRetries = poolMode ? normalizePoolRetryCount(acct) : 0;
        const retryStatuses = poolMode ? normalizePoolRetryStatuses(acct) : [];
        let attempt = 0;

        while (attempt <= maxRetries) {
          attempt++;
          if (attempt > 1) await new Promise(r => setTimeout(r, 500));

          try {
            if (poolMode) {
              const cr = await concurrencyDO.handleStart({ accountId: acct.account_id, requestId: 'req_' + Date.now(), maxConcurrency: acct.max_concurrency || 5 });
              if (cr && cr.allowed === false) { lastError = '[' + acct.name + '] concurrency limit'; break; }
            }

            const upstreamResp = await poolFetch(targetUrl, {
              method: 'POST',
              headers: isAnthropic ? {
                'Content-Type': 'application/json',
                'x-api-key': acct.api_key,
                'anthropic-version': '2023-06-01',
              } : {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + acct.api_key,
              },
              body: JSON.stringify(bodyToSend),
            });

            if (!upstreamResp.ok) {
              const errText = await upstreamResp.text().catch(() => '');
              lastError = '[' + acct.name + '] upstream ' + upstreamResp.status + ': ' + errText.slice(0, 200);
              if (poolMode && retryStatuses.includes(upstreamResp.status)) continue;
              break;
            }

            // 成功！记录 usage 并返回
            if (isStream) {
              if (isAnthropic) {
                // Anthropic 流式 → OpenAI 流式 SSE → Responses API 流式 SSE
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const transformer = createAnthropicStreamTransformer(upstreamResp.body, async function(usage) {
                  recordUsageAndDebit(allowanceInfo, acct, model, model, usage, bodyToSend, Date.now() - startTime, 200, true, '', request, ua, ip).catch(() => {});
                });
                const tReader = transformer.getReader();
                const decoder = new TextDecoder();
                const state = { started: false, outputIndex: 0, itemId: generateOutputItemId(), hasContent: false, assistantContent: '' };
                (async () => {
                  let buffer = '';
                  try {
                    while (true) {
                      const { done, value } = await tReader.read();
                      if (done) break;
                      buffer += decoder.decode(value, { stream: true });
                      const chunks = buffer.split('\n');
                      buffer = chunks.pop();
                      for (const line of chunks) {
                        if (!line.startsWith('data: ')) continue;
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                          await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
                          continue;
                        }
                        try {
                          const chatChunk = JSON.parse(data);
                          // 累积 assistant 回复内容
                          if (chatChunk.choices && chatChunk.choices[0] && chatChunk.choices[0].delta && chatChunk.choices[0].delta.content) {
                            state.assistantContent += chatChunk.choices[0].delta.content;
                          }
                          const responseLines = chatStreamChunkToResponses(chatChunk, responseId, state);
                          for (const rl of responseLines) {
                            await writer.write(new TextEncoder().encode(rl + '\n\n'));
                          }
                        } catch {}
                      }
                    }
                  } catch {} finally {
                    if (state.assistantContent) {
                      saveConversation(responseId, [...allInputMessages, { role: 'assistant', content: state.assistantContent }]);
                    }
                    await writer.close();
                  }
                })();
                return new Response(readable, {
                  status: 200,
                  headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    ...corsHeaders,
                  },
                });
              }
              // 流式：直接 pipe 上游 SSE，同时转发
              const { readable, writable } = new TransformStream();
              const writer = writable.getWriter();
              const reader = upstreamResp.body.getReader();
              const decoder = new TextDecoder();

              (async () => {
                const state = { started: false, outputIndex: 0, itemId: generateOutputItemId(), hasContent: false, assistantContent: '' };
                let buffer = '';
                let finalUsage = null;
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const chunks = buffer.split('\n');
                    buffer = chunks.pop();
                    for (const line of chunks) {
                      if (!line.startsWith('data: ')) continue;
                      const data = line.slice(6).trim();
                      if (data === '[DONE]') {
                        await writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
                        continue;
                      }
                      try {
                        const chatChunk = JSON.parse(data);
                        if (chatChunk.choices && chatChunk.choices[0] && chatChunk.choices[0].delta && chatChunk.choices[0].delta.content) {
                          state.hasContent = true;
                          state.assistantContent += chatChunk.choices[0].delta.content;
                        }
                        // 捕获最后一个包含 usage 的 chunk
                        if (chatChunk.usage) {
                          finalUsage = chatChunk.usage;
                        }
                        const responseLines = chatStreamChunkToResponses(chatChunk, responseId, state);
                        for (const rl of responseLines) {
                          await writer.write(new TextEncoder().encode(rl + '\n\n'));
                        }
                      } catch {}
                    }
                  }
                } catch {}
                // 记录 usage（如有）
                if (finalUsage) {
                  const chatUsage = extractUsageTokens(finalUsage);
                  recordUsageAndDebit(allowanceInfo, acct, model, model, chatUsage, bodyToSend, Date.now() - startTime, 200, true, '', request, ua, ip).catch(() => {});
                }
                if (state.assistantContent) {
                  saveConversation(responseId, [...allInputMessages, { role: 'assistant', content: state.assistantContent }]);
                }
                await writer.close();
              })();

              return new Response(readable, {
                status: 200,
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  ...corsHeaders,
                },
              });
            } else {
              // 非流式
              if (isAnthropic) {
                const anthropicResp = await upstreamResp.json();
                const openaiData = anthropicToOpenaiResponse(anthropicResp);
                // 【Fix 1】转换为 Responses API 格式
                const responsesResp = chatResponseToResponses(openaiData, responseId);
                // 【Fix 4】使用 extractUsageTokens 提取完整的 usage（含 cache 字段）
                const usage = extractUsageTokens(anthropicResp.usage || anthropicResp);
                recordUsageAndDebit(allowanceInfo, acct, model, model, usage, bodyToSend, Date.now() - startTime, 200, false, '', request, ua, ip).catch(() => {});
                // 保存对话历史
                const astMsg = openaiData.choices?.[0]?.message;
                if (astMsg) saveConversation(responseId, [...allInputMessages, astMsg]);
                return new Response(JSON.stringify(responsesResp), {
                  headers: { 'Content-Type': 'application/json', ...corsHeaders },
                });
              }
              const chatResp = await upstreamResp.json();
              const responsesResp = chatResponseToResponses(chatResp, responseId);
              const chatUsage = extractUsageTokens(chatResp.usage || chatResp);
              recordUsageAndDebit(allowanceInfo, acct, model, model, chatUsage, bodyToSend, Date.now() - startTime, 200, false, '', request, ua, ip).catch(() => {});
              const astMsg2 = chatResp.choices?.[0]?.message;
              if (astMsg2) saveConversation(responseId, [...allInputMessages, astMsg2]);
              return new Response(JSON.stringify(responsesResp), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
              });
            }
          } catch (err) {
            lastError = '[' + acct.name + '] ' + err.message;
          } finally {
            if (poolMode) {
              concurrencyDO.handleEnd({ requestId: 'req_' + Date.now() }).catch(() => {});
            }
          }
        }
      } catch (err) {
        lastError = '[' + acct.name + '] ' + err.message;
      }
    }
  }

  return new Response(JSON.stringify({
    error: { message: lastError || 'All upstream accounts failed' },
  }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

// ===================== AI 请求转发 =====================
async function handleProxy(request, path, corsHeaders) {
  const accounts = await loadAccounts();
  const enabledAccounts = accounts.filter(isAccountEnabled);
  const startTime = Date.now();

  if (enabledAccounts.length === 0) {
    const ua = request.headers.get('User-Agent') || '';
    const ip = request.headers.get('CF-Connecting-IP') || '';
    usageBufferDO.handlePush(makeUsageLogEntry(null, '', '', 0, 0, 0, 0,
      0, 503, false, 'No enabled accounts', request, ua, ip));
    return new Response(JSON.stringify({
      error: { message: 'No enabled upstream accounts. Configure in /admin' },
    }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  let model = body && body.model;
  if (typeof model !== 'string' || !model.trim()) {
    return new Response(JSON.stringify({ error: { message: 'model is required' } }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  model = model.trim();

  const allowanceConfig = await loadAllowanceConfig();
  const allowanceStatus = await getAllowanceStatus(collectAllowanceTargets(enabledAccounts, allowanceConfig));

  // 找到所有 enabled 且支持该 model 的上游账号（models 列表或 model_map 均可）
  let candidates = enabledAccounts.filter(c => findMappedModel(c, model) !== null);

  if (candidates.length === 0) {
    const ua = request.headers.get('User-Agent') || '';
    const ip = request.headers.get('CF-Connecting-IP') || '';
    usageBufferDO.handlePush(makeUsageLogEntry(null, model, null, 0, 0, 0, 0,
      Date.now() - startTime, 404, false, "Model '" + model + "' not available",
      request, ua, ip));
    return new Response(JSON.stringify({
      error: { message: "Model '" + model + "' not available. Configure in /admin" },
    }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const isStream = body.stream === true;
  let lastError = '';
  const ua = request.headers.get('User-Agent') || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';

  // 按 priority 从小到大分组：1 最优先
  const priorityGroups = groupByPriority(candidates);

  for (const group of priorityGroups) {
    // 组内按 weightedShuffle 生成尝试顺序
    const order = weightedShuffle(group);
    for (const acct of order) {
      const maxConc = acct.max_concurrency || 0;

      try {
        const isAnthropic = acct.format === 'anthropic';
        const targetUrl = buildTargetUrl(acct.base_url, isAnthropic ? '/v1/messages' : path);
        const mappedModel = findMappedModel(acct, model);
        let bodyToSend;
        if (isAnthropic) {
          var baseForAnthropic = (mappedModel !== model) ? { ...body, model: mappedModel } : { ...body };
          bodyToSend = openaiToAnthropicRequest(baseForAnthropic);
        } else {
          bodyToSend = (mappedModel !== model) ? { ...body, model: mappedModel } : { ...body };
          if (isStream) {
            bodyToSend.stream_options = { ...(bodyToSend.stream_options || {}), include_usage: true };
          }
        }

        const allowanceRuntime = resolveAllowanceRuntime(acct, mappedModel || model, allowanceConfig, allowanceStatus);
        const allowanceInfo = allowanceRuntime ? allowanceRuntime.info : null;
        if (allowanceRuntime && !allowanceRuntime.allowed) {
          lastError = '[' + acct.name + '] allowance ' + allowanceRuntime.reason;
          continue;
        }
        // count 模式需要 1 次；shared/usage 模式按输入粗估最低成本
        let requiredUnits = 0;
        if (allowanceInfo && allowanceInfo.type === 'total' && allowanceInfo.quota && allowanceInfo.quota.mode === 'count') {
          requiredUnits = 1;
        } else if (allowanceInfo) {
          const estInput = estimateInputTokensFromBody(bodyToSend);
          const estUsage = { inputTokens: estInput, outputTokens: 0, totalTokens: estInput, cacheTokens: 0 };
          requiredUnits = calculateAllowanceDebitUnits(allowanceInfo, mappedModel || model, estUsage);
        }
        const allowanceCheck = await checkAllowance(allowanceInfo && allowanceInfo.target, requiredUnits);
        if (allowanceCheck && allowanceCheck.allowed === false) {
          lastError = '[' + acct.name + '] allowance ' + (allowanceCheck.reason || 'exhausted');
          continue;
        }

        // 池模式参数
        const poolMode = isPoolMode(acct);
        const maxRetries = poolMode ? normalizePoolRetryCount(acct) : 0;
        const retryStatuses = poolMode ? normalizePoolRetryStatuses(acct) : [];
        let attempt = 0;

        // 池模式：同一账号最多额外重试 maxRetries 次
        while (true) {
          if (attempt > 0) {
            await sleep(300 + Math.random() * 200);
          }

          // 全局并发：请求开始前向 Durable Object 申请槽位
          const concurrencyRequestId = genId();
          const concurrencyStart = await concurrencyDO.handleStart({ accountId: acct.id, requestId: concurrencyRequestId, maxConcurrency: maxConc });
          if (!concurrencyStart.allowed) {
            lastError = '[' + acct.name + '] concurrency full';
            break;
          }

          let response;
          let tFetch, tResp;
          try {
            tFetch = Date.now();
            response = await poolFetch(targetUrl, {
              method: 'POST',
              headers: isAnthropic ? {
                'Content-Type': 'application/json',
                'x-api-key': acct.api_key,
                'anthropic-version': '2023-06-01',
              } : {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + acct.api_key,
              },
              body: JSON.stringify(bodyToSend),
              timeout: 300000,
            });
            tResp = Date.now();
          } catch (err) {
            // 网络异常或超时：先记录统计并 flush，再递减并发
            await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
              emptyUsageTokens(), bodyToSend, Date.now() - startTime, 0, isStream, err.message || 'network error', request, ua, ip);
            await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
            // 池模式 + 还有重试次数 → 原地重试
            if (poolMode && attempt < maxRetries) {
              attempt++;
              continue;
            }
            throw err;
          }
          const durationMs = tResp - startTime;
          const timingHeaders = {
            'X-Worker-Time': String(tFetch - startTime) + 'ms',
            'X-Upstream-Time': String(tResp - tFetch) + 'ms',
          };



          // 2xx/3xx 成功
          if (response.ok) {
            if (isStream) {
              if (isAnthropic) {
                return new Response(createAnthropicStreamTransformer(response.body, async function(usage) {
                  await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
                    usage, bodyToSend, Date.now() - startTime, response.status, true, '', request, ua, ip);
                  await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
                }), {
                  status: response.status,
                  headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    ...corsHeaders,
                    ...timingHeaders,
                  },
                });
              }
              return new Response(wrapStreamWithFinalize(response.body, async function(usage) {
                await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
                  usage, bodyToSend, Date.now() - startTime, response.status, true, '', request, ua, ip);
                // flush 已在 recordUsageAndDebit 中处理
                await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
              }), {
                status: response.status,
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  ...corsHeaders,
                  ...timingHeaders,
                },
              });
            }

            try {
              // 非流式：读取 body 提取 usage 后返回
              const text = await response.text();
              let inputTokens = 0, outputTokens = 0, totalTokens = 0, cacheTokens = 0, cacheCreateTokens = 0;
              let responseText = text;
              if (isAnthropic) {
                try {
                  const anthropicData = JSON.parse(text);
                  const openaiData = anthropicToOpenaiResponse(anthropicData);
                  const usage = extractUsageTokens(anthropicData.usage || anthropicData);
                  inputTokens = usage.inputTokens;
                  outputTokens = usage.outputTokens;
                  totalTokens = usage.totalTokens;
                  cacheTokens = usage.cacheTokens;
                  cacheCreateTokens = usage.cacheCreateTokens;
                  responseText = JSON.stringify(openaiData);
                } catch {}
              } else {
                try {
                  const data = JSON.parse(text);
                  const usage = extractUsageTokens(data.usage || data);
                  inputTokens = usage.inputTokens;
                  outputTokens = usage.outputTokens;
                  totalTokens = usage.totalTokens;
                  cacheTokens = usage.cacheTokens;
                  cacheCreateTokens = usage.cacheCreateTokens;
                } catch {}
              }
              await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
                { inputTokens, outputTokens, totalTokens, cacheTokens, cacheCreateTokens }, bodyToSend,
                durationMs, response.status, false, '', request, ua, ip);
              return new Response(responseText, {
                status: response.status,
                headers: { 'Content-Type': 'application/json', ...corsHeaders, ...timingHeaders },
              });
            } finally {
              await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
            }
          }

          // 5xx — 池模式重试，否则跳到下一个账号
          if (response.status >= 500) {
            let errText = '';
            try { errText = await response.text(); } catch {}
            await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
              emptyUsageTokens(), bodyToSend, durationMs, response.status, false, errText.slice(0, 200), request, ua, ip);
            await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
            if (poolMode && attempt < maxRetries) {
              attempt++;
              continue;
            }
            lastError = '[' + acct.name + '] ' + response.status;
            break;
          }

          // 4xx 处理
          if (response.status >= 400) {
            // 池模式 + 可重试状态码：原地重试
            if (poolMode && retryStatuses.indexOf(response.status) !== -1 && attempt < maxRetries) {
              await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
                emptyUsageTokens(), bodyToSend, durationMs, response.status, isStream, '', request, ua, ip);
              await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
              attempt++;
              continue;
            }
            // 池模式 + 可重试状态码但重试次数耗尽：不返回 4xx，继续尝试下一个账号
            if (poolMode && retryStatuses.indexOf(response.status) !== -1) {
              await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
                emptyUsageTokens(), bodyToSend, durationMs, response.status, isStream, '重试耗尽，最后状态 ' + response.status, request, ua, ip);
              await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
              lastError = '[' + acct.name + '] pool retry exhausted after ' + maxRetries + ' retries, last status ' + response.status;
              break;
            }
            // 非池模式或非可重试 4xx：直接返回上游
            await recordUsageAndDebit(allowanceInfo, acct, model, mappedModel || model,
              emptyUsageTokens(), bodyToSend, durationMs, response.status, isStream, '', request, ua, ip);
            if (isStream) {
              return new Response(wrapStreamWithFinalize(response.body, async function() {
                await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
              }), {
                status: response.status,
                headers: {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  ...corsHeaders,
                  ...timingHeaders,
                },
              });
            }
            try {
              return await proxyRespond(response, isStream, corsHeaders, timingHeaders);
            } finally {
              await concurrencyDO.handleEnd({ requestId: concurrencyRequestId });
            }
          }
        }
        // 同账号重试耗尽：继续尝试下一个账号
        continue;
      } catch (err) {
        lastError = '[' + acct.name + '] ' + err.message;
        continue;
      }
    }
    // 当前 priority 组全部失败，降级到下一组
  }

  // 所有上游账号失败 → 502
  const durationMs = Date.now() - startTime;
  const exhaustedByAllowance = String(lastError || '').indexOf('allowance') !== -1;
  usageBufferDO.handlePush(makeUsageLogEntry(null, model, null,
    0, 0, 0, 0, durationMs, exhaustedByAllowance ? 503 : 502, isStream, lastError, request, ua, ip));
  return new Response(JSON.stringify({
    error: { message: (exhaustedByAllowance ? 'No upstream account with remaining allowance. Last: ' : 'All upstream accounts failed. Last: ') + lastError },
  }), { status: exhaustedByAllowance ? 503 : 502, headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Worker-Time': String(durationMs) + 'ms' } });
}

// ===================== Image Generation API =====================
// /v1/images/generations → 转发到支持图片生成的上游账号
// 支持 OpenAI gpt-image-2 格式

async function handleImageGenerations(request, corsHeaders) {
  const accounts = await loadAccounts();
  const enabledAccounts = accounts.filter(isAccountEnabled);
  const startTime = Date.now();

  if (enabledAccounts.length === 0) {
    return new Response(JSON.stringify({
      error: { message: 'No enabled upstream accounts.' },
    }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  let model = body && body.model;
  if (typeof model !== 'string' || !model.trim()) {
    // 默认使用 gpt-image-2
    model = 'gpt-image-2';
  }
  model = model.trim();

  // 找支持图片生成的账号（models 中包含 gpt-image-2 或类似图片模型）
  const imageModels = ['gpt-image-2', 'gpt-image-1', 'dall-e-3', 'dall-e-2'];
  let candidates = enabledAccounts.filter(acct => {
    if (!acct.models || !Array.isArray(acct.models)) return false;
    return acct.models.some(m => imageModels.includes(m));
  });

  // 如果没找到专门的图片账号，尝试用任何支持的账号
  if (candidates.length === 0) {
    candidates = enabledAccounts.filter(acct => {
      if (!acct.models || !Array.isArray(acct.models)) return false;
      return acct.models.some(m => m.includes('image') || m.includes('dall'));
    });
  }

  if (candidates.length === 0) {
    return new Response(JSON.stringify({
      error: { message: 'No upstream account supports image generation.' },
    }), { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }

  const ua = request.headers.get('User-Agent') || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';
  let lastError = '';

  // 按优先级排序
  candidates.sort((a, b) => (a.priority || 1) - (b.priority || 1));

  for (const acct of candidates) {
    try {
      // 构建上游请求
      const targetUrl = buildTargetUrl(acct.base_url, '/v1/images/generations');
      
      // 映射模型名
      let upstreamModel = model;
      if (acct.model_map && acct.model_map[model]) {
        upstreamModel = acct.model_map[model];
      }

      // 构建请求体
      const bodyToSend = {
        model: upstreamModel,
        prompt: body.prompt,
        n: body.n || 1,
        size: body.size || '1024x1024',
      };
      
      // 可选参数
      if (body.quality) bodyToSend.quality = body.quality;
      if (body.style) bodyToSend.style = body.style;
      if (body.response_format) bodyToSend.response_format = body.response_format;
      if (body.background) bodyToSend.background = body.background;
      if (body.moderation) bodyToSend.moderation = body.moderation;

      console.log(`[ImageGen] ${acct.name} → ${targetUrl} model=${upstreamModel}`);

      const upstreamResp = await poolFetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + acct.api_key,
        },
        body: JSON.stringify(bodyToSend),
        timeout: 300000, // 图片生成可能较慢
      });

      if (!upstreamResp.ok) {
        const errText = await upstreamResp.text().catch(() => '');
        lastError = '[' + acct.name + '] upstream ' + upstreamResp.status + ': ' + errText.slice(0, 200);
        console.log(`[ImageGen] Error: ${lastError}`);
        continue;
      }

      // 成功！返回响应
      const responseText = await upstreamResp.text();
      console.log(`[ImageGen] Success from ${acct.name}`);
      
      return new Response(responseText, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });

    } catch (err) {
      lastError = '[' + acct.name + '] ' + err.message;
      console.log(`[ImageGen] Exception: ${lastError}`);
      continue;
    }
  }

  // 所有账号失败
  return new Response(JSON.stringify({
    error: { message: 'All upstream accounts failed. Last: ' + lastError },
  }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

// 透传上游响应，流式直接透传 body，非流式兼容 json 解析失败
async function proxyRespond(response, isStream, corsHeaders, extraHeaders) {
  extraHeaders = extraHeaders || {};
  if (isStream) {
    return new Response(wrapStreamWithConcurrencyRelease(response.body), {
      status: response.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...corsHeaders,
        ...extraHeaders,
      },
    });
  }

  // 非流式：先读 text，再尝试 JSON.parse，避免 json() 失败后 body 已被消费
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders, ...extraHeaders },
    });
  } catch {
    return new Response(text, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'text/plain', ...corsHeaders, ...extraHeaders },
    });
  }
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeAllowanceTargetForDO(target) {
  if (!target || typeof target !== 'object') return null;
  const targetId = String(target.targetId || '').trim();
  if (!targetId) return null;
  return {
    targetId,
    kind: String(target.kind || 'unknown'),
    totalUnits: Math.max(0, Math.ceil(Number(target.totalUnits || 0))),
    expiresAt: String(target.expiresAt || ''),
  };
}

function isAllowanceExpired(expiresAt) {
  if (!expiresAt) return false;
  // 只取日期部分（前10字符 YYYY-MM-DD），避免完整 ISO 字符串拼接出 Invalid Date
  const dateStr = String(expiresAt).slice(0, 10);
  const end = new Date(dateStr + 'T23:59:59').getTime();
  return Number.isFinite(end) && Date.now() > end;
}

async function checkAllowance(target, requiredUnits) {
  if (!target) return { success: true, allowed: true };
  const data = await allowanceDO.handleCheck({ target, requiredUnits: requiredUnits || 0 });
  if (data && data.success) return data;
  // 余量 DO 异常时不阻断 API 调用，避免余额系统故障导致全站不可用。
  return { success: false, allowed: true, fallback: true };
}

async function debitAllowance(target, amountUnits) {
  if (!target || !amountUnits || amountUnits <= 0) return { success: true, skipped: true };
  const data = await allowanceDO.handleDebit({ target, amountUnits });
  return data && data.success ? data : { success: false };
}

async function setAllowanceRemaining(targetId, remainingRaw) {
  const remainingUnits = Math.max(0, Math.ceil(Number(remainingRaw || 0)));
  return await allowanceDO.handleSetRemaining({ targetId, remainingUnits });
}

async function resetAllowanceTarget(target) {
  if (!target) return { success: false };
  return await allowanceDO.handleReset({ target });
}

async function getAllowanceStatus(targets) {
  if (!targets || !targets.length) return {};
  const data = await allowanceDO.handleStatus({ targets: targets || [] });
  return data && data.success ? (data.items || {}) : {};
}

function emptyAllowanceConfig() {
  return { version: 1, shared_groups: [], account_quotas: {} };
}

function normalizeAllowanceConfig(config) {
  const out = emptyAllowanceConfig();
  if (config && typeof config === 'object') {
    out.version = 1;
    out.shared_groups = Array.isArray(config.shared_groups) ? config.shared_groups.filter(Boolean) : [];
    out.account_quotas = config.account_quotas && typeof config.account_quotas === 'object' ? config.account_quotas : {};
  }
  return out;
}

async function loadAllowanceConfig() {
  const now = Date.now();
  if (cachedAllowanceConfig !== null && (now - cachedAllowanceConfigAt) < ALLOWANCE_CONFIG_CACHE_TTL * 1000) {
    return cachedAllowanceConfig;
  }
  try {
    const raw = kvGet(KV_KEY_ALLOWANCE_CONFIG);
    const config = raw ? normalizeAllowanceConfig(JSON.parse(raw)) : emptyAllowanceConfig();
    cachedAllowanceConfig = config;
    cachedAllowanceConfigAt = now;
    return config;
  } catch {
    cachedAllowanceConfig = emptyAllowanceConfig();
    cachedAllowanceConfigAt = now;
    return cachedAllowanceConfig;
  }
}

async function saveAllowanceConfig(config) {
  const normalized = normalizeAllowanceConfig(config);
  kvPutJSON(KV_KEY_ALLOWANCE_CONFIG, normalized);
  cachedAllowanceConfig = normalized;
  cachedAllowanceConfigAt = Date.now();
}

function allowanceUnitsFromValue(kind, value) {
  const n = Math.max(0, Number(value || 0));
  if (kind === 'quota_count' || kind === 'quota_usage') return Math.max(0, Math.ceil(n));
  return Math.max(0, Math.round(n * ALLOWANCE_SCALE));
}

function allowanceTargetFromSharedGroup(group) {
  if (!group || !group.id) return null;
  return {
    targetId: 'shared:' + group.id,
    kind: 'shared_money',
    totalUnits: allowanceUnitsFromValue('shared_money', group.initial_balance),
    expiresAt: '',
  };
}

function allowanceTargetFromAccountQuota(accountId, quota) {
  if (!accountId || !quota) return null;
  const kind = quota.mode === 'count' ? 'quota_count' : 'quota_usage';
  let totalUnits;
  if (quota.mode === 'usage' && quota.display_currency === true) {
    // 按量（¥金额模式）：总量直接填金额，内部×1M
    totalUnits = Math.max(0, Math.round(Number(quota.initial_total || 0) * ALLOWANCE_SCALE));
  } else if (quota.mode === 'points' || quota.mode === 'count') {
    // 按积分 / 按次：总量直接存原始值，不缩放
    totalUnits = Math.max(0, Math.ceil(Number(quota.initial_total || 0)));
  } else {
    // 按量（无display_currency）：兼容旧数据
    totalUnits = allowanceUnitsFromValue(kind, quota.initial_total);
  }
  return {
    targetId: 'account:' + accountId,
    kind,
    totalUnits,
    expiresAt: quota.expires_at || '',
  };
}

function resolveAllowanceForAccount(acct, config) {
  if (!acct || !config) return null;
  for (const group of (config.shared_groups || [])) {
    if (group && group.enabled !== false && Array.isArray(group.account_ids) && group.account_ids.indexOf(acct.id) !== -1) {
      // 检查账号是否有自己的 rates_text（优先级高于组的默认倍率）
      const accountQuota = config.account_quotas && config.account_quotas[acct.id];
      const accountRatesText = accountQuota && accountQuota.rates_text ? accountQuota.rates_text : null;
      return { type: 'shared', group, target: allowanceTargetFromSharedGroup(group), accountId: acct.id, accountRatesText };
    }
  }
  const quota = config.account_quotas && config.account_quotas[acct.id];
  if (quota && quota.enabled !== false) {
    return { type: 'total', quota, target: allowanceTargetFromAccountQuota(acct.id, quota), accountId: acct.id };
  }
  return null;
}

function collectAllowanceTargets(accounts, config) {
  const seen = {};
  const targets = [];
  for (const acct of (accounts || [])) {
    const info = resolveAllowanceForAccount(acct, config);
    if (info && info.target && !seen[info.target.targetId]) {
      seen[info.target.targetId] = true;
      targets.push(info.target);
    }
  }
  return targets;
}

function resolveAllowanceRuntime(acct, model, config, statusMap) {
  const info = resolveAllowanceForAccount(acct, config);
  if (!info) return null;
  const state = statusMap && statusMap[info.target.targetId] ? statusMap[info.target.targetId] : null;
  if (state && isAllowanceExpired(state.expiresAt)) {
    return { info, state, allowed: false, reason: 'expired', remainingUnits: Number(state.remainingUnits || 0) };
  }
  if (!hasAllowanceRate(info, model)) {
    return { info, state, allowed: false, reason: 'no_rate', remainingUnits: Number((state && state.remainingUnits) || info.target.totalUnits || 0) };
  }
  const remainingUnits = Number((state && state.remainingUnits) != null ? state.remainingUnits : info.target.totalUnits || 0);
  if (remainingUnits <= 0) {
    return { info, state, allowed: false, reason: 'exhausted', remainingUnits };
  }
  return { info, state, allowed: true, reason: '', remainingUnits };
}

function parseAllowanceRates(text) {
  const rates = {};
  String(text || '').split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
    if (line.startsWith('#')) return;
    const parts = line.split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    const model = parts.shift();
    const item = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const key = p.substring(0, eq).trim();
      const rawVal = p.substring(eq + 1).trim();
      // time_mult 是字符串格式："HH:MM-HH:MM=倍率;HH:MM-HH:MM=倍率"
      if (key === 'time_mult') {
        item[key] = rawVal;
      } else {
        const val = Number(rawVal);
        if (key && Number.isFinite(val)) item[key] = val;
      }
    }
    if (Object.keys(item).length) rates[model] = item;
  });
  return rates;
}

// ============================================================
// 时间段倍率（time_mult）辅助函数
// 格式：time_mult=HH:MM-HH:MM=倍率;HH:MM-HH:MM=倍率
// 时间基于北京时间（UTC+8），支持跨天（如 22:00-02:00=1.5）
// ============================================================
function getBeijingNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(now);
  const hours = parseInt(parts.find(p => p.type === 'hour').value);
  const minutes = parseInt(parts.find(p => p.type === 'minute').value);
  return { hours, minutes };
}

function toMinutes(h, m) {
  return h * 60 + m;
}

// slotStr 格式："HH:MM-HH:MM"，返回 true 当北京时间落在该时段内
function isInTimeSlot(slotStr, bj) {
  const parts = slotStr.split('-');
  if (parts.length !== 2) return false;
  const m1 = parts[0].match(/^(\d{1,2}):(\d{2})$/);
  const m2 = parts[1].match(/^(\d{1,2}):(\d{2})$/);
  if (!m1 || !m2) return false;
  const start = toMinutes(parseInt(m1[1]), parseInt(m1[2]));
  const end = toMinutes(parseInt(m2[1]), parseInt(m2[2]));
  const now = toMinutes(bj.hours, bj.minutes);
  if (end > start) {
    // 正常时段：08:00-20:00
    return now >= start && now < end;
  } else {
    // 跨天时段：22:00-02:00
    return now >= start || now < end;
  }
}

// 从解析后的 rate 对象中读取 time_mult，若当前时间匹配某时段则返回对应倍率，否则返回 null
function computeTimeMultiplier(rate) {
  if (!rate || !rate.time_mult) return null;
  const bj = getBeijingNow();
  const slots = String(rate.time_mult).split(';').map(s => s.trim()).filter(Boolean);
  for (const slot of slots) {
    const eqIdx = slot.indexOf('=');
    if (eqIdx <= 0) continue;
    const timeRange = slot.substring(0, eqIdx).trim();
    const coeff = parseFloat(slot.substring(eqIdx + 1).trim());
    if (!Number.isFinite(coeff)) continue;
    if (isInTimeSlot(timeRange, bj)) return coeff;
  }
  return null;
}

function findAllowanceRate(ratesText, model) {
  const rates = parseAllowanceRates(ratesText);
  return rates[model] || rates['*'] || null;
}

function hasAllowanceRate(info, model) {
  if (!info) return true;
  if (info.type === 'total' && info.quota && info.quota.mode === 'count') return true;
  // 优先使用账号自己的 rates_text（如果有的话），否则用组的默认倍率
  let text;
  if (info.type === 'shared') {
    text = info.accountRatesText || info.group.rates_text;
  } else {
    text = info.quota.rates_text;
  }
  const rate = findAllowanceRate(text, model || '*');
  if (!rate) return false;
  // shared/usage 模式：至少 input/output/cache_hit/cache_create 有一个正数
  for (const k of ['input', 'output', 'cache_hit', 'cache_create']) {
    if (Number(rate[k] || 0) > 0) return true;
  }
  return false;
}

function estimateInputTokensFromBody(body) {
  let text = '';
  try {
    if (body && Array.isArray(body.messages)) {
      text = body.messages.map(m => {
        const c = m && m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : JSON.stringify(x || '')).join(' ');
        return c ? JSON.stringify(c) : '';
      }).join(' ');
    } else if (body && typeof body.prompt === 'string') text = body.prompt;
    else if (body && typeof body.input === 'string') text = body.input;
    else text = JSON.stringify(body || {});
  } catch { text = ''; }
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function usageWithEstimate(usage, body) {
  const u = usage || emptyUsageTokens();
  const total = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheTokens || 0);
  if (total > 0) return { ...u, estimated: false };
  const estimatedInput = estimateInputTokensFromBody(body);
  return { inputTokens: estimatedInput, outputTokens: 0, totalTokens: estimatedInput, cacheTokens: 0, estimated: true };
}

function calculateAllowanceDebitUnits(info, model, usage) {
  if (!info) return 0;
  if (info.type === 'total' && info.quota && info.quota.mode === 'count') {
    const rate = findAllowanceRate(info.quota.rates_text, model) || { calls: 1 };
    return Math.max(0, Math.ceil(Number(rate.calls != null ? rate.calls : 1)));
  }
  // 优先使用账号自己的 rates_text（如果有的话），否则用组的默认倍率
  let ratesText;
  if (info.type === 'shared') {
    // 如果账号有自己的 rates_text，优先使用
    if (info.accountRatesText) {
      ratesText = info.accountRatesText;
    } else {
      ratesText = info.group.rates_text;
    }
  } else {
    ratesText = info.quota.rates_text;
  }
  const rate = findAllowanceRate(ratesText, model);
  if (!rate) return 0;
  // shared 模式支持 calls（按次计费）
  if (info.type === 'shared' && rate.calls != null && rate.calls !== '') {
    return Math.max(0, Math.ceil(Number(rate.calls) * ALLOWANCE_SCALE));
  }
  // multiplier 与 time_mult 叠加（相乘）
  let multiplier = Math.max(0, Number(rate.multiplier != null ? rate.multiplier : 1));
  const timeMult = computeTimeMultiplier(rate);
  if (timeMult !== null) {
    multiplier = multiplier * Math.max(0, timeMult);
  }
  const input = Number(usage.inputTokens || 0);
  const output = Number(usage.outputTokens || 0);
  const cacheHit = Number(usage.cacheTokens || 0);
  const cacheCreate = Number(usage.cacheCreateTokens || 0);
  const normalInput = Math.max(0, input - cacheHit - cacheCreate);
  const amount =
    normalInput / 1000000 * Number(rate.input || 0) * multiplier +
    output / 1000000 * Number(rate.output || 0) * multiplier +
    cacheHit / 1000000 * Number(rate.cache_hit || 0) * multiplier +
    cacheCreate / 1000000 * Number(rate.cache_create || 0) * multiplier;
  return Math.max(0, Math.ceil(amount * ALLOWANCE_SCALE));
}

function accumulateStats(accumulator, acctName, modelName, finalUsage, amountUnits, isSuccess) {
  accumulator.total++;
  if (isSuccess) accumulator.success++; else accumulator.fail++;
  if (acctName) {
    if (!accumulator.accounts[acctName]) accumulator.accounts[acctName] = STATS_ACC_EMPTY();
    accumulator.accounts[acctName].count++;
    accumulator.accounts[acctName].input += Math.max(0, Number(finalUsage.inputTokens || 0) - Number(finalUsage.cacheTokens || 0));
    accumulator.accounts[acctName].output += Number(finalUsage.outputTokens || 0);
    accumulator.accounts[acctName].cache += Number(finalUsage.cacheTokens || 0);
    accumulator.accounts[acctName].cache_create += Number(finalUsage.cacheCreateTokens || 0);
    accumulator.accounts[acctName].consumed += amountUnits;
  }
  if (modelName) {
    if (!accumulator.models[modelName]) accumulator.models[modelName] = STATS_ACC_EMPTY();
    accumulator.models[modelName].count++;
    accumulator.models[modelName].input += Math.max(0, Number(finalUsage.inputTokens || 0) - Number(finalUsage.cacheTokens || 0));
    accumulator.models[modelName].output += Number(finalUsage.outputTokens || 0);
    accumulator.models[modelName].cache += Number(finalUsage.cacheTokens || 0);
    accumulator.models[modelName].cache_create += Number(finalUsage.cacheCreateTokens || 0);
    accumulator.models[modelName].consumed += amountUnits;
  }
}

async function recordUsageAndDebit(allowanceInfo, acct, requestedModel, upstreamModel, usage, requestBody, durationMs, status, isStream, error, request, ua, ip) {
  const finalUsage = usageWithEstimate(usage, requestBody);
  const modelForRate = upstreamModel || requestedModel;
  let amountUnits = 0;
  if (allowanceInfo && allowanceInfo.target) {
    amountUnits = calculateAllowanceDebitUnits(allowanceInfo, modelForRate, finalUsage);
    if (amountUnits > 0) await debitAllowance(allowanceInfo.target, amountUnits);
  }
  // 累积累计统计
  const acctName = acct ? (acct.name || acct.id || '') : '';
  const modelName = requestedModel || '';
  const isSuccess = status >= 200 && status < 400;
  accumulateStats(statsAccumulator, acctName, modelName, finalUsage, amountUnits, isSuccess);
  accumulateStats(dailyStatsAccumulator, acctName, modelName, finalUsage, amountUnits, isSuccess);
  // 累加月度统计
  const monthKey = getBeijingDate().slice(0, 7); // "YYYY-MM"
  const dayKey = getBeijingDate().slice(8, 10);   // "DD"
  if (!monthlyStatsAccumulator[monthKey]) monthlyStatsAccumulator[monthKey] = { total: 0, success: 0, fail: 0, daily: {} };
  monthlyStatsAccumulator[monthKey].total++;
  if (isSuccess) monthlyStatsAccumulator[monthKey].success++; else monthlyStatsAccumulator[monthKey].fail++;
  if (!monthlyStatsAccumulator[monthKey].daily[dayKey]) monthlyStatsAccumulator[monthKey].daily[dayKey] = 0;
  monthlyStatsAccumulator[monthKey].daily[dayKey]++;

  // 批量 flush 统计到 KV（每 STATS_FLUSH_BATCH_SIZE 次请求 flush 一次）
  statsFlushCounter++;
  if (statsFlushCounter >= STATS_FLUSH_BATCH_SIZE) {
    statsFlushCounter = 0;
    try {
      await flushStatsBuffer();
      await flushDailyStatsBuffer();
      await flushMonthlyStatsBuffer();
    } catch (e) {
      console.error('recordUsageAndDebit flush stats error:', e);
    }
  }

  usageBufferDO.handlePush(makeUsageLogEntry(acct, requestedModel, upstreamModel,
    finalUsage.inputTokens, finalUsage.outputTokens, finalUsage.totalTokens, finalUsage.cacheTokens,
    finalUsage.cacheCreateTokens, durationMs, status, isStream, error || '', request, ua, ip, amountUnits));
}

function uniqueStrings(arr) {
  const seen = {};
  const out = [];
  for (const raw of (arr || [])) {
    const v = String(raw || '').trim();
    if (v && !seen[v]) { seen[v] = true; out.push(v); }
  }
  return out;
}

function normalizeGroupId(name) {
  return 'grp_' + utf8ToB64(String(name || 'group')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).toLowerCase();
}

async function updateAllowanceConfigForAccount(accountId, allowance, accounts) {
  const type = allowance && allowance.type ? String(allowance.type) : 'none';
  let config = await loadAllowanceConfig();
  const allIds = new Set((accounts || []).map(a => a.id));
  const now = new Date().toISOString();
  if (!config.account_quotas) config.account_quotas = {};
  if (!Array.isArray(config.shared_groups)) config.shared_groups = [];

  function removeAccountsFromGroups(ids) {
    config.shared_groups = config.shared_groups.map(g => ({ ...g, account_ids: (g.account_ids || []).filter(id => ids.indexOf(id) === -1) }))
      .filter(g => (g.account_ids || []).length > 0);
  }

  if (type === 'shared') {
    const name = String(allowance.shared_group_name || '').trim();
    if (!name) throw new Error('中转共享组名称必填');
    let ids = uniqueStrings([...(allowance.shared_account_ids || []), accountId]).filter(id => allIds.has(id) || id === accountId);
    if (!ids.length) ids = [accountId];
    const existingGroup = config.shared_groups.find(g => g.name === name);
    const existingIds = existingGroup ? (existingGroup.account_ids || []) : [];
    const finalIds = uniqueStrings([...existingIds, ...ids]);
    removeAccountsFromGroups(ids);
    // 不再删除账号的 account_quotas，而是只删除非倍率相关的字段
    // 账号可以有自己的 rates_text（独立倍率），同时共享余额
    finalIds.forEach(id => {
      if (config.account_quotas[id]) {
        // 只保留 rates_text，删除其他字段
        const existingRatesText = config.account_quotas[id].rates_text;
        if (existingRatesText) {
          config.account_quotas[id] = { enabled: true, rates_text: existingRatesText };
        } else {
          delete config.account_quotas[id];
        }
      }
    });
    // 如果当前账号有独立倍率，保存它
    const accountRatesText = String(allowance.account_rates_text || '').trim();
    if (accountRatesText) {
      config.account_quotas[accountId] = { enabled: true, rates_text: accountRatesText };
    } else {
      // 如果没有独立倍率，删除该账号的 account_quotas
      delete config.account_quotas[accountId];
    }
    let group = existingGroup || null;
    if (!group) {
      group = { id: normalizeGroupId(name + now), name, created_at: now };
      config.shared_groups.push(group);
    } else if (!config.shared_groups.find(g => g.id === group.id)) {
      config.shared_groups.push(group);
    }
    group.name = name;
    group.enabled = true;
    group.account_ids = finalIds;
    const oldBalance = Number(group.initial_balance || 0);
    const newBalance = Number(allowance.shared_balance || 0);
    group.initial_balance = newBalance;
    group.updated_at = now;
    await saveAllowanceConfig(config);
    if (allowance.remaining != null && allowance.remaining !== '') {
      const remUnits = Math.max(0, Math.round(Number(allowance.remaining) * ALLOWANCE_SCALE));
      await setAllowanceRemaining('shared:' + group.id, remUnits);
    } else if (newBalance !== oldBalance) {
      const remUnits = Math.max(0, Math.round(newBalance * ALLOWANCE_SCALE));
      await setAllowanceRemaining('shared:' + group.id, remUnits);
    }
    return config;
  }

  removeAccountsFromGroups([accountId]);
  if (type === 'total') {
    const mode = ['count', 'usage', 'points'].includes(allowance.quota_mode) ? allowance.quota_mode : 'usage';
    config.account_quotas[accountId] = {
      enabled: true,
      mode,
      expires_at: String(allowance.quota_expires_at || ''),
      initial_total: Number(allowance.quota_total || 0),
      rates_text: String(allowance.quota_rates_text || ''),
      display_currency: allowance.quota_display_currency === true,
      updated_at: now,
    };
    await saveAllowanceConfig(config);
    if (allowance.remaining != null && allowance.remaining !== '') {
      const isCurrency = mode === 'usage' && config.account_quotas[accountId].display_currency === true;
      const remUnits = isCurrency
        ? Math.max(0, Math.round(Number(allowance.remaining) * ALLOWANCE_SCALE))
        : Math.max(0, Math.ceil(Number(allowance.remaining)));
      await setAllowanceRemaining('account:' + accountId, remUnits);
    }
    return config;
  }

  delete config.account_quotas[accountId];
  await saveAllowanceConfig(config);
  return config;
}

function emptyUsageTokens() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheTokens: 0, cacheCreateTokens: 0 };
}

function firstNumber() {
  for (let i = 0; i < arguments.length; i++) {
    const n = Number(arguments[i]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function extractUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return emptyUsageTokens();
  const inputTokens = firstNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.inputTokens,
    usage.input_token_count,
    usage.inputTokenCount
  );
  const outputTokens = firstNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.outputTokens,
    usage.output_token_count,
    usage.outputTokenCount,
    usage.candidates_token_count
  );
  const totalTokens = firstNumber(
    usage.total_tokens,
    usage.totalTokens,
    usage.total_token_count,
    usage.totalTokenCount,
    inputTokens + outputTokens
  );
  const promptDetails = usage.prompt_tokens_details || usage.input_tokens_details || usage.promptTokensDetails || usage.inputTokensDetails || {};
  const cacheDetails = usage.cache_tokens_details || usage.cached_tokens_details || usage.cacheTokensDetails || usage.cachedTokensDetails || {};
  const outputDetails = usage.completion_tokens_details || usage.output_tokens_details || usage.completionTokensDetails || usage.outputTokensDetails || {};
  const cacheTokens = firstNumber(
    usage.cached_tokens,
    usage.cache_tokens,
    usage.cachedTokens,
    usage.cacheTokens,
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cached_content_token_count,
    usage.cachedContentTokenCount,
    promptDetails.cached_tokens,
    promptDetails.cache_tokens,
    promptDetails.cachedTokens,
    promptDetails.cacheTokens,
    promptDetails.cache_read_input_tokens,
    promptDetails.cacheReadInputTokens,
    promptDetails.cached_content_token_count,
    promptDetails.cachedContentTokenCount,
    cacheDetails.cached_tokens,
    cacheDetails.cache_tokens,
    cacheDetails.cachedTokens,
    cacheDetails.cacheTokens,
    cacheDetails.cache_read_input_tokens,
    cacheDetails.cacheReadInputTokens,
    outputDetails.cached_tokens,
    outputDetails.cache_tokens,
    outputDetails.cachedTokens,
    outputDetails.cacheTokens
  );
  const cacheCreateTokens = firstNumber(
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cache_creation_tokens,
    usage.cacheCreationTokens,
    promptDetails.cache_creation_input_tokens,
    promptDetails.cacheCreationInputTokens,
    promptDetails.cache_creation_tokens,
    promptDetails.cacheCreationTokens,
    cacheDetails.cache_creation_input_tokens,
    cacheDetails.cacheCreationInputTokens,
    cacheDetails.cache_creation_tokens,
    cacheDetails.cacheCreationTokens,
    outputDetails.cache_creation_input_tokens,
    outputDetails.cacheCreationInputTokens,
    outputDetails.cache_creation_tokens,
    outputDetails.cacheCreationTokens
  );
  return { inputTokens, outputTokens, totalTokens, cacheTokens, cacheCreateTokens };
}

function extractUsageFromSSEData(dataText) {
  if (!dataText || dataText === '[DONE]') return null;
  try {
    const data = JSON.parse(dataText);
    if (data && data.usage) return extractUsageTokens(data.usage);
    // Responses API: usage in data.response.usage
    if (data && data.response && data.response.usage) return extractUsageTokens(data.response.usage);
  } catch {}
  return null;
}

function processSSETextForUsage(text, currentUsage) {
  let usage = currentUsage || emptyUsageTokens();
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const dataText = line.slice(5).trim();
    const parsed = extractUsageFromSSEData(dataText);
    if (parsed) usage = parsed;
  }
  return usage;
}

function wrapStreamWithFinalize(body, onFinalize) {
  const zeroUsage = emptyUsageTokens();
  if (!body) {
    try { onFinalize && onFinalize(zeroUsage); } catch {}
    return body;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pendingText = '';
  let usage = zeroUsage;
  let finalized = false;

  async function finalize() {
    if (finalized) return;
    finalized = true;
    try {
      const tail = decoder.decode();
      if (tail) pendingText += tail;
      if (pendingText) usage = processSSETextForUsage(pendingText, usage);
    } catch {}
    try { if (onFinalize) await onFinalize(usage); } catch {}
  }

  function observeChunk(value) {
    try {
      pendingText += decoder.decode(value, { stream: true });
      const parts = pendingText.split(/\r?\n/);
      pendingText = parts.pop() || '';
      usage = processSSETextForUsage(parts.join('\n'), usage);
    } catch {}
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finalize();
          controller.close();
          return;
        }
        observeChunk(value);
        controller.enqueue(value);
      } catch (err) {
        await finalize();
        controller.error(err);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
      await finalize();
    },
  });
}

function wrapStreamWithConcurrencyRelease(body) {
  if (!body) { return body; }

  const reader = body.getReader();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    },
  });
}

// ===================== 工具函数 =====================

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function isAccountEnabled(acct) {
  return acct.enabled !== false;
}

function normalizePriority(acct) {
  const p = Number(acct.priority);
  return Number.isFinite(p) && p >= 1 ? Math.trunc(p) : 1;
}

function normalizeWeight(acct) {
  const w = Number(acct.weight);
  if (!Number.isFinite(w) || w < 1) return 1;
  return Math.min(10, Math.trunc(w));
}

function normalizeMaxConcurrency(acct) {
  const v = Number(acct.max_concurrency);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.trunc(v);
}

// ---- 池模式辅助函数 ----

function normalizePoolRetryCount(acct) {
  const v = Number(acct.pool_mode_retry_count);
  if (!Number.isFinite(v) || v < 0) return 3;
  if (v > 10) return 10;
  return Math.trunc(v);
}

function normalizePoolRetryStatuses(acct) {
  if (Array.isArray(acct.pool_retry_statuses)) {
    const arr = acct.pool_retry_statuses.filter(function(s) {
      return Number.isFinite(Number(s));
    });
    if (arr.length > 0) return arr.map(function(s) { return Number(s); });
  }
  return [401, 403, 429];
}

function isPoolMode(acct) {
  return acct.pool_mode === true;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function buildTargetUrl(baseUrl, requestPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return requestPath;

  // 如果 base_url 已经填到具体端点，直接使用，避免重复拼接。
  if (requestPath.endsWith('/chat/completions') && base.endsWith('/chat/completions')) return base;
  if (requestPath.endsWith('/v1/messages') && base.endsWith('/v1/messages')) return base;
  if (requestPath.endsWith('/embeddings') && base.endsWith('/embeddings')) return base;
  if (!requestPath.endsWith('/chat/completions') && requestPath.endsWith('/completions') && base.endsWith('/completions')) return base;

  // 兼容 /v1/* 与 /v3/*：base_url 如果已经带 /v1 或 /v3，先去掉版本，再按请求路径拼接。
  if (/\/v\d+$/.test(base) && /^\/v\d+\//.test(requestPath)) {
    return base.replace(/\/v\d+$/, '') + requestPath;
  }

  return base + requestPath;
}

// ===================== Anthropic ↔ OpenAI 格式转换 =====================

// OpenAI 请求体 → Anthropic 请求体
function openaiToAnthropicRequest(body) {
  // 0. 克隆全部字段，再逐一修正/删除
  var anthropicBody = {};
  // 先复制顶层所有可枚举属性（不含原型链）
  for (var key in body) {
    if (body.hasOwnProperty(key)) {
      anthropicBody[key] = body[key];
    }
  }

  // 1. 提取 system 消息，放到顶层 system 字段
  const systemMsgs = (body.messages || []).filter(function(m) { return m.role === 'system'; });
  const systemText = systemMsgs.map(function(m) {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      // 处理多模态数组格式，只提取 text 类型的 content
      return m.content.filter(function(p) { return p.type === 'text'; }).map(function(p) { return p.text || ''; }).join('\n');
    }
    return '';
  }).filter(Boolean).join('\n');
  if (systemText) {
    // 使用数组格式以便添加 cache_control 标记（触发 Prompt Caching）
    anthropicBody.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
  }

  // 2. 过滤 system 消息，保留其他消息，并逐条转换
  var messages = (body.messages || []).filter(function(m) { return m.role !== 'system'; });
  messages = messages.map(function(msg) {
    // tool 角色 → user 角色 + tool_result 内容块
    if (msg.role === 'tool') {
      var toolContent = [];
      var resultContent = (msg.content !== null && msg.content !== undefined)
        ? msg.content : '';
      if (typeof resultContent === 'string') {
        toolContent.push({ type: 'tool_result', tool_use_id: msg.tool_call_id, content: resultContent });
      } else if (Array.isArray(resultContent)) {
        toolContent.push({ type: 'tool_result', tool_use_id: msg.tool_call_id, content: resultContent });
      } else {
        toolContent.push({ type: 'tool_result', tool_use_id: msg.tool_call_id, content: String(resultContent) });
      }
      return { role: 'user', content: toolContent };
    }

    // assistant 消息含 tool_calls → content 数组中插入 tool_use 块
    if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      var aContent = [];
      if (msg.content) {
        aContent.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      }
      for (var ti = 0; ti < msg.tool_calls.length; ti++) {
        var tc = msg.tool_calls[ti];
        var tcInput = {};
        try { tcInput = JSON.parse(tc.function.arguments); } catch(e) { tcInput = {}; }
        aContent.push({ type: 'tool_use', id: tc.id || ('toolu_' + ti), name: tc.function.name, input: tcInput });
      }
      return { role: 'assistant', content: aContent };
    }

    // 图片消息
    if (Array.isArray(msg.content)) {
      return { role: msg.role, content: msg.content.map(function(part) {
        if (part && part.type === 'image_url') {
          var url = part.image_url && part.image_url.url || '';
          var isBase64 = url.indexOf(';base64,') > 0;
          if (isBase64) {
            var parts = url.split(';base64,');
            var mediaType = parts[0].replace('data:', '') || 'image/png';
            return { type: 'image', source: { type: 'base64', media_type: mediaType, data: parts[1] } };
          }
          return { type: 'text', text: url };
        }
        return part;
      })};
    }
    return msg;
  });
  anthropicBody.messages = messages;

  // 2b. 给最后 2 条消息添加 cache_control 标记（触发 Prompt Caching）
  var cacheMsgCount = Math.min(2, messages.length);
  for (var ci = messages.length - cacheMsgCount; ci < messages.length; ci++) {
    var msg = messages[ci];
    if (typeof msg.content === 'string') {
      // 字符串 → 数组格式 + cache_control
      msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      // 数组 → 给最后一个 text/image block 添加 cache_control
      for (var bi = msg.content.length - 1; bi >= 0; bi--) {
        var block = msg.content[bi];
        if (block.type === 'text' || block.type === 'image') {
          block.cache_control = { type: 'ephemeral' };
          break;
        }
      }
    }
  }

  // 3. max_tokens / max_completion_tokens 归一化
  if (anthropicBody.max_completion_tokens !== undefined) {
    if (anthropicBody.max_tokens === undefined) {
      anthropicBody.max_tokens = anthropicBody.max_completion_tokens;
    }
    delete anthropicBody.max_completion_tokens;
  }
  // Anthropic 的 max_tokens 是必填字段，给个合理的默认值
  if (anthropicBody.max_tokens === undefined) {
    anthropicBody.max_tokens = 8192;
  }

  // 4. tools 转换：OpenAI function 格式 → Anthropic input_schema 格式
  if (anthropicBody.tools && Array.isArray(anthropicBody.tools)) {
    anthropicBody.tools = anthropicBody.tools.map(function(t) {
      if (t.type === 'function') {
        return { name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } };
      }
      return t;
    });
  }

  // 5. tool_choice 转换
  if (anthropicBody.tool_choice !== undefined) {
    if (typeof anthropicBody.tool_choice === 'string') {
      anthropicBody.tool_choice = { type: anthropicBody.tool_choice };
    } else if (typeof anthropicBody.tool_choice === 'object') {
      if (anthropicBody.tool_choice.type === 'function' && anthropicBody.tool_choice.function) {
        anthropicBody.tool_choice = { type: 'tool', name: anthropicBody.tool_choice.function.name };
      }
      // 其他格式（如 {type:"tool","name":"..."}）保持不变
    }
  }

  // 6. stop → stop_sequences
  if (anthropicBody.stop !== undefined) {
    anthropicBody.stop_sequences = Array.isArray(anthropicBody.stop) ? anthropicBody.stop : [anthropicBody.stop];
    delete anthropicBody.stop;
  }

  // 7. enable_thinking → thinking 转换（通义千问等模型用 enable_thinking，Anthropic 用 thinking）
  if (anthropicBody.enable_thinking !== undefined) {
    if (anthropicBody.enable_thinking === true) {
      anthropicBody.thinking = { type: 'enabled' };
      // Anthropic 要求 thinking 时必须有 budget_tokens，从 max_tokens 推算
      if (anthropicBody.max_tokens) {
        // budget_tokens 要求：>= 1024，且严格 < max_tokens
        var budget = Math.min(Math.floor(anthropicBody.max_tokens * 0.8), 16384);
        budget = Math.max(budget, 1024);
        if (budget >= anthropicBody.max_tokens) {
          budget = anthropicBody.max_tokens - 1;
        }
        if (budget >= 1024) {
          anthropicBody.thinking.budget_tokens = budget;
        } else {
          // max_tokens 太小无法启用 thinking，降级为 disabled
          anthropicBody.thinking = { type: 'disabled' };
        }
      } else {
        anthropicBody.thinking.budget_tokens = 16384;
      }
    } else if (anthropicBody.enable_thinking === false) {
      anthropicBody.thinking = { type: 'disabled' };
    }
    delete anthropicBody.enable_thinking;
  }

  // 7b. 如果启用了 thinking，强制 temperature = 1（Anthropic 要求）
  if (anthropicBody.thinking && anthropicBody.thinking.type === 'enabled') {
    anthropicBody.temperature = 1;
  }

  // 7c. reasoning_effort → Anthropic thinking 参数（不在删除列表中删除，而是转换）
  if (anthropicBody.reasoning_effort !== undefined) {
    var budgetMap = { low: 1024, medium: 4096, high: 16384, xhigh: 32768 };
    var budget = budgetMap[anthropicBody.reasoning_effort] || 4096;
    // 不覆盖已有的 thinking（来自 enable_thinking）
    if (!anthropicBody.thinking || anthropicBody.thinking.type === 'disabled') {
      anthropicBody.thinking = { type: 'enabled', budget_tokens: budget };
    }
    delete anthropicBody.reasoning_effort;
  }

  // 8. 删除 OpenAI 专有、Anthropic 不认识的字段
  var openaiOnly = ['stream_options', 'frequency_penalty', 'presence_penalty', 'logit_bias',
    'user', 'n', 'seed', 'response_format', 'parallel_tool_calls'];
  for (var oi = 0; oi < openaiOnly.length; oi++) {
    delete anthropicBody[openaiOnly[oi]];
  }

  return anthropicBody;
}

// Anthropic 非流式响应体 → OpenAI 非流式响应体
function anthropicToOpenaiResponse(anthropicBody) {
  var content = anthropicBody.content || [];
  // 分离 text 和 thinking 内容
  var textOnly = content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text || ''; }).join('');
  var thinkingOnly = content.filter(function(c) { return c.type === 'thinking'; }).map(function(c) { return c.thinking || ''; }).join('');
  var toolUseContent = content.filter(function(c) { return c.type === 'tool_use'; });

  // 【Fix 5】提取 thinking 块的 signature（多轮 thinking 对话必需）
  var thinkingSignature = '';
  var thinkingBlocks = content.filter(function(c) { return c.type === 'thinking'; });
  for (var ti = 0; ti < thinkingBlocks.length; ti++) {
    if (thinkingBlocks[ti].signature) {
      thinkingSignature = thinkingBlocks[ti].signature;
    }
  }

  var finishMap = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' };
  var finishReason = finishMap[anthropicBody.stop_reason] || anthropicBody.stop_reason || 'stop';

  var usageInputTokens = (anthropicBody.usage && anthropicBody.usage.input_tokens) || 0;
  var usageOutputTokens = (anthropicBody.usage && anthropicBody.usage.output_tokens) || 0;

  var openaiResp = {
    id: anthropicBody.id || ('chatcmpl-' + Date.now()),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicBody.model || '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: textOnly || null },
      finish_reason: finishReason,
      logprobs: null,
    }],
    usage: {
      prompt_tokens: usageInputTokens,
      completion_tokens: usageOutputTokens,
      // 【Fix 14】安全计算 total_tokens，避免 NaN
      total_tokens: usageInputTokens + usageOutputTokens,
      // Anthropic 缓存字段转换（使用 extractUsage 能识别的字段名）
      cached_tokens: (anthropicBody.usage && anthropicBody.usage.cache_read_input_tokens) || 0,
      cache_creation_input_tokens: (anthropicBody.usage && anthropicBody.usage.cache_creation_input_tokens) || 0,
    }
  };

  // 如果有 thinking 内容，添加 reasoning_content 字段（DeepSeek 等模型用此格式）
  if (thinkingOnly) {
    openaiResp.choices[0].message.reasoning_content = thinkingOnly;
  }

  // 【Fix 5】如果 thinking 块有 signature，传递到 message 中
  if (thinkingSignature) {
    openaiResp.choices[0].message.reasoning_content_signature = thinkingSignature;
  }

  // tool_use 内容 → tool_calls
  if (toolUseContent.length > 0) {
    openaiResp.choices[0].message.tool_calls = toolUseContent.map(function(tc, i) {
      return { id: tc.id || ('call_' + i), type: 'function', "function": { name: tc.name || '', "arguments": tc.input ? JSON.stringify(tc.input) : '{}' } };
    });
    openaiResp.choices[0].message.content = null;
  }

  return openaiResp;
}

// Anthropic 流式 SSE → OpenAI 流式 SSE（返回 ReadableStream）
function createAnthropicStreamTransformer(upstreamBody, onFinalize) {
  var reader = upstreamBody.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var finalized = false;
  var usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheTokens: 0, cacheCreateTokens: 0 };
  var msgInputTokens = 0;
  var textAccumulator = '';
  var currentToolCall = null;
  var snapshotIndex = 0;
  // 【Fix 6/7】跟踪 thinking 块的 signature（多轮 thinking 对话必需）
  var pendingThinkingSignature = '';

  async function finalize() {
    if (finalized) return;
    finalized = true;
    try { if (onFinalize) await onFinalize(usage); } catch {}
  }

  // 解析 Anthropic SSE（event: xxx\ndata: xxx\n\n）
  function parseSSEBuffer(buf) {
    var events = [];
    var parts = buf.split('\n\n');
    for (var i = 0; i < parts.length - 1; i++) {
      var block = parts[i].trim();
      if (!block) continue;
      var eventName = '';
      var dataText = '';
      var lines = block.split('\n');
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataText = line.slice(6).trim();
      }
      if (dataText) events.push({ event: eventName, data: dataText });
    }
    return { events: events, remainder: parts[parts.length - 1] || '' };
  }

  // 单个 Anthropic 事件 → OpenAI SSE 行数组
  function anthropicEventToOpenaiLines(eventObj) {
    var lines = [];
    try {
      var parsed = JSON.parse(eventObj.data);
    } catch (e) {
      return lines;
    }
    switch (eventObj.event) {
      case 'message_start': {
        var msg = parsed.message || {};
        msgInputTokens = (msg.usage && msg.usage.input_tokens) || 0;
        // 【Fix 13】message_start 时就赋值 inputTokens，不要等到 message_delta
        usage.inputTokens = msgInputTokens;
        // 提取 Anthropic 缓存字段
        if (msg.usage) {
          usage.cacheTokens = msg.usage.cache_read_input_tokens || 0;
          usage.cacheCreateTokens = msg.usage.cache_creation_input_tokens || 0;
        }
        lines.push('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' }, index: 0 }] }));
        break;
      }
      case 'content_block_start': {
        var cb = parsed.content_block || {};
        if (cb.type === 'tool_use') {
          currentToolCall = { id: cb.id || ('call_' + snapshotIndex), name: cb.name || '', args: '' };
          lines.push('data: ' + JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: snapshotIndex, id: currentToolCall.id, type: 'function', "function": { name: currentToolCall.name, "arguments": '' } }] } }]
          }));
          snapshotIndex++;
        }
        break;
      }
      case 'content_block_delta': {
        var delta = parsed.delta || {};
        if (delta.type === 'text_delta') {
          var text = delta.text || '';
          textAccumulator += text;
          lines.push('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] }));
        } else if (delta.type === 'thinking_delta') {
          var thinkText = delta.thinking || '';
          textAccumulator += thinkText;
          // 【Fix 6】提取 thinking_delta 中的 signature
          if (delta.signature) {
            pendingThinkingSignature = delta.signature;
          }
          // 发送 reasoning_content 字段（DeepSeek 等模型用此格式）
          lines.push('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: thinkText }, index: 0 }] }));
        } else if (delta.type === 'input_json_delta') {
          var partialJson = delta.partial_json || '';
          if (currentToolCall) currentToolCall.args += partialJson;
          lines.push('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: snapshotIndex - 1, "function": { "arguments": partialJson } }] } }] }));
        } else if (delta.type === 'signature_delta') {
          // signature_delta：Anthropic 单独发送 thinking signature 的事件
          if (delta.signature) {
            pendingThinkingSignature = delta.signature;
          }
        }
        break;
      }
      case 'content_block_stop': {
        // 【Fix 7】如果是 thinking 块结束（不在 tool_use 中），发送 signature
        if (!currentToolCall && pendingThinkingSignature) {
          lines.push('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content_signature: pendingThinkingSignature }, index: 0 }] }));
          pendingThinkingSignature = '';
        }
        if (currentToolCall) currentToolCall = null;
        break;
      }
      case 'message_delta': {
        var msgDelta = parsed.delta || {};
        var msgUsage = parsed.usage || {};
        usage.inputTokens = msgInputTokens;
        usage.outputTokens = msgUsage.output_tokens || 0;
        usage.totalTokens = msgInputTokens + usage.outputTokens;
        var finishMap = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' };
        var fr = finishMap[msgDelta.stop_reason] || msgDelta.stop_reason || 'stop';
        var finishData = { choices: [{ delta: {}, finish_reason: fr, index: 0 }] };
        finishData.usage = { 
          prompt_tokens: usage.inputTokens, 
          completion_tokens: usage.outputTokens, 
          total_tokens: usage.totalTokens,
          cached_tokens: usage.cacheTokens || 0,
          cache_creation_input_tokens: usage.cacheCreateTokens || 0
        };
        lines.push('data: ' + JSON.stringify(finishData));
        break;
      }
      case 'message_stop': {
        lines.push('data: [DONE]');
        break;
      }
    }
    return lines;
  }

  // 用 start 替代 pull：一次性读取上游所有数据，避免 pull 背压问题
  return new ReadableStream({
    start: function(controller) {
      (async function() {
        try {
          while (true) {
            var result = await reader.read();
            if (result.done) {
              // 处理 buffer 中残余数据
              if (buffer.trim()) {
                var parsed = parseSSEBuffer(buffer + '\n\n');
                for (var e = 0; e < parsed.events.length; e++) {
                  var oaiLines = anthropicEventToOpenaiLines(parsed.events[e]);
                  for (var l = 0; l < oaiLines.length; l++) {
                    controller.enqueue(new TextEncoder().encode(oaiLines[l] + '\n\n'));
                  }
                }
              }
              await finalize();
              controller.close();
              return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            var parsed = parseSSEBuffer(buffer);
            buffer = parsed.remainder;
            for (var e = 0; e < parsed.events.length; e++) {
              var oaiLines = anthropicEventToOpenaiLines(parsed.events[e]);
              for (var l = 0; l < oaiLines.length; l++) {
                controller.enqueue(new TextEncoder().encode(oaiLines[l] + '\n\n'));
              }
            }
          }
        } catch (err) {
          await finalize();
          controller.error(err);
        }
      })();
    },
    cancel: function(reason) {
      finalized = true;
      try { reader.cancel(reason); } catch {}
    }
  });
}

// 按 priority 从小到大分组，1 最优先
function groupByPriority(accounts) {
  const map = {};
  for (const acct of accounts) {
    const p = normalizePriority(acct);
    if (!map[p]) map[p] = [];
    map[p].push(acct);
  }
  const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
  return keys.map(k => map[k]);
}

// 加权无放回随机生成尝试顺序（weight<=0 时按 1 处理）
function weightedShuffle(accounts) {
  // Efraimidis-Spirakis 加权无放回抽样：权重越大，越容易排在前面。
  // 相比按权重展开数组，不会因为用户填了极大 weight 而浪费内存。
  return accounts
    .map(acct => {
      const w = normalizeWeight(acct);
      const u = Math.max(Number.EPSILON, Math.random());
      return { acct, score: Math.log(u) / w };
    })
    .sort((a, b) => b.score - a.score)
    .map(item => item.acct);
}

// 查找上游账号是否支持某个模型，返回映射后的上游模型名（或原模型名）
// 返回 null 表示不支持
function findMappedModel(account, clientModel) {
  const lowerClient = clientModel.toLowerCase();

  // 先检查 model_map。显式映射优先，避免 models 里也写了客户端名时映射失效。
  if (account.model_map) {
    for (const [key, val] of Object.entries(account.model_map)) {
      if (key.toLowerCase() === lowerClient) {
        return val; // 返回映射后的上游模型名
      }
    }
  }

  // 再检查 models 列表（直接支持，使用原始模型名）
  if (Array.isArray(account.models) && account.models.some(m => String(m).toLowerCase() === lowerClient)) {
    return clientModel;
  }

  return null; // 不支持
}

// 归一化 model_map，过滤空值，返回干净的对象
function normalizeModelMap(mm) {
  if (!mm || typeof mm !== 'object' || Array.isArray(mm)) return {};
  const result = {};
  for (const [key, val] of Object.entries(mm)) {
    const k = String(key).trim();
    const v = String(val).trim();
    if (k && v) {
      result[k] = v;
    }
  }
  return result;
}

// ===================== 账号认证 =====================

// ===================== 账号 KV 存取 =====================

async function loadAccounts() {
  const now = Date.now();
  if (cachedAccounts !== null && (now - cachedAccountsAt) < ACCOUNTS_CACHE_TTL * 1000) {
    return cachedAccounts;
  }
  try {
    let data = kvGetJSON(KV_KEY_ACCOUNTS);

    // 过滤掉损坏的账号（缺少 base_url 或 models，或启用但无 api_key）
    if (Array.isArray(data)) {
      data = data.filter(function(a) { return a.base_url && a.models && (a.enabled === false || a.api_key); });
    }

    cachedAccounts = Array.isArray(data) ? data : [];
    cachedAccountsAt = now;
    return cachedAccounts;
  } catch {
    cachedAccounts = [];
    cachedAccountsAt = now;
    return [];
  }
}

async function saveAccounts(accounts) {
  kvPutJSON(KV_KEY_ACCOUNTS, accounts);
  cachedAccounts = null;
  cachedAccountsAt = 0;
}

// ===================== 使用记录 =====================

function makeUsageLogEntry(upstreamAccount, requestedModel, upstreamModel,
  inputTokens, outputTokens, totalTokens, cacheTokens, cacheCreateTokens, durationMs, status, isStream, error,
  request, ua, ip, consumedUnits) {

  const id = genId();
  const acctId = upstreamAccount ? upstreamAccount.id : '';
  const acctName = upstreamAccount ? upstreamAccount.name : '';
  // prompt_tokens 通常包含 cached_tokens，减去避免重复计算
  const adjustedInput = Math.max(0, (inputTokens || 0) - (cacheTokens || 0));
  return {
    id: id,
    request_id: id,
    account_id: acctId,
    account_name: acctName,
    channel_id: acctId,
    channel_name: acctName,
    model: requestedModel || '',
    requested_model: requestedModel || '',
    upstream_model: upstreamModel || '',
    status: status || 0,
    duration_ms: durationMs || 0,
    stream: isStream || false,
    input_tokens: adjustedInput,
    output_tokens: outputTokens || 0,
    total_tokens: totalTokens || 0,
    cache_tokens: cacheTokens || 0,
    cache_create_tokens: cacheCreateTokens || 0,
    consumed: Number(consumedUnits || 0),
    created_at: new Date().toISOString(),
    user_agent: ua || '',
    ip_address: ip || '',
    error: error || '',
  };
}

async function flushStatsBuffer() {
  const acc = statsAccumulator;
  if (acc.total === 0 && Object.keys(acc.accounts).length === 0) return;
  try {
    let existing = {};
    try { existing = kvGetJSON(KV_KEY_USAGE_STATS) || {}; } catch {}
    if (!existing.accounts) existing.accounts = {};
    if (!existing.models) existing.models = {};
    existing.total = (existing.total || 0) + acc.total;
    existing.success = (existing.success || 0) + acc.success;
    existing.fail = (existing.fail || 0) + acc.fail;
    for (const [name, d] of Object.entries(acc.accounts)) {
      if (!existing.accounts[name]) existing.accounts[name] = STATS_ACC_EMPTY();
      existing.accounts[name].count += d.count;
      existing.accounts[name].input += d.input;
      existing.accounts[name].output += d.output;
      existing.accounts[name].cache += d.cache;
      existing.accounts[name].cache_create += (d.cache_create || 0);
      existing.accounts[name].consumed += d.consumed;
    }
    for (const [name, d] of Object.entries(acc.models)) {
      if (!existing.models[name]) existing.models[name] = STATS_ACC_EMPTY();
      existing.models[name].count += d.count;
      existing.models[name].input += d.input;
      existing.models[name].output += d.output;
      existing.models[name].cache += d.cache;
      existing.models[name].cache_create += (d.cache_create || 0);
      existing.models[name].consumed += d.consumed;
    }
    kvPutJSON(KV_KEY_USAGE_STATS, existing);
    statsAccumulator = { accounts: {}, models: {}, total: 0, success: 0, fail: 0 };
  } catch (err) {
    console.error('flushStatsBuffer error:', err);
  }
}

async function flushDailyStatsBuffer() {
  const acc = dailyStatsAccumulator;
  if (acc.total === 0 && Object.keys(acc.accounts).length === 0) return;
  try {
    const today = getBeijingDate();
    let existing = {};
    try { existing = kvGetJSON(KV_KEY_USAGE_DAILY_STATS) || {}; } catch {}
    if (existing.date !== today) {
      existing = { date: today, accounts: {}, models: {}, total: 0, success: 0, fail: 0 };
    }
    existing.total = (existing.total || 0) + acc.total;
    existing.success = (existing.success || 0) + acc.success;
    existing.fail = (existing.fail || 0) + acc.fail;
    for (const [name, d] of Object.entries(acc.accounts)) {
      if (!existing.accounts[name]) existing.accounts[name] = STATS_ACC_EMPTY();
      existing.accounts[name].count += d.count;
      existing.accounts[name].input += d.input;
      existing.accounts[name].output += d.output;
      existing.accounts[name].cache += d.cache;
      existing.accounts[name].cache_create += (d.cache_create || 0);
      existing.accounts[name].consumed += d.consumed;
    }
    for (const [name, d] of Object.entries(acc.models)) {
      if (!existing.models[name]) existing.models[name] = STATS_ACC_EMPTY();
      existing.models[name].count += d.count;
      existing.models[name].input += d.input;
      existing.models[name].output += d.output;
      existing.models[name].cache += d.cache;
      existing.models[name].cache_create += (d.cache_create || 0);
      existing.models[name].consumed += d.consumed;
    }
    kvPutJSON(KV_KEY_USAGE_DAILY_STATS, existing);
    dailyStatsAccumulator = { accounts: {}, models: {}, total: 0, success: 0, fail: 0 };
  } catch (err) {
    console.error('flushDailyStatsBuffer error:', err);
  }
}

async function flushMonthlyStatsBuffer() {
  const acc = monthlyStatsAccumulator;
  const keys = Object.keys(acc);
  if (keys.length === 0) return;
  try {
    let existing = {};
    try { existing = kvGetJSON(KV_KEY_USAGE_MONTHLY_STATS) || {}; } catch {}
    for (const monthKey of keys) {
      if (!existing[monthKey]) existing[monthKey] = { total: 0, success: 0, fail: 0, daily: {} };
      existing[monthKey].total += acc[monthKey].total;
      existing[monthKey].success += acc[monthKey].success;
      existing[monthKey].fail += acc[monthKey].fail;
      for (const [day, count] of Object.entries(acc[monthKey].daily)) {
        existing[monthKey].daily[day] = (existing[monthKey].daily[day] || 0) + count;
      }
    }
    kvPutJSON(KV_KEY_USAGE_MONTHLY_STATS, existing);
    monthlyStatsAccumulator = {};
  } catch (err) {
    console.error('flushMonthlyStatsBuffer error:', err);
  }
}



// ==================== Node.js HTTP 服务器 ====================
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
    });
    const response = await handleRequest(request);
    const resHeaders = {};
    response.headers.forEach((v, k) => { resHeaders[k] = v; });
    res.writeHead(response.status, resHeaders);
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`LLM-APIs 本地运行: http://localhost:${PORT}`);
  console.log(`管理后台: http://localhost:${PORT}/admin`);
  console.log(`更新代码后关闭窗口再点桌面 opencode.bat 重启`);
});
