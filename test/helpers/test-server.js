'use strict';

const http = require('http');

const HIGHEST_FETCH_BLOCKED_PORT = 10080;

function isFetchSafeTestPort(port) {
  return Number.isInteger(port) && port > HIGHEST_FETCH_BLOCKED_PORT && port <= 65535;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      server.off('listening', onListening);
      reject(error);
    }
    function onListening() {
      server.off('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

async function startTestServer(handler) {
  const server = http.createServer(handler);
  let address;
  do {
    await listen(server);
    address = server.address();
    if (!isFetchSafeTestPort(address.port)) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  } while (!isFetchSafeTestPort(address.port));

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      await handler.dispose?.();
    },
  };
}

module.exports = { isFetchSafeTestPort, startTestServer };
