'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isFetchSafeTestPort } = require('./helpers/test-server');

test('test servers avoid the Fetch blocked port range', () => {
  assert.equal(isFetchSafeTestPort(6000), false);
  assert.equal(isFetchSafeTestPort(10080), false);
  assert.equal(isFetchSafeTestPort(10081), true);
  assert.equal(isFetchSafeTestPort(65535), true);
});
