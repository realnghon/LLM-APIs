'use strict';

const http = require('http');
const { createHttpHandler } = require('./src/app');
const { startServer } = require('./src/server-lifecycle');

const port = Number(process.env.PORT || 3000);
const server = http.createServer(createHttpHandler());

startServer(server, { port });

module.exports = { server };
