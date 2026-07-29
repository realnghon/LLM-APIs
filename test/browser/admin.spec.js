'use strict';

const { test, expect } = require('@playwright/test');

test('admin can log in and open the streamlined account editor', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page).toHaveURL(/\/admin(\/accounts)?$/);
  await expect(page.getByRole('heading', { level: 1, name: '账号管理' })).toBeVisible();
  const navDecorations = await page.locator('.sidebar nav .nav-item').evaluateAll(items =>
    items.map(item => getComputedStyle(item).textDecorationLine));
  expect(navDecorations).toEqual(['none', 'none', 'none', 'none', 'none', 'none']);
  await page.getByRole('button', { name: '新增账号' }).click();

  const editor = page.getByRole('dialog', { name: '新增账号' });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('tab', { name: '连接' })).toBeVisible();
  await expect(editor.getByRole('tab', { name: '路由' })).toBeVisible();
  await expect(editor.getByRole('tab', { name: '余量' })).toBeVisible();
  await expect(editor.getByRole('tab', { name: '价格' })).toBeVisible();
  await expect(editor.getByText('池模式')).toHaveCount(0);
  await expect(editor.getByText('共享余额')).toHaveCount(0);

  await editor.getByLabel('账号名称').fill('Browser Account');
  await editor.getByLabel('Base URL').fill('https://example.com/v1');
  await editor.locator('#accountKey').fill('test-key');
  await editor.getByLabel('支持模型').fill('model-a');
  await editor.getByRole('tab', { name: '价格' }).click();
  await expect(editor.getByLabel('model-a 输入单价')).toBeVisible();
  await expect(editor.getByLabel('model-a 输出单价')).toBeVisible();
  await editor.getByRole('button', { name: '覆盖' }).click();
  await editor.getByLabel('model-a 输入单价').fill('1.5');
  await editor.getByLabel('model-a 输出单价').fill('6');
  await editor.getByRole('tab', { name: '连接' }).click();
  await editor.getByRole('tab', { name: '价格' }).click();
  await expect(editor.getByLabel('model-a 输入单价')).toHaveValue('1.5');
  await expect(editor.getByLabel('model-a 输出单价')).toHaveValue('6');
  await editor.getByRole('button', { name: '保存账号' }).click();

  await expect(editor).not.toBeVisible();
  await expect(page.locator('.account-name strong', { hasText: 'Browser Account' })).toBeVisible();
});

