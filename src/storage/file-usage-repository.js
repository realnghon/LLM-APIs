'use strict';

const fs = require('fs/promises');
const path = require('path');
const { waitForFile } = require('./file-lock');

function decode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createFileUsageRepository(dataFile, options = {}) {
  const extension = path.extname(dataFile);
  const usageFile = options.usageFile || path.join(
    path.dirname(dataFile),
    `${path.basename(dataFile, extension)}.usage.ndjson`,
  );
  const retention = positiveInteger(options.retention ?? process.env.USAGE_RETENTION, 100_000);
  const compactAfter = Math.min(5_000, Math.max(100, Math.ceil(retention * 0.05)));
  let logs = null;
  let loadPromise = null;
  let writeQueue = Promise.resolve();
  let staleLines = 0;

  async function replaceFile(entries) {
    await fs.mkdir(path.dirname(usageFile), { recursive: true });
    const temporary = `${usageFile}.${process.pid}.${Date.now()}.tmp`;
    const chronological = entries.slice().reverse();
    const content = chronological.map(entry => JSON.stringify(entry)).join('\n');
    await fs.writeFile(temporary, content ? `${content}\n` : '');
    await fs.rename(temporary, usageFile);
  }

  async function loadLegacyLogs() {
    await waitForFile(dataFile);
    try {
      const document = JSON.parse(await fs.readFile(dataFile, 'utf8'));
      const legacy = decode(document.usage_logs, []);
      return Array.isArray(legacy) ? legacy.slice(0, retention) : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function load() {
    if (logs) return logs;
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const content = await fs.readFile(usageFile, 'utf8');
          logs = content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).reverse().slice(0, retention);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          logs = await loadLegacyLogs();
          if (logs.length) await replaceFile(logs);
        }
        return logs;
      })();
    }
    return loadPromise;
  }

  function enqueue(operation) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => {});
    return result;
  }

  return {
    async list() {
      await load();
      await writeQueue;
      return logs.slice();
    },
    async record(entry) {
      return enqueue(async () => {
        await load();
        await fs.mkdir(path.dirname(usageFile), { recursive: true });
        await fs.appendFile(usageFile, `${JSON.stringify(entry)}\n`);
        logs.unshift(entry);
        if (logs.length > retention) {
          logs.length = retention;
          staleLines += 1;
        }
        if (staleLines >= compactAfter) {
          await replaceFile(logs);
          staleLines = 0;
        }
      });
    },
    async clear() {
      return enqueue(async () => {
        await load();
        logs.length = 0;
        staleLines = 0;
        await replaceFile(logs);
      });
    },
  };
}

module.exports = { createFileUsageRepository };
