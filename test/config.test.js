'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadServicePort } = require('../src/config');

test('service defaults to port 8787 and allows an environment override', () => {
  assert.equal(loadServicePort({}), 8787);
  assert.equal(loadServicePort({ PORT: '4321' }), 4321);
});
