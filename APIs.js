'use strict';

const http = require('http');
const { createHttpHandler } = require('./src/app');
const { loadServicePort } = require('./src/config');
const { startServer } = require('./src/server-lifecycle');

const port = loadServicePort();
const server = http.createServer(createHttpHandler());

startServer(server, { port });

module.exports = { server };
