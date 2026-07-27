'use strict';

const queues = new Map();

function withFileLock(filePath, operation) {
  const previous = queues.get(filePath) || Promise.resolve();
  const current = previous.then(operation);
  const settled = current.catch(() => {});
  queues.set(filePath, settled);
  settled.finally(() => {
    if (queues.get(filePath) === settled) queues.delete(filePath);
  });
  return current;
}

async function waitForFile(filePath) {
  await (queues.get(filePath) || Promise.resolve());
}

module.exports = { waitForFile, withFileLock };
