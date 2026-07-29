'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const { test } = require('node:test');
const { createFileUsageRepository } = require('../src/storage/file-usage-repository');

test('usage archive stores old months separately', async () => {
  const tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
  const dataFile = path.join(tmpDir, 'test.json');
  
  try {
    const repo = createFileUsageRepository(dataFile);
    
    // 写入当前月的记录
    await repo.record({
      id: 'current-1',
      created_at: new Date().toISOString(),
      input_tokens: 100,
      output_tokens: 50,
    });
    
    // 写入上个月的记录
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    await repo.record({
      id: 'last-month-1',
      created_at: lastMonth.toISOString(),
      input_tokens: 200,
      output_tokens: 100,
    });
    
    // 写入两个月前的记录
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    await repo.record({
      id: 'two-months-ago-1',
      created_at: twoMonthsAgo.toISOString(),
      input_tokens: 300,
      output_tokens: 150,
    });
    
    // 列出所有记录（包括归档）
    const allLogs = await repo.list();
    assert.strictEqual(allLogs.length, 3, '应该返回所有 3 条记录');
    
    // 验证可以找到所有记录
    const ids = allLogs.map(log => log.id).sort();
    assert.deepStrictEqual(ids, ['current-1', 'last-month-1', 'two-months-ago-1']);
    
    // 只列出当前月（不包括归档）
    const currentOnly = await repo.list({ includeArchives: false });
    assert.ok(currentOnly.length >= 1, '当前月应该至少有一条记录');
    
    // 按时间范围过滤
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    oneMonthAgo.setDate(1);
    
    const recentLogs = await repo.list({ 
      from: oneMonthAgo.toISOString() 
    });
    assert.ok(recentLogs.length >= 2, '最近一个月应该有至少 2 条记录');
    
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      // Windows 有时文件句柄未释放，忽略清理错误
    }
  }
});
