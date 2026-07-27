'use strict';

const fs = require('fs/promises');
const path = require('path');
const { waitForFile, withFileLock } = require('./file-lock');

function decode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function createFileUsageRepository(dataFile) {
  async function readDocument() {
    try { return JSON.parse(await fs.readFile(dataFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async function mutateLogs(change) {
    return withFileLock(dataFile, async () => {
      const document = await readDocument();
      const current = decode(document.usage_logs, []);
      const logs = await change(Array.isArray(current) ? current : []);
      document.usage_logs = JSON.stringify(logs.slice(0, 1000));
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      const temporary = `${dataFile}.${process.pid}.${Date.now()}.usage.tmp`;
      await fs.writeFile(temporary, JSON.stringify(document, null, 2));
      await fs.rename(temporary, dataFile);
    });
  }

  return {
    async list() {
      await waitForFile(dataFile);
      const logs = decode((await readDocument()).usage_logs, []);
      return Array.isArray(logs) ? logs : [];
    },
    async record(entry) {
      await mutateLogs(logs => [entry, ...logs]);
    },
    async clear() { await mutateLogs(() => []); },
  };
}

module.exports = { createFileUsageRepository };
