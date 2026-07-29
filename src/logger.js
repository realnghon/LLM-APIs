'use strict';

function createLogger(options = {}) {
  const level = options.level || process.env.LOG_LEVEL || 'info';
  const ranks = { debug: 10, info: 20, warn: 30, error: 40 };
  function log(name, event, fields = {}) {
    if ((ranks[name] || 20) < (ranks[level] || 20)) return;
    const output = JSON.stringify({ timestamp: new Date().toISOString(), level: name, event, ...fields });
    (name === 'error' ? console.error : name === 'warn' ? console.warn : console.log)(output);
  }
  return {
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

module.exports = { createLogger };
