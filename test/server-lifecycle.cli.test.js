'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

function capture(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    output: () => stdout + stderr,
    close: () => new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))),
  };
}

async function waitFor(check, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for process output');
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

test('duplicate startup explains how to stop the running cross-platform service', { timeout: 20_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-apis-lifecycle-'));
  const pidFile = path.join(directory, 'server.pid');
  const dataFile = path.join(directory, 'kv.json');
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_FILE: dataFile,
    LLM_APIS_PID_FILE: pidFile,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'password',
  };
  let first;

  t.after(async () => {
    if (first && isRunning(first)) first.kill('SIGKILL');
    await fs.rm(directory, { recursive: true, force: true });
  });

  first = spawn(process.execPath, ['APIs.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const firstCapture = capture(first);
  await waitFor(() => firstCapture.output().includes(`http://127.0.0.1:${port}`));

  const second = spawn(process.execPath, ['APIs.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const secondResult = await capture(second).close();
  const duplicateOutput = secondResult.stdout + secondResult.stderr;
  assert.equal(secondResult.code, 1);
  assert.match(duplicateOutput, /当前有服务正在运行/);
  assert.match(duplicateOutput, new RegExp(`PID[:：]\\s*${first.pid}`));
  assert.match(duplicateOutput, /npm run stop/);
  assert.doesNotMatch(duplicateOutput, /Unhandled 'error' event/);

  const stopOptions = { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] };
  const stop = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run stop'], stopOptions)
    : spawn('npm', ['run', 'stop'], stopOptions);
  const stopResult = await capture(stop).close();
  assert.equal(stopResult.code, 0);
  assert.match(stopResult.stdout + stopResult.stderr, new RegExp(`已停止.*PID[:：]?\\s*${first.pid}`));
  await waitFor(() => !isRunning(first));

  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
});
