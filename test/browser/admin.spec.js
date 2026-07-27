'use strict';

const { test, expect } = require('@playwright/test');

test('admin can log in and open the streamlined account editor', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: '账号管理' })).toBeVisible();
  await page.getByRole('button', { name: '新增账号' }).click();

  const editor = page.getByRole('dialog', { name: '新增账号' });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('tab', { name: '连接' })).toBeVisible();
  await expect(editor.getByRole('tab', { name: '路由' })).toBeVisible();
  await expect(editor.getByRole('tab', { name: '余量' })).toBeVisible();
  await expect(editor.getByText('池模式')).toHaveCount(0);
  await expect(editor.getByText('共享余额')).toHaveCount(0);

  await editor.getByLabel('账号名称').fill('Browser Account');
  await editor.getByLabel('Base URL').fill('https://example.com/v1');
  await editor.locator('#accountKey').fill('test-key');
  await editor.getByLabel('支持模型').fill('model-a');
  await editor.getByRole('button', { name: '保存账号' }).click();

  await expect(editor).not.toBeVisible();
  await expect(page.locator('.account-name strong', { hasText: 'Browser Account' })).toBeVisible();
});

test('usage summary is presented without metric cards', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('button', { name: '使用记录' }).click();

  const summary = page.locator('[data-testid="usage-summary"]');
  await expect(summary).toBeVisible();
  await expect(summary.locator('.metric-card')).toHaveCount(0);
  await expect(summary).toContainText('总记录');
  await expect(summary).toContainText('成功');
  await expect(summary).toContainText('失败');
});
