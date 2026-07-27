'use strict';

function createConcurrencyLimiter() {
  const counts = new Map();

  return {
    acquire(account) {
      const maximum = Math.max(0, Number(account.max_concurrency || 0));
      const key = account.id;
      const current = counts.get(key) || 0;
      if (maximum > 0 && current >= maximum) return null;
      counts.set(key, current + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = Math.max(0, (counts.get(key) || 1) - 1);
        if (next === 0) counts.delete(key); else counts.set(key, next);
      };
    },
    active(account) {
      return counts.get(account.id) || 0;
    },
  };
}

function finalizeStream(stream, finalize, observe = () => {}) {
  if (!stream) {
    Promise.resolve(finalize()).catch(() => {});
    return null;
  }
  const reader = stream.getReader();
  let finalized = false;
  async function finish() {
    if (finalized) return;
    finalized = true;
    await finalize();
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finish();
          controller.close();
        } else {
          observe(value);
          controller.enqueue(value);
        }
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await finish();
    },
  });
}

module.exports = { createConcurrencyLimiter, finalizeStream };
