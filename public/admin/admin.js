'use strict';

(() => {
  const state = { accounts: [] };
  const byId = id => document.getElementById(id);
  const dialog = byId('accountDialog');
  const form = byId('accountForm');

  function icon(name) {
    return `<i data-lucide="${name}"></i>`;
  }

  function refreshIcons(root = document) {
    if (window.lucide) window.lucide.createIcons({ root });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('登录已失效');
    }
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data.success === false) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  }

  function showToast(message, isError = false) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.className = `toast is-visible${isError ? ' is-error' : ''}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 2600);
  }

  function modelMapFromText(text) {
    const output = {};
    for (const line of String(text).split('\n')) {
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key && value) output[key] = value;
    }
    return output;
  }

  function modelMapToText(map) {
    return Object.entries(map || {}).map(([key, value]) => `${key}=${value}`).join('\n');
  }

  function accountAllowance(account) {
    if (account.allowance?.type === 'total') return account.allowance;
    return null;
  }

  function allowanceLabel(account) {
    const allowance = accountAllowance(account);
    if (!allowance) return '不限制';
    const labels = { count: '次数', usage: '余额', points: '积分' };
    const total = Number(allowance.quota_total || 0);
    const remaining = Number(allowance.remaining ?? total);
    return `${labels[allowance.quota_mode] || '独立'} ${remaining || 0}/${total || 0}`;
  }

  function renderAccounts() {
    const body = byId('accountsBody');
    const empty = byId('accountsEmpty');
    byId('pageMeta').textContent = `${state.accounts.length} 个上游账号`;
    empty.classList.toggle('is-visible', state.accounts.length === 0);
    body.innerHTML = state.accounts.map((account, index) => {
      const models = (account.models || []).slice(0, 4)
        .map(model => `<span class="model-tag">${escapeHtml(model)}</span>`).join('');
      const overflow = (account.models || []).length > 4
        ? `<span class="model-tag">+${account.models.length - 4}</span>` : '';
      return `<tr>
        <td><div class="account-name"><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.base_url)}</span></div></td>
        <td><div class="model-list">${models}${overflow}</div></td>
        <td>${Number(account.priority || 1)} / ${Number(account.weight || 1)}</td>
        <td>${Number(account.max_concurrency || 0) || '不限'}</td>
        <td>${escapeHtml(allowanceLabel(account))}</td>
        <td><span class="status-label ${account.enabled === false ? 'disabled' : 'enabled'}">${account.enabled === false ? '停用' : '启用'}</span></td>
        <td><div class="row-actions">
          <button class="icon-button" data-action="test" data-id="${escapeHtml(account.id)}" title="测试账号" aria-label="测试 ${escapeHtml(account.name)}">${icon('flask-conical')}</button>
          ${index > 0 ? `<button class="icon-button" data-action="up" data-id="${escapeHtml(account.id)}" title="上移" aria-label="上移 ${escapeHtml(account.name)}">${icon('arrow-up')}</button>` : ''}
          ${index < state.accounts.length - 1 ? `<button class="icon-button" data-action="down" data-id="${escapeHtml(account.id)}" title="下移" aria-label="下移 ${escapeHtml(account.name)}">${icon('arrow-down')}</button>` : ''}
          <button class="icon-button" data-action="edit" data-id="${escapeHtml(account.id)}" title="编辑" aria-label="编辑 ${escapeHtml(account.name)}">${icon('pencil')}</button>
          <button class="icon-button danger" data-action="delete" data-id="${escapeHtml(account.id)}" title="删除" aria-label="删除 ${escapeHtml(account.name)}">${icon('trash-2')}</button>
        </div></td>
      </tr>`;
    }).join('');
    refreshIcons(body);
  }

  async function loadAccounts() {
    try {
      const data = await requestJson('/admin/accounts');
      state.accounts = data.accounts || [];
      renderAccounts();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function selectTab(name) {
    document.querySelectorAll('[data-tab]').forEach(tab => {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    });
    document.querySelectorAll('[data-tab-panel]').forEach(panel => {
      const selected = panel.dataset.tabPanel === name;
      panel.classList.toggle('is-active', selected);
      panel.hidden = !selected;
    });
  }

  function updateAllowanceFields() {
    const type = byId('allowanceType').value;
    byId('allowanceFields').hidden = type === 'none';
    byId('currencyField').hidden = type !== 'usage';
  }

  function resetForm(account = null) {
    form.reset();
    byId('accountId').value = account?.id || '';
    byId('accountName').value = account?.name || '';
    byId('accountFormat').value = account?.format || 'openai';
    byId('accountUrl').value = account?.base_url || '';
    byId('accountKey').value = account?.api_key || '';
    byId('accountModels').value = (account?.models || []).join('\n');
    byId('accountModelMap').value = modelMapToText(account?.model_map);
    byId('accountPriority').value = account?.priority || 1;
    byId('accountWeight').value = account?.weight || 1;
    byId('accountConcurrency').value = account?.max_concurrency || 0;
    byId('accountEnabled').checked = account?.enabled !== false;
    byId('accountNote').value = account?.note || '';
    const allowance = accountAllowance(account || {});
    byId('allowanceType').value = allowance?.quota_mode || 'none';
    byId('allowanceTotal').value = allowance?.quota_total ?? '';
    byId('allowanceExpiry').value = allowance?.quota_expires_at || '';
    byId('allowanceRates').value = allowance?.quota_rates_text || '';
    byId('allowanceCurrency').checked = allowance?.quota_display_currency === true;
    byId('formError').textContent = '';
    byId('accountDialogTitle').textContent = account ? '编辑账号' : '新增账号';
    byId('dialogAccountMeta').textContent = account?.name || '配置上游连接';
    selectTab('connection');
    updateAllowanceFields();
  }

  function openAccount(account = null) {
    resetForm(account);
    dialog.showModal();
    setTimeout(() => byId('accountName').focus(), 0);
  }

  function accountFromForm() {
    const allowanceType = byId('allowanceType').value;
    const payload = {
      name: byId('accountName').value.trim(),
      format: byId('accountFormat').value,
      base_url: byId('accountUrl').value.trim(),
      api_key: byId('accountKey').value.trim(),
      models: [...new Set(byId('accountModels').value.split('\n').map(value => value.trim()).filter(Boolean))],
      model_map: modelMapFromText(byId('accountModelMap').value),
      priority: Number(byId('accountPriority').value || 1),
      weight: Number(byId('accountWeight').value || 1),
      max_concurrency: Number(byId('accountConcurrency').value || 0),
      enabled: byId('accountEnabled').checked,
      note: byId('accountNote').value.trim(),
      allowance: allowanceType === 'none' ? null : {
        type: 'total',
        quota_mode: allowanceType,
        quota_total: Number(byId('allowanceTotal').value || 0),
        quota_expires_at: byId('allowanceExpiry').value,
        quota_rates_text: byId('allowanceRates').value.trim(),
        quota_display_currency: allowanceType === 'usage' && byId('allowanceCurrency').checked,
      },
    };
    const id = byId('accountId').value;
    if (id) payload.id = id;
    return payload;
  }

  async function saveAccount(event) {
    event.preventDefault();
    const payload = accountFromForm();
    if (!payload.name || !payload.base_url || !payload.api_key || payload.models.length === 0) {
      byId('formError').textContent = '请填写名称、Base URL、API Key 和至少一个模型';
      selectTab('connection');
      return;
    }
    const button = byId('saveAccountButton');
    button.disabled = true;
    try {
      await requestJson('/admin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      dialog.close();
      await loadAccounts();
      showToast('账号已保存');
    } catch (error) {
      byId('formError').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function deleteAccount(account) {
    if (!window.confirm(`删除账号“${account.name}”？`)) return;
    try {
      await requestJson(`/admin/accounts?id=${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      await loadAccounts();
      showToast('账号已删除');
    } catch (error) { showToast(error.message, true); }
  }

  async function moveAccount(account, offset) {
    const index = state.accounts.findIndex(item => item.id === account.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= state.accounts.length) return;
    [state.accounts[index], state.accounts[target]] = [state.accounts[target], state.accounts[index]];
    renderAccounts();
    try {
      await requestJson('/admin/accounts/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: state.accounts.map(item => item.id) }),
      });
    } catch (error) { showToast(error.message, true); await loadAccounts(); }
  }

  async function testAccount(account) {
    showToast(`正在测试 ${account.name}`);
    try {
      const data = await requestJson('/admin/accounts/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: account.id }),
      });
      const failed = (data.results || []).filter(result => !result.ok);
      showToast(failed.length ? `${failed.length} 个模型测试失败` : '全部模型连接正常', failed.length > 0);
    } catch (error) { showToast(error.message, true); }
  }

  async function fetchModels() {
    const baseUrl = byId('accountUrl').value.trim();
    const apiKey = byId('accountKey').value.trim();
    if (!baseUrl || !apiKey) {
      byId('formError').textContent = '请先填写 Base URL 和 API Key';
      return;
    }
    const button = byId('fetchModelsButton');
    button.disabled = true;
    try {
      const data = await requestJson('/admin/accounts/fetch-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
      });
      byId('accountModels').value = (data.models || []).join('\n');
      showToast(`已获取 ${(data.models || []).length} 个模型`);
    } catch (error) { byId('formError').textContent = error.message; }
    finally { button.disabled = false; }
  }

  function formatNumber(value) {
    const number = Number(value || 0);
    return Intl.NumberFormat('zh-CN', { notation: number >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number);
  }

  async function loadUsage() {
    try {
      const data = await requestJson('/admin/usage?limit=100&offset=0');
      const logs = data.logs || [];
      byId('usageTotal').textContent = formatNumber(data.total || logs.length);
      byId('usageSuccess').textContent = formatNumber(data.stats?.success_count || 0);
      byId('usageFailure').textContent = formatNumber(data.stats?.error_count || 0);
      byId('usageEmpty').classList.toggle('is-visible', logs.length === 0);
      byId('usageBody').innerHTML = logs.map(log => {
        const time = log.created_at ? new Date(log.created_at).toLocaleString('zh-CN', { hour12: false }) : '-';
        const successful = Number(log.status) >= 200 && Number(log.status) < 400;
        return `<tr><td>${escapeHtml(log.account_name || '-')}</td><td>${escapeHtml(time)}</td><td>${log.duration_ms ? `${(log.duration_ms / 1000).toFixed(2)}s` : '-'}</td><td>${formatNumber(log.input_tokens)} / ${formatNumber(log.output_tokens)}</td><td>${escapeHtml(log.requested_model || '-')}</td><td><span class="status-label ${successful ? 'enabled' : 'disabled'}">${escapeHtml(log.status || 'Error')}</span></td></tr>`;
      }).join('');
    } catch (error) { showToast(error.message, true); }
  }

  async function clearUsage() {
    if (!window.confirm('清空全部使用记录？')) return;
    try { await requestJson('/admin/usage', { method: 'DELETE' }); await loadUsage(); }
    catch (error) { showToast(error.message, true); }
  }

  async function loadStats() {
    try {
      const data = await requestJson('/admin/usage/stats');
      const cumulative = data.cumulative || {};
      byId('statsSummary').innerHTML = `<span>总调用 <strong>${formatNumber(cumulative.total_count)}</strong></span><span>成功 <strong class="positive">${formatNumber(cumulative.success_count)}</strong></span><span>失败 <strong class="negative">${formatNumber(cumulative.fail_count)}</strong></span>`;
      byId('accountStatsBody').innerHTML = (cumulative.byAccount || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${formatNumber(item.count)}</td><td>${formatNumber(item.input)}</td><td>${formatNumber(item.output)}</td><td>${formatNumber(item.cache)}</td><td>${formatNumber(item.consumed)}</td></tr>`).join('');
      byId('modelStatsBody').innerHTML = (cumulative.byModel || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${formatNumber(item.count)}</td><td>${formatNumber(item.input)}</td><td>${formatNumber(item.output)}</td><td>${formatNumber(item.cache)}</td></tr>`).join('');
    } catch (error) { showToast(error.message, true); }
  }

  function switchView(view) {
    const titles = { accounts: '账号管理', usage: '使用记录', stats: '累计统计' };
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('is-active', button.dataset.view === view));
    document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('is-active', panel.dataset.viewPanel === view));
    byId('pageTitle').textContent = titles[view];
    if (view === 'accounts') loadAccounts();
    if (view === 'usage') loadUsage();
    if (view === 'stats') loadStats();
    byId('sidebar').classList.remove('is-open');
    byId('sidebarScrim').classList.remove('is-visible');
  }

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  byId('addAccountButton').addEventListener('click', () => openAccount());
  byId('closeDialogButton').addEventListener('click', () => dialog.close());
  byId('cancelDialogButton').addEventListener('click', () => dialog.close());
  byId('allowanceType').addEventListener('change', updateAllowanceFields);
  byId('toggleKeyButton').addEventListener('click', () => {
    const key = byId('accountKey');
    key.type = key.type === 'password' ? 'text' : 'password';
  });
  byId('fetchModelsButton').addEventListener('click', fetchModels);
  form.addEventListener('submit', saveAccount);
  byId('accountsBody').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const account = state.accounts.find(item => item.id === button.dataset.id);
    if (!account) return;
    const actions = { edit: () => openAccount(account), delete: () => deleteAccount(account), up: () => moveAccount(account, -1), down: () => moveAccount(account, 1), test: () => testAccount(account) };
    actions[button.dataset.action]?.();
  });
  byId('refreshUsageButton').addEventListener('click', loadUsage);
  byId('clearUsageButton').addEventListener('click', clearUsage);
  byId('refreshStatsButton').addEventListener('click', loadStats);
  byId('menuButton').addEventListener('click', () => {
    byId('sidebar').classList.add('is-open');
    byId('sidebarScrim').classList.add('is-visible');
  });
  byId('sidebarScrim').addEventListener('click', () => {
    byId('sidebar').classList.remove('is-open');
    byId('sidebarScrim').classList.remove('is-visible');
  });

  refreshIcons();
  loadAccounts();
})();
