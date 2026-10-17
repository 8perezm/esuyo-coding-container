import test from 'node:test';
import assert from 'node:assert/strict';
import { getUpdateNotice } from './update-notice.ts';

test('getUpdateNotice: hidden without a reported update', () => {
  for (const status of [null, undefined, { state: 'unknown' }, { state: 'checking' }, { state: 'none' }]) {
    // @ts-expect-error intentional nullish inputs
    assert.equal(getUpdateNotice(status).visible, false);
  }
});

test('getUpdateNotice: available update links to the download location', () => {
  assert.deepEqual(getUpdateNotice({ state: 'available' }), {
    visible: true,
    label: 'Update available',
    action: 'download',
  });
  assert.deepEqual(getUpdateNotice({ state: 'available', version: '1.0.16' }), {
    visible: true,
    label: 'Update 1.0.16 available',
    action: 'download',
  });
});

test('getUpdateNotice: downloaded update installs on select', () => {
  assert.deepEqual(getUpdateNotice({ state: 'ready' }), {
    visible: true,
    label: 'Update ready — restart to install',
    action: 'install',
  });
  assert.deepEqual(getUpdateNotice({ state: 'ready', version: '1.0.16' }), {
    visible: true,
    label: 'Update 1.0.16 ready — restart to install',
    action: 'install',
  });
});
