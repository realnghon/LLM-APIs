'use strict';

(() => {
  const VIEWS = {
    accounts: { path: '/admin/accounts', title: '账号管理' },
    usage: { path: '/admin/usage', title: '使用记录' },
    stats: { path: '/admin/stats', title: '累计统计' },
    status: { path: '/admin/status', title: '运行状态' },
  };
  const SLOW_LATENCY_MS = 5000;
  const state = {
    accounts: [], usageOffset: 0, usageLimit: 50, usageTotal: 0,
    statsRange: 'week', trend: null, trendChart: null, editingPrices: {}, statusSnapshots: [],
    testingAccount: null, testItems: [], currentView: 'accounts',
  };
  const byId = id => document.getElementById(id);
  const dialog = byId('accountDialog');
  const testDialog = byId('testDialog');
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
    const usageAccount = byId('usageAccount');
    const selectedAccount = usageAccount.value;
    usageAccount.innerHTML = '<option value="">全部账号</option>' + state.accounts
      .map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join('');
    usageAccount.value = selectedAccount;
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
    if (name === 'pricing') renderPriceFields();
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

  function priceModels() {
    const direct = byId('accountModels').value.split('\n').map(value => value.trim()).filter(Boolean);
    const mapped = Object.values(modelMapFromText(byId('accountModelMap').value));
    return [...new Set([...direct, ...mapped])];
  }

  function capturePrices() {
    document.querySelectorAll('[data-price-model]').forEach(row => {
      state.editingPrices[row.dataset.priceModel] = {
        input: Number(row.querySelector('[data-price-input]').value || 0),
        output: Number(row.querySelector('[data-price-output]').value || 0),
      };
    });
    return state.editingPrices;
  }

  function renderPriceFields() {
    capturePrices();
    const models = priceModels();
    byId('modelPriceFields').innerHTML = models.length ? models.map(model => {
      const price = state.editingPrices[model] || {};
      return `<div class="price-row" data-price-model="${escapeHtml(model)}">
        <strong title="${escapeHtml(model)}">${escapeHtml(model)}</strong>
        <input type="number" min="0" step="0.000001" value="${Number(price.input || 0)}" data-price-input aria-label="${escapeHtml(model)} 输入单价">
        <input type="number" min="0" step="0.000001" value="${Number(price.output || 0)}" data-price-output aria-label="${escapeHtml(model)} 输出单价">
      </div>`;
    }).join('') : '<div class="inline-empty">暂无模型</div>';
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
    byId('accountTimeout').value = Number(account?.request_timeout_ms || 120000) / 1000;
    byId('accountEnabled').checked = account?.enabled !== false;
    byId('accountNote').value = account?.note || '';
    state.editingPrices = JSON.parse(JSON.stringify(account?.model_prices || {}));
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
      request_timeout_ms: Number(byId('accountTimeout').value || 120) * 1000,
      enabled: byId('accountEnabled').checked,
      note: byId('accountNote').value.trim(),
      model_prices: capturePrices(),
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

  function updateTestSelectionSummary() {
    const selected = document.querySelectorAll('[data-test-index]:checked').length;
    byId('testSummary').innerHTML = `<span>已选择 <strong>${selected}/${state.testItems.length}</strong></span>`;
    byId('startTestModels').disabled = selected === 0;
  }

  function renderTestSelection() {
    byId('testSelectionActions').hidden = false;
    byId('testResultsBody').innerHTML = state.testItems.map((item, index) => `<label class="test-result-row test-select-row">
      <div class="test-model-choice"><input type="checkbox" data-test-index="${index}" aria-label="选择 ${escapeHtml(item.label)}" checked><span class="cell-stack"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.model)}</small></span></div>
      <span class="status-label">待检测</span><span>-</span><span class="test-error">等待开始</span>
    </label>`).join('');
    updateTestSelectionSummary();
  }

  function renderTestResults(results, pending = false) {
    const completed = results.filter(result => !result.pending);
    const healthy = completed.filter(result => result.ok).length;
    byId('testSummary').innerHTML = pending
      ? `<span>检测中 <strong>${completed.length}/${results.length}</strong></span>`
      : `<span>完成 <strong>${completed.length}</strong></span><span class="positive">正常 <strong>${healthy}</strong></span><span class="negative">异常 <strong>${completed.length - healthy}</strong></span>`;
    byId('testResultsBody').innerHTML = results.map(result => `<div class="test-result-row">
      <div class="cell-stack"><strong>${escapeHtml(result.label || result.model)}</strong><small>${escapeHtml(result.model || '')}</small></div>
      <span class="status-label ${result.pending ? '' : result.ok ? 'enabled' : 'disabled'}">${result.pending ? '等待' : result.ok ? '正常' : '失败'}</span>
      <span>${result.pending ? '-' : `${formatNumber(result.latency_ms)} ms`}</span>
      <span class="test-error" title="${escapeHtml(result.error || '')}">${result.pending ? '检测中' : result.error || `HTTP ${result.status || 0}`}</span>
    </div>`).join('');
  }

  function testAccount(account) {
    state.testingAccount = account;
    state.testItems = [
      ...(account.models || []).map(model => ({ label: `${model}（原始）`, model })),
      ...Object.entries(account.model_map || {}).map(([client, model]) => ({ label: `${client} → ${model}`, model })),
    ];
    byId('testDialogMeta').textContent = account.name;
    renderTestSelection();
    testDialog.showModal();
  }

  async function runSelectedAccountTests() {
    const testIndices = [...document.querySelectorAll('[data-test-index]:checked')].map(input => Number(input.dataset.testIndex));
    if (!testIndices.length || !state.testingAccount) return;
    const pending = testIndices.map(index => ({ ...state.testItems[index], pending: true }));
    byId('testSelectionActions').hidden = true;
    renderTestResults(pending, true);
    try {
      const data = await requestJson('/admin/accounts/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.testingAccount.id, testIndices }),
      });
      renderTestResults(data.results || []);
    } catch (error) {
      renderTestResults(pending.map(item => ({ ...item, pending: false, ok: false, error: error.message })));
    }
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

  function formatCost(value) {
    return `$${Number(value || 0).toFixed(6)}`;
  }

  function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds)) return '-';
    return `${Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(milliseconds / 1000)} s`;
  }

  function localDateValue(date = new Date()) {
    const part = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
  }

  function setDefaultUsageDates() {
    const today = localDateValue();
    byId('usageFrom').value = today;
    byId('usageTo').value = today;
  }

  function usageFilterValue(id, value) {
    if (id === 'usageFrom') return new Date(`${value}T00:00:00.000`).toISOString();
    if (id === 'usageTo') return new Date(`${value}T23:59:59.999`).toISOString();
    return value;
  }

  async function loadUsage() {
    try {
      const params = new URLSearchParams({ limit: state.usageLimit, offset: state.usageOffset });
      for (const id of ['usageIp', 'usageAccount', 'usageModel', 'usageFrom', 'usageTo', 'usageStatus']) {
        const input = byId(id);
        if (input.value) params.set(input.name, usageFilterValue(id, input.value));
      }
      const data = await requestJson(`/admin/usage?${params}`);
      const logs = data.logs || [];
      state.usageTotal = Number(data.total || 0);
      byId('usageTotal').textContent = formatNumber(state.usageTotal);
      byId('usageSuccess').textContent = formatNumber(data.stats?.success_count || 0);
      byId('usageFailure').textContent = formatNumber(data.stats?.error_count || 0);
      byId('usageEmpty').classList.toggle('is-visible', logs.length === 0);
      byId('usageBody').innerHTML = logs.map(log => {
        const time = log.created_at ? new Date(log.created_at).toLocaleString('zh-CN', { hour12: false }) : '-';
        const successful = Number(log.status) >= 200 && Number(log.status) < 400;
        const requestId = String(log.request_id || log.id || '-').replace(/^usage_/, '').slice(0, 8);
        const attemptCount = Array.isArray(log.attempts) ? log.attempts.length : 0;
        const statusTitle = log.error || (attemptCount > 1 ? `${attemptCount} 次上游尝试` : '');
        return `<tr>
          <td><div class="cell-stack"><span>${escapeHtml(time)}</span><small>${escapeHtml(log.request_path || '-')} · ${escapeHtml(requestId)}</small></div></td>
          <td class="monospace">${escapeHtml(log.client_ip || '-')}</td>
          <td><div class="cell-stack"><span>${escapeHtml(log.account_name || '-')}</span><small>${attemptCount || 1} 次尝试</small></div></td>
          <td><div class="cell-stack"><span>${escapeHtml(log.requested_model || '-')}</span><small>${escapeHtml(log.upstream_model || '-')}</small></div></td>
          <td><div class="token-pair"><span>输入 <strong>${formatNumber(log.input_tokens)}</strong></span><span>输出 <strong>${formatNumber(log.output_tokens)}</strong></span></div></td>
          <td class="monospace">${formatCost(log.cost)}</td>
          <td>${formatDuration(log.duration_ms)}</td>
          <td><span class="status-label ${successful ? 'enabled' : 'disabled'}" title="${escapeHtml(statusTitle)}">${escapeHtml(log.status || 'Error')}</span></td>
        </tr>`;
      }).join('');
      const page = Math.floor(state.usageOffset / state.usageLimit) + 1;
      const pages = Math.max(1, Math.ceil(state.usageTotal / state.usageLimit));
      byId('usagePageMeta').textContent = `第 ${page} / ${pages} 页`;
      byId('usagePrevious').disabled = state.usageOffset === 0;
      byId('usageNext').disabled = state.usageOffset + state.usageLimit >= state.usageTotal;
    } catch (error) { showToast(error.message, true); }
  }

  async function clearUsage() {
    if (!window.confirm('清空全部使用记录？')) return;
    try { await requestJson('/admin/usage', { method: 'DELETE' }); await loadUsage(); }
    catch (error) { showToast(error.message, true); }
  }

  function renderTrend() {
    const trend = state.trend;
    if (!trend || !window.echarts) return;
    const accountName = byId('trendAccount').value;
    const modelName = byId('trendModel').value;
    const groupBy = byId('trendGroup').value;
    const metric = byId('trendMetric').value;
    const metricLabels = {
      total_tokens: '总 Tokens', input: '输入 Tokens', output: '输出 Tokens', count: '调用次数', cost: '费用 ($)',
    };
    const filteredTargets = bucket => (bucket.byTarget || []).filter(target =>
      (!accountName || target.account_name === accountName) && (!modelName || target.model === modelName));
    const primaryName = target => groupBy === 'model' ? target.model : target.account_name;
    const secondaryName = target => groupBy === 'model' ? target.account_name : target.model;
    const metricValue = target => {
      if (metric === 'total_tokens') return Number(target.input || 0) + Number(target.output || 0);
      return Number(target[metric] || 0);
    };
    const combinations = new Map();
    for (const bucket of trend.buckets) {
      for (const target of filteredTargets(bucket)) {
        const primary = primaryName(target);
        const secondary = secondaryName(target);
        if (primary && secondary) combinations.set(`${primary}\u0000${secondary}`, { primary, secondary });
      }
    }
    const orderedCombinations = [...combinations.values()].sort((left, right) =>
      left.primary.localeCompare(right.primary) || left.secondary.localeCompare(right.secondary));
    const secondaryGroups = [...new Set(orderedCombinations.map(item => item.secondary))];
    const palette = ['#3b82f6', '#14b8a6', '#f59e0b', '#8b5cf6', '#f43f5e', '#22c55e', '#06b6d4', '#64748b'];
    const series = orderedCombinations.map(item => ({
      name: `${item.primary} / ${item.secondary}`,
      type: 'bar',
      stack: item.primary,
      barMaxWidth: 34,
      emphasis: { focus: 'series' },
      itemStyle: {
        color: palette[secondaryGroups.indexOf(item.secondary) % palette.length],
        opacity: 0.9,
      },
      data: trend.buckets.map(bucket => filteredTargets(bucket)
        .filter(target => primaryName(target) === item.primary && secondaryName(target) === item.secondary)
        .reduce((sum, target) => sum + metricValue(target), 0)),
    }));
    const actualTotalTokens = trend.buckets.map(bucket => filteredTargets(bucket).reduce(
      (sum, target) => sum + Number(target.input || 0) + Number(target.output || 0),
      0,
    ));
    series.push({
      name: '实际总 Tokens', type: 'line', data: actualTotalTokens, smooth: true,
      yAxisIndex: metric === 'total_tokens' ? 0 : 1,
      symbol: 'circle', symbolSize: 6, z: 10,
      lineStyle: { color: '#1f2937', width: 3 },
      itemStyle: { color: '#1f2937', borderColor: '#ffffff', borderWidth: 1 },
    });
    if (!state.trendChart) state.trendChart = window.echarts.init(byId('usageTrendChart'));
    const compactChart = byId('usageTrendChart').clientWidth < 620;
    state.trendChart.setOption({
      animationDuration: 280,
      color: palette,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: value => metric === 'cost' ? `$${Number(value).toFixed(6)}` : Intl.NumberFormat('zh-CN').format(value),
      },
      legend: {
        type: 'scroll', orient: 'horizontal', left: 'center', width: compactChart ? '92%' : '84%', bottom: 8,
        data: series.map(item => item.name), textStyle: { color: '#344054', fontSize: compactChart ? 10 : 11 },
        pageTextStyle: { color: '#667085' },
      },
      grid: {
        top: 46,
        right: metric === 'total_tokens' ? 18 : (compactChart ? 52 : 68),
        bottom: trend.range === 'month' ? 96 : 68,
        left: compactChart ? 58 : 72,
      },
      xAxis: {
        type: 'category',
        data: trend.buckets.map(bucket => bucket.key.slice(5)),
        axisTick: { alignWithLabel: true },
        axisLabel: { color: '#667085', fontSize: 11 },
        axisLine: { lineStyle: { color: '#d9dee7' } },
      },
      yAxis: [
        {
          type: 'value', name: metricLabels[metric], minInterval: metric === 'count' ? 1 : 0,
          nameTextStyle: { color: '#667085' }, axisLabel: { color: '#667085' },
          splitLine: { lineStyle: { color: '#edf0f3' } },
        },
        {
          type: 'value', name: '实际总 Tokens', show: metric !== 'total_tokens',
          nameTextStyle: { color: '#667085' }, axisLabel: { color: '#667085' },
          splitLine: { show: false },
        },
      ],
      dataZoom: trend.range === 'month' ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 36 }] : [],
      series,
    }, {
      notMerge: true,
    });
    state.trendChart.resize();
  }

  async function loadStats() {
    try {
      const data = await requestJson(`/admin/usage/stats?range=${state.statsRange}`);
      const cumulative = data.cumulative || {};
      byId('statsSummary').innerHTML = `<span>总调用 <strong>${formatNumber(cumulative.total_count)}</strong></span><span>成功 <strong class="positive">${formatNumber(cumulative.success_count)}</strong></span><span>失败 <strong class="negative">${formatNumber(cumulative.fail_count)}</strong></span><span>总 Tokens <strong>${formatNumber(cumulative.total_tokens)}</strong></span><span>累计费用 <strong>${formatCost(cumulative.total_cost)}</strong></span>`;
      byId('accountStatsBody').innerHTML = (cumulative.byAccount || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${formatNumber(item.count)}</td><td>${formatNumber(item.input)}</td><td>${formatNumber(item.output)}</td><td>${formatNumber(item.cache)}</td><td>${formatCost(item.cost)}</td></tr>`).join('');
      byId('modelStatsBody').innerHTML = (cumulative.byModel || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${formatNumber(item.count)}</td><td>${formatNumber(item.input)}</td><td>${formatNumber(item.output)}</td><td>${formatNumber(item.cache)}</td><td>${formatCost(item.cost)}</td></tr>`).join('');
      const recent = data.recent5h || {};
      byId('recentStatsBody').innerHTML = (recent.byAccount || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${formatNumber(item.count)}</td><td>${formatNumber(item.input)}</td><td>${formatNumber(item.output)}</td><td>${formatNumber(item.cache)}</td><td>${formatCost(item.cost)}</td></tr>`).join('');
      state.trend = data.trend;
      const targets = (state.trend?.buckets || []).flatMap(bucket => bucket.byTarget || []);
      const accountNames = [...new Set(targets.map(target => target.account_name).filter(Boolean))].sort();
      const modelNames = [...new Set(targets.map(target => target.model).filter(Boolean))].sort();
      const trendAccount = byId('trendAccount');
      const trendModel = byId('trendModel');
      const selectedAccount = trendAccount.value;
      const selectedModel = trendModel.value;
      trendAccount.innerHTML = '<option value="">全部账号</option>' + accountNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
      trendModel.innerHTML = '<option value="">全部模型</option>' + modelNames.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
      trendAccount.value = accountNames.includes(selectedAccount) ? selectedAccount : '';
      trendModel.value = modelNames.includes(selectedModel) ? selectedModel : '';
      renderTrend();
    } catch (error) { showToast(error.message, true); }
  }

  async function loadStatus() {
    try {
      const data = await requestJson('/admin/status');
      byId('statusEnabled').checked = data.settings?.enabled !== false;
      byId('statusInterval').value = String(data.settings?.interval_minutes || 5);
      state.statusSnapshots = data.snapshots || [];
      renderStatus();
    } catch (error) { showToast(error.message, true); }
  }

  function statusPresentation(result) {
    if (!result) return { key: 'unknown', label: '无数据' };
    const timedOut = [408, 504].includes(Number(result.status)) || /tim(?:e|ed)[ -]?out/i.test(String(result.error || ''));
    if (timedOut) return { key: 'failed', label: '超时' };
    if (!result.ok) return { key: 'failed', label: '异常' };
    if (Number(result.latency_ms || 0) > SLOW_LATENCY_MS) return { key: 'warning', label: '缓慢' };
    return { key: 'healthy', label: '正常' };
  }

  function modelAvailability(accountId, model) {
    let total = 0;
    let healthy = 0;
    for (const snapshot of state.statusSnapshots) {
      const result = (snapshot.results || []).find(item => item.account_id === accountId && item.model === model);
      if (!result) continue;
      total += 1;
      if (result.ok === true) healthy += 1;
    }
    if (!total) return null;
    return {
      total,
      healthy,
      rate: Math.round((healthy / total) * 100),
    };
  }

  function renderStatus() {
    const snapshots = state.statusSnapshots;
    const latestSnapshot = snapshots[0];
    const accounts = new Map();
    for (const snapshot of snapshots) {
      for (const result of snapshot.results || []) {
        const account = accounts.get(result.account_id) || { id: result.account_id, name: result.account_name, targets: new Map() };
        if (!account.targets.has(result.model)) account.targets.set(result.model, result);
        accounts.set(result.account_id, account);
      }
    }
    const accountFilter = byId('statusAccount');
    const selectedAccount = accountFilter.value;
    accountFilter.innerHTML = '<option value="">全部账号</option>' + [...accounts.values()]
      .map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join('');
    accountFilter.value = accounts.has(selectedAccount) ? selectedAccount : '';

    const latestResults = (latestSnapshot?.results || []).filter(result => !accountFilter.value || result.account_id === accountFilter.value);
    const presentations = latestResults.map(statusPresentation);
    const healthy = presentations.filter(item => item.key === 'healthy').length;
    const warnings = presentations.filter(item => item.key === 'warning').length;
    const failures = presentations.filter(item => item.key === 'failed').length;
    byId('statusSummary').innerHTML = `<span>监测目标 <strong>${formatNumber(latestResults.length)}</strong></span><span>正常 <strong class="positive">${formatNumber(healthy)}</strong></span><span>缓慢 <strong class="warning-text">${formatNumber(warnings)}</strong></span><span>超时/异常 <strong class="negative">${formatNumber(failures)}</strong></span>`;
    byId('statusLastCheck').textContent = latestSnapshot?.checked_at
      ? `最近检测 ${new Date(latestSnapshot.checked_at).toLocaleString('zh-CN', { hour12: false })}`
      : '尚未检测';

    const history = snapshots.slice(0, 24).reverse();
    const visibleAccounts = [...accounts.values()].filter(account => !accountFilter.value || account.id === accountFilter.value);
    byId('statusTimelineBody').innerHTML = visibleAccounts.length ? visibleAccounts.map(account => {
      const latestForAccount = latestResults.filter(result => result.account_id === account.id);
      const accountStates = latestForAccount.map(statusPresentation);
      const healthyForAccount = accountStates.filter(item => item.key === 'healthy').length;
      const warningForAccount = accountStates.filter(item => item.key === 'warning').length;
      const failedForAccount = accountStates.filter(item => item.key === 'failed').length;
      const modelItems = [...account.targets].map(([model, target]) => {
        const latest = latestForAccount.find(result => result.model === model) || target;
        const current = statusPresentation(latest);
        const availability = modelAvailability(account.id, model);
        const availabilityTitle = availability
          ? `可用率 ${availability.rate}%（${availability.healthy}/${availability.total} 次成功）`
          : '暂无可用率数据';
        const availabilityTag = availability
          ? `<span class="availability-tag" title="${escapeHtml(availabilityTitle)}">${availability.rate}%</span>`
          : '';
        const segments = history.map(snapshot => {
          const result = (snapshot.results || []).find(item => item.account_id === account.id && item.model === model);
          const presentation = statusPresentation(result);
          const title = `${new Date(snapshot.checked_at).toLocaleString('zh-CN', { hour12: false })} · ${result ? `${presentation.label}${result.error ? ` · ${result.error}` : ''}` : '无数据'}`;
          return `<span class="status-segment ${presentation.key}" title="${escapeHtml(title)}"></span>`;
        }).join('');
        return `<article class="status-model-item">
          <header><div class="status-model-heading"><strong class="status-model-name" title="${escapeHtml(model)}">${escapeHtml(model)}</strong>${availabilityTag}</div><span class="status-label ${current.key}">${current.label}</span></header>
          <div class="status-model-meta"><span>${formatDuration(latest.latency_ms)}</span><span title="${escapeHtml(latest.error || '')}">${escapeHtml(latest.error || `HTTP ${latest.status || 0}`)}</span></div>
          <div class="status-strip">${segments}</div>
        </article>`;
      }).join('');
      return `<section class="status-account-group">
        <header><h3>${escapeHtml(account.name)}</h3><span>${healthyForAccount} 正常${warningForAccount ? ` · ${warningForAccount} 缓慢` : ''}${failedForAccount ? ` · ${failedForAccount} 超时/异常` : ''} · ${latestForAccount.length} 模型</span></header>
        <div class="status-model-grid">${modelItems}</div>
      </section>`;
    }).join('') : '<div class="inline-empty">暂无检测结果</div>';
  }

  async function saveStatusSettings() {
    try {
      await requestJson('/admin/status/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: byId('statusEnabled').checked, interval_minutes: Number(byId('statusInterval').value) }),
      });
      showToast('检测设置已保存');
    } catch (error) { showToast(error.message, true); }
  }

  async function runStatusCheck() {
    const button = byId('runStatusButton');
    button.disabled = true;
    try {
      const data = await requestJson('/admin/status/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      state.statusSnapshots.unshift(data.snapshot);
      state.statusSnapshots = state.statusSnapshots.slice(0, 288);
      renderStatus();
      showToast('检测完成');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
  }

  function viewFromPath(pathname = window.location.pathname) {
    const normalized = pathname.replace(/\/+$/, '') || '/';
    if (normalized === '/admin/usage') return 'usage';
    if (normalized === '/admin/stats') return 'stats';
    if (normalized === '/admin/status') return 'status';
    return 'accounts';
  }

  function switchView(view, { push = false } = {}) {
    const nextView = VIEWS[view] ? view : 'accounts';
    const route = VIEWS[nextView];
    state.currentView = nextView;
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('is-active', button.dataset.view === nextView));
    document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('is-active', panel.dataset.viewPanel === nextView));
    byId('pageTitle').textContent = route.title;
    document.title = `${route.title} · LLM-APIs 管理后台`;
    if (push && window.location.pathname !== route.path) {
      window.history.pushState({ view: nextView }, '', route.path);
    } else if (!push && (window.location.pathname === '/admin' || window.location.pathname === '/admin/')) {
      window.history.replaceState({ view: nextView }, '', route.path);
    }
    if (nextView === 'accounts') {
      loadAccounts();
    } else {
      loadAccounts().then(() => {
        if (nextView === 'usage') loadUsage();
        if (nextView === 'stats') loadStats();
        if (nextView === 'status') loadStatus();
      });
    }
    byId('sidebar').classList.remove('is-open');
    byId('sidebarScrim').classList.remove('is-visible');
  }

  document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchView(link.dataset.view, { push: true });
  }));
  window.addEventListener('popstate', () => switchView(viewFromPath()));
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  byId('addAccountButton').addEventListener('click', () => openAccount());
  byId('closeDialogButton').addEventListener('click', () => dialog.close());
  byId('cancelDialogButton').addEventListener('click', () => dialog.close());
  byId('closeTestDialog').addEventListener('click', () => testDialog.close());
  byId('selectAllTestModels').addEventListener('click', () => {
    document.querySelectorAll('[data-test-index]').forEach(input => { input.checked = true; });
    updateTestSelectionSummary();
  });
  byId('clearTestModels').addEventListener('click', () => {
    document.querySelectorAll('[data-test-index]').forEach(input => { input.checked = false; });
    updateTestSelectionSummary();
  });
  byId('startTestModels').addEventListener('click', runSelectedAccountTests);
  byId('testResultsBody').addEventListener('change', event => {
    if (event.target.matches('[data-test-index]')) updateTestSelectionSummary();
  });
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
  byId('usageFilters').addEventListener('submit', event => {
    event.preventDefault();
    state.usageOffset = 0;
    loadUsage();
  });
  byId('usageFilters').addEventListener('reset', () => {
    setTimeout(() => { setDefaultUsageDates(); state.usageOffset = 0; loadUsage(); }, 0);
  });
  byId('usagePrevious').addEventListener('click', () => {
    state.usageOffset = Math.max(0, state.usageOffset - state.usageLimit);
    loadUsage();
  });
  byId('usageNext').addEventListener('click', () => {
    state.usageOffset += state.usageLimit;
    loadUsage();
  });
  byId('clearUsageButton').addEventListener('click', clearUsage);
  byId('refreshStatsButton').addEventListener('click', loadStats);
  document.querySelectorAll('[data-stats-range]').forEach(button => button.addEventListener('click', () => {
    state.statsRange = button.dataset.statsRange;
    document.querySelectorAll('[data-stats-range]').forEach(item => item.classList.toggle('is-active', item === button));
    loadStats();
  }));
  byId('trendAccount').addEventListener('change', renderTrend);
  byId('trendModel').addEventListener('change', renderTrend);
  byId('trendGroup').addEventListener('change', renderTrend);
  byId('trendMetric').addEventListener('change', renderTrend);
  window.addEventListener('resize', () => {
    state.trendChart?.resize();
    renderTrend();
  });
  byId('statusEnabled').addEventListener('change', saveStatusSettings);
  byId('statusInterval').addEventListener('change', saveStatusSettings);
  byId('statusAccount').addEventListener('change', renderStatus);
  byId('runStatusButton').addEventListener('click', runStatusCheck);
  byId('menuButton').addEventListener('click', () => {
    byId('sidebar').classList.add('is-open');
    byId('sidebarScrim').classList.add('is-visible');
  });
  byId('sidebarScrim').addEventListener('click', () => {
    byId('sidebar').classList.remove('is-open');
    byId('sidebarScrim').classList.remove('is-visible');
  });

  refreshIcons();
  setDefaultUsageDates();
  switchView(viewFromPath(), { push: false });
})();
