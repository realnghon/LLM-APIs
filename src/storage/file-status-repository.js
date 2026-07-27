'use strict';

const fs = require('fs/promises');
const path = require('path');
const { DEFAULT_SETTINGS } = require('../status');

function createFileStatusRepository(dataFile) {
  const extension = path.extname(dataFile);
  const statusFile = path.join(path.dirname(dataFile), `${path.basename(dataFile, extension)}.status.json`);
  let queue = Promise.resolve();

  async function read() {
    try { return JSON.parse(await fs.readFile(statusFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async function write(document) {
    await fs.mkdir(path.dirname(statusFile), { recursive: true });
    const temporary = `${statusFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(document));
    await fs.rename(temporary, statusFile);
  }

  function mutate(change) {
    const operation = queue.then(async () => {
      const document = await read();
      await change(document);
      await write(document);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    async getSettings() {
      await queue;
      return { ...DEFAULT_SETTINGS, ...(await read()).settings };
    },
    async saveSettings(settings) {
      await mutate(document => { document.settings = settings; });
      return settings;
    },
    async listSnapshots() {
      await queue;
      const snapshots = (await read()).snapshots;
      return Array.isArray(snapshots) ? snapshots : [];
    },
    async addSnapshot(snapshot) {
      await mutate(document => {
        const snapshots = Array.isArray(document.snapshots) ? document.snapshots : [];
        document.snapshots = [snapshot, ...snapshots].slice(0, 288);
      });
    },
    async removeAccountResults(accountId) {
      await mutate(document => {
        const snapshots = Array.isArray(document.snapshots) ? document.snapshots : [];
        document.snapshots = snapshots.map(snapshot => ({
          ...snapshot,
          results: (Array.isArray(snapshot.results) ? snapshot.results : [])
            .filter(result => result.account_id !== accountId),
        }));
      });
    },
  };
}

module.exports = { createFileStatusRepository };
