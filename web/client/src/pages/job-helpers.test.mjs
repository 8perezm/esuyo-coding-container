import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSetupArgs,
  formatDateTime,
  jobTone,
  parseKeep,
  shortId,
} from './job-helpers.ts';

test('jobTone: running=accent, error=violet, done/other=default', () => {
  assert.equal(jobTone('running'), 'accent');
  assert.equal(jobTone('error'), 'violet');
  assert.equal(jobTone('done'), 'default');
  assert.equal(jobTone('queued'), 'default');
  assert.equal(jobTone(''), 'default');
});

test('formatDateTime: empty/invalid passthrough, valid ISO localizes', () => {
  assert.equal(formatDateTime(undefined), '—');
  assert.equal(formatDateTime(null), '—');
  assert.equal(formatDateTime(''), '—');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
  const out = formatDateTime('2026-10-10T12:00:00.000Z');
  assert.ok(out !== '2026-10-10T12:00:00.000Z', `expected localized date, got ${out}`);
});

test('shortId: truncates long ids, keeps short ones', () => {
  assert.equal(shortId('abcdef1234567890'), 'abcdef12');
  assert.equal(shortId('abc'), 'abc');
  assert.equal(shortId(''), '—');
});

test('parseKeep: empty means server default; non-negative integers ok', () => {
  assert.deepEqual(parseKeep(''), {});
  assert.deepEqual(parseKeep('   '), {});
  assert.deepEqual(parseKeep('5'), { keep: 5 });
  assert.deepEqual(parseKeep(' 10 '), { keep: 10 });
  assert.deepEqual(parseKeep('0'), { keep: 0 });
});

test('parseKeep: rejects non-integer and negative input', () => {
  assert.ok(parseKeep('abc').error);
  assert.ok(parseKeep('2.5').error);
  assert.ok(parseKeep('-1').error);
  assert.ok(parseKeep('NaN').error);
});

test('buildSetupArgs: drops blank fields, trims the rest', () => {
  assert.deepEqual(buildSetupArgs('', '  ', '\t'), {});
  assert.deepEqual(buildSetupArgs(' registry.example.com/you ', '', ''), {
    registry: 'registry.example.com/you',
  });
  assert.deepEqual(buildSetupArgs('r.io/you', '10.0.0.5', '/workspaces'), {
    registry: 'r.io/you',
    nfsServer: '10.0.0.5',
    nfsBasePath: '/workspaces',
  });
});
