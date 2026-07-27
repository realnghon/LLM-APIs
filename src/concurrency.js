'use strict';

function createConcurrencyLimiter() {
  const counts = new Map();

  return {
    acquire(account) {
      const maximum = Math.max(0, Number(account.max_concurrency || 0));
      if (maximum === 0) return () => {};
      const key = account.id;
      const current = counts.get(key) || 0;
      if (current >= maximum) return null;
      counts.set(key, current + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = Math.max(0, (counts.get(key) || 1) - 1);
        if (next === 0) counts.delete(key); else counts.set(key, next);
      };
    },
  };
}

function finalizeStream(stream, finalize) {
  if (!stream) {
    finalize();
    return null;
  }
  const reader = stream.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finalize();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

module.exports = { createConcurrencyLimiter, finalizeStream };