test('manual account check shows every model result in a dialog', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.request.post('/admin/accounts', { data: {
    name: 'Check Dialog', base_url: 'https://example.com/v1', api_key: 'key', models: ['model-a', 'model-b'],
  } });
  await page.reload();
  let submittedIndices;
  await page.route('**/admin/accounts/test', async route => {
    submittedIndices = route.request().postDataJSON().testIndices;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, name: 'Check Dialog', results: [
        { label: 'model-a(原始)', model: 'model-a', ok: false, status: 500, latency_ms: 80, error: '<img src=x onerror=window.__xss=1>' },
      ] }),
    });
  });

  await page.getByRole('button', { name: '测试 Check Dialog' }).click();
  const dialog = page.getByRole('dialog', { name: '模型测活结果' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-test-index="0"]')).toBeChecked();
  await expect(dialog.locator('[data-test-index="1"]')).toBeChecked();
  await dialog.getByRole('button', { name: '取消全选' }).click();
  await dialog.locator('[data-test-index="0"]').check();
  await dialog.getByRole('button', { name: '开始检测' }).click();
  await expect.poll(() => submittedIndices).toEqual([0]);
  await expect(dialog.getByText('model-a(原始)')).toBeVisible();
  await expect(dialog.getByText('<img src=x onerror=window.__xss=1>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('status page exposes scheduling controls and account-model timeline', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.route('**/admin/status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, settings: { enabled: true, interval_minutes: 5 }, snapshots: [{
      id: 'snapshot-1', checked_at: new Date().toISOString(), results: [
        { account_id: 'a', account_name: 'Account A', model: 'model-primary', ok: true, status: 200, latency_ms: 80, error: '' },
        { account_id: 'a', account_name: 'Account A', model: 'model-secondary', ok: false, status: 429, latency_ms: 110, error: 'limited' },
        { account_id: 'a', account_name: 'Account A', model: 'model-slow', ok: true, status: 200, latency_ms: 6500, error: '' },
        { account_id: 'a', account_name: 'Account A', model: 'model-timeout', ok: false, status: 0, latency_ms: 15000, error: 'upstream request timeout' },
        { account_id: 'b', account_name: 'Account B', model: 'model-third', ok: true, status: 200, latency_ms: 70, error: '' },
      ],
    }] }),
  }));
  await page.route('**/admin/accounts', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, accounts: [
      { id: 'a', name: 'Account A', enabled: true, models: ['model-primary', 'model-secondary', 'model-slow', 'model-timeout'], model_map: {} },
      { id: 'b', name: 'Account B', enabled: true, models: ['model-third'], model_map: {} },
    ] }),
  }));
  await page.locator('[data-view="status"]').click();

  await expect(page).toHaveURL(/\/admin\/status$/);
  await expect(page.getByRole('heading', { level: 2, name: '运行状态' })).toBeVisible();
  await expect(page.getByLabel('启用自动检测')).toBeChecked();
  await expect(page.getByLabel('检测周期')).toHaveValue('5');
  await expect(page.getByLabel('状态账号')).toBeVisible();
  await expect(page.getByRole('button', { name: '立即检测' })).toBeVisible();
  await expect(page.getByTestId('status-timeline')).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Account A' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Account B' })).toBeVisible();
  await expect(page.locator('.status-model-name', { hasText: 'model-primary' })).toBeVisible();
  await expect(page.locator('.availability-tag').first()).toBeVisible();
  await expect(page.getByText('缓慢', { exact: true })).toBeVisible();
  await expect(page.getByText('超时', { exact: true })).toBeVisible();
  await expect(page.locator('.status-label.failed', { hasText: '异常' })).toBeVisible();
  const desktopColumns = await page.locator('.status-account-group').first().locator('.status-model-grid').evaluate(element =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(desktopColumns).toBe(2);
  await page.screenshot({ path: 'test-results/status-groups-desktop.png', fullPage: true });
  await page.getByLabel('状态账号').selectOption('a');
  await expect(page.getByRole('heading', { level: 3, name: 'Account B' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const sidebarBox = await page.locator('#sidebar').boundingBox();
  expect(sidebarBox.x + sidebarBox.width).toBeLessThanOrEqual(1);
  const mobileColumns = await page.locator('.status-model-grid').evaluate(element =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(mobileColumns).toBe(1);
  await page.screenshot({ path: 'test-results/status-groups-mobile.png', fullPage: true });
});

test('statistics offer local weekly and monthly charts with recent five-hour usage', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  const today = new Date();
  const buckets = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - 6 + index);
    return { key: date.toISOString().slice(0, 10), count: 0, input: 0, output: 0, cost: 0, byAccount: [], byTarget: [] };
  });
  buckets[6] = {
    ...buckets[6], count: 3, input: 35, output: 11,
    byTarget: [
      { account_name: 'Account A', model: 'model-a', count: 1, input: 10, output: 5, cost: 0.01 },
      { account_name: 'Account A', model: 'model-b', count: 1, input: 5, output: 2, cost: 0.005 },
      { account_name: 'Account B', model: 'model-b', count: 1, input: 20, output: 4, cost: 0.02 },
    ],
  };
  await page.route('**/admin/usage/stats**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      cumulative: { total_count: 3, success_count: 3, fail_count: 0, total_tokens: 46, total_cost: 0.035, byAccount: [], byModel: [] },
      recent5h: { byAccount: [] }, trend: { range: 'week', buckets },
    }),
  }));
  await page.locator('[data-view="stats"]').click();

  await expect(page).toHaveURL(/\/admin\/stats$/);
  await expect(page.getByRole('button', { name: '近 7 天' })).toBeVisible();
  await expect(page.getByRole('button', { name: '近 30 天' })).toBeVisible();
  await expect(page.getByLabel('趋势账号')).toBeVisible();
  await expect(page.getByLabel('趋势模型')).toBeVisible();
  await expect(page.getByLabel('趋势分组')).toHaveValue('account');
  await expect(page.getByLabel('趋势指标')).toHaveValue('total_tokens');
  await expect(page.getByTestId('usage-trend-chart')).toBeVisible();
  await expect(page.getByTestId('usage-trend-chart').locator('canvas')).toBeVisible();
  const accountSeries = await page.evaluate(() => {
    const option = window.echarts.getInstanceByDom(document.getElementById('usageTrendChart')).getOption();
    return {
      series: option.series.map(series => ({ name: series.name, type: series.type, stack: series.stack, last: series.data[6] })),
      legend: option.legend[0],
    };
  });
  expect(accountSeries.series.slice(0, 3)).toEqual([
    { name: 'Account A / model-a', type: 'bar', stack: 'Account A', last: 15 },
    { name: 'Account A / model-b', type: 'bar', stack: 'Account A', last: 7 },
    { name: 'Account B / model-b', type: 'bar', stack: 'Account B', last: 24 },
  ]);
  expect(accountSeries.series[3].name).toBe('实际总 Tokens');
  expect(accountSeries.series[3].type).toBe('line');
  expect(accountSeries.series[3].last).toBe(46);
  const actualUsageLine = await page.evaluate(() => {
    const line = window.echarts.getInstanceByDom(document.getElementById('usageTrendChart')).getOption().series.at(-1);
    return { data: line.data, smooth: line.smooth };
  });
  expect(actualUsageLine.data).toEqual([0, 0, 0, 0, 0, 0, 46]);
  expect(actualUsageLine.smooth).toBe(true);
  expect(accountSeries.legend.orient).toBe('horizontal');
  expect(accountSeries.legend.left).toBe('center');
  await page.getByLabel('趋势分组').selectOption('model');
  await page.getByLabel('趋势指标').selectOption('input');
  const modelSeries = await page.evaluate(() => window.echarts
    .getInstanceByDom(document.getElementById('usageTrendChart'))
    .getOption().series.map(series => ({ name: series.name, type: series.type, stack: series.stack, last: series.data[6] })));
  expect(modelSeries.slice(0, 3)).toEqual([
    { name: 'model-a / Account A', type: 'bar', stack: 'model-a', last: 10 },
    { name: 'model-b / Account A', type: 'bar', stack: 'model-b', last: 5 },
    { name: 'model-b / Account B', type: 'bar', stack: 'model-b', last: 20 },
  ]);
  expect(modelSeries[3].name).toBe('实际总 Tokens');
  expect(modelSeries[3].last).toBe(46);
  const tableGeometry = await page.locator('.stats-data-table').evaluateAll(tables => tables.map(table => ({
    labels: [...table.querySelectorAll('th')].map(cell => cell.textContent.trim()),
    offsets: [...table.querySelectorAll('th')].map(cell => cell.offsetLeft),
  })));
  expect(tableGeometry).toHaveLength(3);
  expect(tableGeometry[0].labels).toEqual(['账号', '调用', '输入 Tokens', '输出 Tokens', '缓存 Tokens', '费用']);
  expect(tableGeometry[1].offsets).toEqual(tableGeometry[0].offsets);
  expect(tableGeometry[2].offsets).toEqual(tableGeometry[0].offsets);
  await page.screenshot({ path: 'test-results/usage-trend-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobileSidebar = await page.locator('#sidebar').boundingBox();
  expect(mobileSidebar.x + mobileSidebar.width).toBeLessThanOrEqual(1);
  const chartBox = await page.getByTestId('usage-trend-chart').boundingBox();
  expect(chartBox.width).toBeLessThanOrEqual(358);
  await page.screenshot({ path: 'test-results/usage-trend-mobile.png', fullPage: true });
  await expect(page.getByRole('heading', { name: '最近 5 小时用量' })).toBeVisible();
  await expect(page.getByText('累计费用')).toBeVisible();
});

