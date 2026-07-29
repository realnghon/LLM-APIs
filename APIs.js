'use strict';

const http = require('http');
const { createHttpHandler } = require('./src/app');
const { loadServiceConfig } = require('./src/config');
const { startServer } = require('./src/server-lifecycle');

const service = loadServiceConfig();
const handler = createHttpHandler({ maximumBodyBytes: service.max_request_body_bytes });
const server = http.createServer(handler);
server.headersTimeout = service.headers_timeout_ms;
server.requestTimeout = service.request_timeout_ms;
server.keepAliveTimeout = service.keep_alive_timeout_ms;
server.on('close', () => handler.dispose?.());

startServer(server, { port: service.port, host: service.host });

module.exports = { server };
