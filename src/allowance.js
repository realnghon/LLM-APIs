'use strict';

function remaining(account) {
  const allowance = account?.allowance;
  if (!allowance || allowance.type !== 'total') return Infinity;
  return Math.max(0, Number(allowance.remaining ?? allowance.quota_total ?? 0));
}

function hasRemainingAllowance(account) {
  const expiresAt = account?.allowance?.quota_expires_at;
  if (expiresAt && expiresAt < new Date().toISOString().slice(0, 10)) return false;
  return remaining(account) > 0;
}

function parseRates(text) {
  const rates = {};
  for (const line of String(text || '').split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || parts[0].startsWith('#')) continue;
    const model = parts.shift();
    const values = {};
    for (const item of parts) {
      const separator = item.indexOf('=');
      if (separator < 1) continue;
      const value = Number(item.slice(separator + 1));
      if (Number.isFinite(value)) values[item.slice(0, separator)] = value;
    }
    rates[model] = values;
  }
  return rates;
}

function allowanceDebit(account, model, usage = {}) {
  const allowance = account?.allowance;
  if (!allowance || allowance.type !== 'total') return 0;
  if (allowance.quota_mode === 'count') return 1;
  const rates = parseRates(allowance.quota_rates_text);
  const rate = rates[model] || rates['*'];
  if (!rate) return 0;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cacheHit = Number(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0);
  const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
  const normalInput = Math.max(0, input - cacheHit - cacheCreate);
  const multiplier = Math.max(0, Number(rate.multiplier ?? 1));
  return Math.max(0, multiplier * (
    normalInput / 1_000_000 * Number(rate.input || 0) +
    output / 1_000_000 * Number(rate.output || 0) +
    cacheHit / 1_000_000 * Number(rate.cache_hit || 0) +
    cacheCreate / 1_000_000 * Number(rate.cache_create || 0)
  ));
}

module.exports = { allowanceDebit, hasRemainingAllowance, parseRates, remaining };
