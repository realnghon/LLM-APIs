'use strict';

const fs = require('fs/promises');
const path = require('path');
const { waitForFile, withFileLock } = require('./file-lock');

function decode(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function encode(value) {
  return JSON.stringify(value);
}

function withoutPoolFields(account, allowance, migratedRemaining) {
  const {
    pool_mode: _poolMode,
    pool_mode_retry_count: _retryCount,
    pool_retry_statuses: _retryStatuses,
    ...clean
  } = account;
  const independentAllowance = clean.allowance?.type === 'total'
    ? clean.allowance
    : (allowance ? {
      type: 'total',
      quota_mode: allowance.mode || 'usage',
      quota_expires_at: allowance.expires_at || '',
      quota_total: Number(allowance.initial_total || 0),
      quota_rates_text: allowance.rates_text || '',
      quota_display_currency: allowance.display_currency === true,
    } : null);
  if (independentAllowance) {
    independentAllowance.remaining = Math.max(0, Number(
      independentAllowance.remaining ?? migratedRemaining ?? independentAllowance.quota_total ?? 0,
    ));
  }
  return { ...clean, allowance: independentAllowance };
}

function quotaFromAccount(account) {
  const allowance = account.allowance;
  if (!allowance || allowance.type !== 'total') return null;
  return {
    enabled: true,
    mode: allowance.quota_mode || 'usage',
    expires_at: allowance.quota_expires_at || '',
    initial_total: Number(allowance.quota_total || 0),
    rates_text: allowance.quota_rates_text || '',
    display_currency: allowance.quota_display_currency === true,
    updated_at: account.updated_at,
  };
}

function createFileAccountRepository(dataFile) {
  async function readDocument() {
    try {
      return JSON.parse(await fs.readFile(dataFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function listFrom(document) {
    const quotas = decode(document.allowance_config, {}).account_quotas || {};
    const allowanceStatus = decode(document.allowance_status, {});
    const accounts = decode(document.accounts, []);
    if (!Array.isArray(accounts)) return [];
    return accounts.map(account => {
      const state = allowanceStatus[`target:account:${account.id}`] || {};
      return withoutPoolFields(account, quotas[account.id], state.remainingUnits);
    });
  }

  async function writeDocument(document, accounts) {
    const accountQuotas = {};
    for (const account of accounts) {
      const quota = quotaFromAccount(account);
      if (quota) accountQuotas[account.id] = quota;
    }
    document.accounts = encode(accounts);
    document.allowance_config = encode({ version: 1, account_quotas: accountQuotas });
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    const temporary = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(document, null, 2));
    await fs.rename(temporary, dataFile);
  }

  async function mutate(change) {
    return withFileLock(dataFile, async () => {
      const document = await readDocument();
      const accounts = await listFrom(document);
      const next = await change(accounts);
      await writeDocument(document, next);
    });
  }

  return {
    async list() {
      await waitForFile(dataFile);
      return listFrom(await readDocument());
    },
    async save(account) {
      await mutate(accounts => {
        const index = accounts.findIndex(item => item.id === account.id);
        if (index === -1) accounts.push(account);
        else accounts[index] = account;
        return accounts;
      });
      return account;
    },
    async delete(id) {
      await mutate(accounts => accounts.filter(account => account.id !== id));
    },
    async reorder(ids) {
      await mutate(accounts => {
        const positions = new Map(ids.map((id, index) => [id, index]));
        return accounts.slice().sort((left, right) => {
          const leftPosition = positions.has(left.id) ? positions.get(left.id) : Number.MAX_SAFE_INTEGER;
          const rightPosition = positions.has(right.id) ? positions.get(right.id) : Number.MAX_SAFE_INTEGER;
          return leftPosition - rightPosition;
        });
      });
    },
    async debitAllowance(id, amount) {
      await mutate(accounts => accounts.map(account => {
        if (account.id !== id || account.allowance?.type !== 'total') return account;
        const current = Number(account.allowance.remaining ?? account.allowance.quota_total ?? 0);
        return {
          ...account,
          allowance: { ...account.allowance, remaining: Math.max(0, current - Math.max(0, Number(amount || 0))) },
        };
      }));
    },
  };
}

module.exports = { createFileAccountRepository };
