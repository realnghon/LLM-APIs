'use strict';

const crypto = require('crypto');
const { mapConcurrent, testAccount } = require('./upstream/ai-sdk-client');

const DEFAULT_SETTINGS = Object.freeze({ enabled: true, interval_minutes: 5 });

function cleanSettings(input = {}, existing = DEFAULT_SETTINGS) {
  const minutes = Number(input.interval_minutes ?? existing.interval_minutes);
  return {
    enabled: input.enabled === undefined ? existing.enabled !== false : input.enabled !== false,
    interval_minutes: Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.trunc(minutes))) : 5,
  };
}

function createMemoryStatusRepository() {
  let settings = { ...DEFAULT_SETTINGS };
  const snapshots = [];
  return {
    async getSettings() { return { ...settings }; },
    async saveSettings(value) { settings = { ...value }; return { ...settings }; },
    async listSnapshots() { return snapshots.slice(); },
    async addSnapshot(snapshot) { snapshots.unshift(snapshot); snapshots.length = Math.min(snapshots.length, 288); },
    async removeAccountResults(accountId) {
      for (const snapshot of snapshots) {
        const results = Array.isArray(snapshot.results) ? snapshot.results : [];
        snapshot.results = results.filter(result => result.account_id !== accountId);
      }
    },
    async reconcileAccountResults(accountId, targetKeys) {
      const allowed = new Set(targetKeys);
      for (const snapshot of snapshots) snapshot.results = (snapshot.results || [])
        .filter(result => result.account_id !== accountId || allowed.has(result.target_key || `direct:${result.model}`));
    },
  };
}

function createStatusMonitor({ accountRepository, statusRepository, testAccountFn = testAccount }) {
  let timer = null;
  let running = null;
  let settings = { ...DEFAULT_SETTINGS };

  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    if (!settings.enabled) return;
    timer = setInterval(() => {
      run().catch(error => console.error(`[LLM-APIs] scheduled status check failed: ${error.message}`));
    }, settings.interval_minutes * 60_000);
    timer.unref?.();
  }

  const ready = statusRepository.getSettings().then(stored => {
    settings = cleanSettings(stored);
    schedule();
  });

  async function run() {
    await ready;
    if (running) return running;
    running = (async () => {
      const accounts = (await accountRepository.list()).filter(account => account.enabled !== false);
      const nested = await mapConcurrent(accounts, 4, async account => {
        const results = await testAccountFn(account);
        return results.map(result => ({
          account_id: account.id,
          account_name: account.name,
          target_key: result.target_key || (String(result.label || '').includes('→')
            ? `map:${String(result.label).split('→')[0].trim()}` : `direct:${result.model}`),
          model: result.model,
          label: result.label,
          ok: result.ok === true,
          status: Number(result.status || 0),
          latency_ms: Number(result.latency_ms || 0),
          error: result.error || '',
        }));
      });
      const snapshot = {
        id: `status_${crypto.randomUUID()}`,
        checked_at: new Date().toISOString(),
        results: nested.flat(),
      };
      const currentAccounts = await accountRepository.list();
      const currentTargets = new Map(currentAccounts.filter(account => account.enabled !== false).map(account => [account.id, new Set([
        ...(account.models || []).map(model => `direct:${model}`),
        ...Object.keys(account.model_map || {}).map(model => `map:${model}`),
      ])]));
      snapshot.results = snapshot.results.filter(result => currentTargets.get(result.account_id)?.has(result.target_key));
      await statusRepository.addSnapshot(snapshot);
      return snapshot;
    })();
    try { return await running; } finally { running = null; }
  }

  return {
    async getState() {
      await ready;
      return { settings: { ...settings }, snapshots: await statusRepository.listSnapshots(), running: running !== null };
    },
    async configure(input) {
      await ready;
      settings = cleanSettings(input, settings);
      await statusRepository.saveSettings(settings);
      schedule();
      return { ...settings };
    },
    run,
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function response(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function createStatusHandler(monitor) {
  return async function handleStatus(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/admin/status')) return null;

    if (url.pathname === '/admin/status' && request.method === 'GET') {
      return response({ success: true, ...(await monitor.getState()) });
    }
    if (url.pathname === '/admin/status/run' && request.method === 'POST') {
      return response({ success: true, snapshot: await monitor.run() });
    }
    if (url.pathname === '/admin/status/settings' && request.method === 'POST') {
      const settings = await monitor.configure(await request.json());
      return response({ success: true, settings });
    }
    return response({ success: false, error: 'Not found' }, 404);
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  cleanSettings,
  createMemoryStatusRepository,
  createStatusHandler,
  createStatusMonitor,
};
