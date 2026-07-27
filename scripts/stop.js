'use strict';

const fs = require('fs');
const {
  pidFilePath,
  processExists,
  readPidFile,
  removeOwnedPidFile,
} = require('../src/server-lifecycle');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stop() {
  const filePath = pidFilePath();
  const service = readPidFile(filePath);
  if (!service) {
    console.log('[LLM-APIs] 当前没有由本项目记录的运行服务。');
    return;
  }

  if (!processExists(service.pid)) {
    try { fs.unlinkSync(filePath); } catch {}
    console.log(`[LLM-APIs] 服务 PID ${service.pid} 已不在运行，已清理旧记录。`);
    return;
  }

  try {
    process.kill(service.pid, 'SIGTERM');
  } catch (error) {
    console.error(`[LLM-APIs] 无法停止服务 PID ${service.pid}：${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (let attempt = 0; attempt < 50 && processExists(service.pid); attempt += 1) {
    await sleep(100);
  }

  if (processExists(service.pid)) {
    try { process.kill(service.pid, 'SIGKILL'); }
    catch (error) {
      console.error(`[LLM-APIs] 无法强制停止服务 PID ${service.pid}：${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  removeOwnedPidFile(filePath, service.pid);
  console.log(`[LLM-APIs] 已停止服务 PID: ${service.pid}`);
}

stop().catch(error => {
  console.error(`[LLM-APIs] 停止服务失败：${error.message}`);
  process.exitCode = 1;
});
