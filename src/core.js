'use strict';

function createCoreHandler(accountRepository) {
  return async function handleCore(request) {
    const url = new URL(request.url);
    if ((url.pathname === '/v1/models' || url.pathname === '/v3/models') && request.method === 'GET') {
      const accounts = await accountRepository.list();
      const models = [...new Set(accounts
        .filter(account => account.enabled !== false)
        .flatMap(account => [...(account.models || []), ...Object.keys(account.model_map || {})]))];
      return Response.json({
        object: 'list',
        data: models.sort().map(id => ({ id, object: 'model', created: 0, owned_by: 'llm-apis' })),
      });
    }
    return Response.json({ error: 'Not found', admin: '/admin' }, { status: 404 });
  };
}

module.exports = { createCoreHandler };
