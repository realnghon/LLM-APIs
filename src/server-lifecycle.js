'use strict';

const fs = require('fs');
const path = require('path');

function pidFilePath() {
  return process.env.LLM_APIS_PID_FILE || path.join(__dirname, '..', '.llm-apis.pid');
}

function readPidFile(filePath = pidFilePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { ...parsed, pid };
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function runningService(filePath = pidFilePath()) {
  const service = readPidFile(filePath);
  if (!service) return null;
  if (processExists(service.pid)) return service;
  try { fs.unlinkSync(filePath); } catch {}
  return null;
}

function writePidFile(port, filePath = pidFilePath()) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    pid: process.pid,
    port,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  }, null, 2));
  fs.renameSync(temporary, filePath);
  return filePath;
}

function removeOwnedPidFile(filePath = pidFilePath(), ownerPid = process.pid) {
  const service = readPidFile(filePath);
  if (!service || service.pid !== Number(ownerPid)) return;
  try { fs.unlinkSync(filePath); } catch {}
}

function printAddressInUse(port, filePath = pidFilePath()) {
  const service = runningService(filePath);
  console.error(`[LLM-APIs] 启动失败：端口 ${port} 已被占用，当前有服务正在运行。`);
  if (service) console.error(`[LLM-APIs] 当前服务 PID: ${service.pid}`);
  else console.error('[LLM-APIs] 当前服务 PID: 无法确认（可能不是由本项目启动）');
  console.error('[LLM-APIs] 停止本项目服务（Windows / Linux 通用）：npm run stop');
}

function startServer(server, { port, host = '127.0.0.1' }) {
  const filePath = pidFilePath();
  let ownsPidFile = false;
  let shuttingDown = false;

  function cleanup() {
    if (ownsPidFile) removeOwnedPidFile(filePath);
  }

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(error => {
      cleanup();
      if (error) {
        console.error(`[LLM-APIs] 停止服务失败：${error.message}`);
        process.exit(1);
      }
      if (signal) console.log(`[LLM-APIs] 服务已停止 (${signal})`);
      process.exit(0);
    });
    const timer = setTimeout(() => {
      cleanup();
      process.exit(1);
    }, 5_000);
    timer.unref();
  }

  server.once('error', error => {
    if (error.code === 'EADDRINUSE') {
      printAddressInUse(port, filePath);
      process.exitCode = 1;
      return;
    }
    console.error(`[LLM-APIs] 启动失败：${error.message}`);
    process.exitCode = 1;
  });

  server.once('listening', () => {
    writePidFile(port, filePath);
    ownsPidFile = true;
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`LLM-APIs 本地运行: http://${displayHost}:${port}`);
    console.log(`管理后台: http://${displayHost}:${port}/admin`);
    if (host === '0.0.0.0' || host === '::') console.warn('[LLM-APIs] 服务已对局域网开放，请启用 API Key 鉴权。');
    console.log('停止服务: npm run stop');
  });

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', cleanup);
  server.listen(port, host);
  return server;
}

module.exports = {
  pidFilePath,
  printAddressInUse,
  processExists,
  readPidFile,
  removeOwnedPidFile,
  runningService,
  startServer,
};