test('usage records expose filters and unambiguous request details', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  let usageRequestUrl = '';
  await page.route('**/admin/usage?**', route => {
    usageRequestUrl = route.request().url();
    return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, total: 1, stats: { success_count: 1, error_count: 0 }, logs: [{
      id: 'usage-duration', request_id: 'usage-duration', account_name: 'Account A', requested_model: 'model-a',
      upstream_model: 'model-a', request_path: '/v1/chat/completions', client_ip: '127.0.0.1', status: 200,
      duration_ms: 2350, first_token_ms: 720, api_key_name: 'Client A', input_tokens: 10, output_tokens: 5, cost: 0.001, attempts: [{}], created_at: new Date().toISOString(),
    }] }),
    });
  });
  await page.locator('[data-view="usage"]').click();

  await expect(page).toHaveURL(/\/admin\/usage$/);
  const today = await page.evaluate(() => {
    const now = new Date();
    const part = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}`;
  });
  await expect(page.getByLabel('开始日期')).toHaveValue(today);
  await expect(page.getByLabel('结束日期')).toHaveValue(today);
  await expect.poll(() => usageRequestUrl).not.toBe('');
  const usageQuery = new URL(usageRequestUrl).searchParams;
  expect(usageQuery.get('from')).toBe(await page.evaluate(value => new Date(`${value}T00:00:00.000`).toISOString(), today));
  expect(usageQuery.get('to')).toBe(await page.evaluate(value => new Date(`${value}T23:59:59.999`).toISOString(), today));

  await expect(page.getByLabel('调用者 IP')).toBeVisible();
  await expect(page.getByLabel('上游账号筛选')).toBeVisible();
  await expect(page.getByLabel('开始日期')).toBeVisible();
  await expect(page.getByLabel('结束日期')).toBeVisible();
  await expect(page.getByLabel('请求状态')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '输入 / 输出 Tokens' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Key / 调用者 IP' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '费用' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '首字 / 耗时' })).toBeVisible();
  await expect(page.getByText('0.72s', { exact: true })).toBeVisible();
  await expect(page.getByText('2.35s', { exact: true })).toBeVisible();
});

test('API key and global pricing pages support the lightweight workflow', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.locator('[data-view="pricing"]').click();
  await expect(page).toHaveURL(/\/admin\/pricing$/);
  await page.getByRole('button', { name: '新增价格' }).click();
  const priceDialog = page.getByRole('dialog', { name: '模型价格' });
  await priceDialog.getByLabel('模型').fill('shared-model');
  await priceDialog.getByLabel('输入 $ / 1M Tokens').fill('1.25');
  await priceDialog.getByLabel('输出 $ / 1M Tokens').fill('5');
  await priceDialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('shared-model', { exact: true })).toBeVisible();

  await page.locator('[data-view="keys"]').click();
  await expect(page).toHaveURL(/\/admin\/api-keys$/);
  await page.getByRole('button', { name: '创建 Key' }).click();
  const keyDialog = page.getByRole('dialog', { name: '创建 API Key' });
  await keyDialog.getByLabel('名称').fill('Browser Client');
  await keyDialog.getByLabel('模型白名单').fill('shared-model');
  await keyDialog.getByRole('button', { name: '创建' }).click();
  await expect(keyDialog.getByText('请立即保存这个 Key')).toBeVisible();
  await expect(keyDialog.locator('code')).toContainText('llm_');
});

test('usage summary is presented without metric cards', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.locator('[data-view="usage"]').click();

  await expect(page).toHaveURL(/\/admin\/usage$/);
  const summary = page.locator('[data-testid="usage-summary"]');
  await expect(summary).toBeVisible();
  await expect(summary.locator('.metric-card')).toHaveCount(0);
  await expect(summary).toContainText('总记录');
  await expect(summary).toContainText('成功');
  await expect(summary).toContainText('失败');
});
