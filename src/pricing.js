'use strict';

function response(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function createPricingHandler(repository, accountRepository) {
  return async function handlePricing(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/admin/pricing') return null;
    if (request.method === 'GET') {
      const prices = await repository.list();
      const accounts = await accountRepository.list();
      const models = [...new Set(accounts.flatMap(account => [
        ...(account.models || []), ...Object.values(account.model_map || {}),
      ]))].sort((a, b) => a.localeCompare(b));
      return response({ success: true, prices, models });
    }
    if (request.method === 'POST') {
      const input = await request.json();
      const model = String(input.model || '').trim();
      if (!model) return response({ success: false, error: 'model is required' }, 400);
      await repository.save(model, input);
      return response({ success: true });
    }
    if (request.method === 'DELETE') {
      const model = url.searchParams.get('model');
      if (!model) return response({ success: false, error: 'model is required' }, 400);
      await repository.delete(model);
      return response({ success: true });
    }
    return response({ success: false, error: 'Method not allowed' }, 405);
  };
}

module.exports = { createPricingHandler };
