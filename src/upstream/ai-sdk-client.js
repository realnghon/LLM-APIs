'use strict';

const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
const { generateText } = require('ai');
const { proxyAnthropic } = require('./anthropic-client');

function testItems(account) {
  const items = (account.models || []).map(model => ({ label: `${model}（原始）`, model }));
  for (const [clientModel, upstreamModel] of Object.entries(account.model_map || {})) {
    items.push({ label: `${clientModel} → ${upstreamModel}`, model: upstreamModel });
  }
  return items;
}

async function testOpenAIAccount(account, indices) {
  const allItems = testItems(account);
  const selected = Array.isArray(indices) && indices.length
    ? indices.filter(index => Number.isInteger(index) && allItems[index]).map(index => allItems[index])
    : allItems;
  const provider = createOpenAICompatible({
    name: `llm-apis-${account.id}`,
    baseURL: String(account.base_url).replace(/\/+$/, ''),
    apiKey: account.api_key,
  });

  const results = [];
  for (const item of selected) {
    const startedAt = Date.now();
    try {
      await generateText({
        model: provider.chatModel(item.model),
        prompt: 'Reply with pong.',
        maxOutputTokens: 8,
        abortSignal: AbortSignal.timeout(15_000),
      });
      results.push({
        ...item,
        ok: true,
        status: 200,
        latency_ms: Date.now() - startedAt,
        error: '',
        retries: 0,
      });
    } catch (error) {
      results.push({
        ...item,
        ok: false,
        status: Number(error.statusCode || error.status || 0),
        latency_ms: Date.now() - startedAt,
        error: error.message || '请求失败',
        retries: 0,
      });
    }
  }
  return results;
}

async function testAnthropicAccount(account, indices) {
  const allItems = testItems(account);
  const selected = Array.isArray(indices) && indices.length
    ? indices.filter(index => Number.isInteger(index) && allItems[index]).map(index => allItems[index])
    : allItems;
  const results = [];
  for (const item of selected) {
    const startedAt = Date.now();
    try {
      const response = await proxyAnthropic({
        account,
        body: { messages: [{ role: 'user', content: 'Reply with pong.' }], max_tokens: 8, stream: false },
        requestedModel: item.model,
        upstreamModel: item.model,
      });
      if (!response.ok) throw new Error(`上游返回 ${response.status}`);
      results.push({ ...item, ok: true, status: 200, latency_ms: Date.now() - startedAt, error: '', retries: 0 });
    } catch (error) {
      results.push({ ...item, ok: false, status: Number(error.statusCode || error.status || 0), latency_ms: Date.now() - startedAt, error: error.message || '请求失败', retries: 0 });
    }
  }
  return results;
}

async function testAccount(account, indices) {
  return account.format === 'anthropic'
    ? testAnthropicAccount(account, indices)
    : testOpenAIAccount(account, indices);
}

module.exports = { testAccount, testItems };
