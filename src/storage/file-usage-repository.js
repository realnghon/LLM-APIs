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

function monthKey(date) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

function createFileUsageRepository(dataFile, options = {}) {
  const extension = path.extname(dataFile);
  const usageDir = path.dirname(dataFile);
  const baseName = path.basename(dataFile, extension);
  const usageFile = options.usageFile || path.join(usageDir, `${baseName}.usage.ndjson`);
  const archivePattern = new RegExp(`^${baseName}\.usage-(\d{4}-\d{2})\.ndjson$`);
  let logs = null;
  let loadPromise = null;
  let writeQueue = Promise.resolve();
  let lastArchiveCheck = null;

  async function replaceFile(filePath, entries) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const chronological = entries.slice().reverse();
    const content = chronological.map(entry => JSON.stringify(entry)).join('\n');
    await fs.writeFile(temporary, content ? `${content}\n` : '');
    await fs.rename(temporary, filePath);
  }

  async function loadArchiveFile(month) {
    const archiveFile = path.join(usageDir, `${baseName}.usage-${month}.ndjson`);
    try {
      const content = await fs.readFile(archiveFile, 'utf8');
      return content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function listArchiveMonths() {
    try {
      const files = await fs.readdir(usageDir);
      return files
        .map(file => {
          const match = file.match(archivePattern);
          return match ? match[1] : null;
        })
        .filter(Boolean)
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function archiveOldMonths() {
    await load();
    const now = new Date();
    const currentMonth = monthKey(now);
    const byMonth = new Map();
    const currentMonthLogs = [];

    for (const log of logs) {
      const created = new Date(log.created_at);
      if (!Number.isFinite(created.getTime())) {
        currentMonthLogs.push(log);
        continue;
      }
      const month = monthKey(created);
      if (month === currentMonth) {
        currentMonthLogs.push(log);
      } else {
        const bucket = byMonth.get(month) || [];
        bucket.push(log);
        byMonth.set(month, bucket);
      }
    }

    for (const [month, entries] of byMonth) {
      const archiveFile = path.join(usageDir, `${baseName}.usage-${month}.ndjson`);
      const existing = await loadArchiveFile(month);
      const combined = [...existing, ...entries];
      const unique = Array.from(
        new Map(combined.map(entry => [entry.id || entry.request_id, entry])).values(),
      );
      await replaceFile(archiveFile, unique);
    }

    logs = currentMonthLogs;
    await replaceFile(usageFile, logs);
    lastArchiveCheck = now;
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
          if (logs.length) await replaceFile(usageFile, logs);
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
    async list(options = {}) {
      await load();
      await writeQueue;
      
      if (options.includeArchives === false) {
        return logs.slice();
      }

      const months = await listArchiveMonths();
      const archives = await Promise.all(months.map(month => loadArchiveFile(month)));
      const allLogs = [...archives.flat(), ...logs];
      
      if (options.from || options.to) {
        return allLogs.filter(log => {
          const created = log.created_at || '';
          if (options.from && created < options.from) return false;
          if (options.to && created > options.to) return false;
          return true;
        });
      }
      
      return allLogs;
    },
    async record(entry) {
      return enqueue(async () => {
        await load();
        await fs.mkdir(path.dirname(usageFile), { recursive: true });
        await fs.appendFile(usageFile, `${JSON.stringify(entry)}\n`);
        logs.unshift(entry);
        
        const now = new Date();
        const shouldArchive = !lastArchiveCheck || 
          (now.getTime() - lastArchiveCheck.getTime() > 24 * 60 * 60_000);
        
        if (shouldArchive) {
          await archiveOldMonths();
        }
      });
    },
    async clear() {
      return enqueue(async () => {
        await load();
        logs.length = 0;
        await replaceFile(usageFile, logs);
        
        const months = await listArchiveMonths();
        await Promise.all(months.map(month => {
          const archiveFile = path.join(usageDir, `${baseName}.usage-${month}.ndjson`);
          return fs.unlink(archiveFile).catch(() => {});
        }));
      });
    },
  };
}

module.exports = { createFileUsageRepository };
