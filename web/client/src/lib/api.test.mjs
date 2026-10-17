import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBroadcastUnauthorized } from './api.ts';

test('shouldBroadcastUnauthorized: 401 from authenticated endpoints signs out', () => {
  assert.equal(shouldBroadcastUnauthorized('/api/cluster/summary', 401), true);
  assert.equal(shouldBroadcastUnauthorized('/api/me', 401), true);
  assert.equal(shouldBroadcastUnauthorized('/api/projects', 401), true);
});

test('shouldBroadcastUnauthorized: sign-in failures stay on the login form', () => {
  assert.equal(shouldBroadcastUnauthorized('/api/login', 401), false);
  assert.equal(shouldBroadcastUnauthorized('/api/register', 401), false);
});

test('shouldBroadcastUnauthorized: non-401 never broadcasts', () => {
  assert.equal(shouldBroadcastUnauthorized('/api/me', 200), false);
  assert.equal(shouldBroadcastUnauthorized('/api/me', 500), false);
  assert.equal(shouldBroadcastUnauthorized('/api/login', 500), false);
});
