import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOptionalTagArgs,
  buildSystemGcArgs,
  buildSystemInitArgs,
  parseKeepInput,
  trimTagValue,
} from '../web/client/src/lib/systemJobs.ts';

describe('trimTagValue', () => {
  it('trims surrounding whitespace', () => {
    assert.equal(trimTagValue('  v1.2.3  '), 'v1.2.3');
  });

  it('returns empty string for blank input', () => {
    assert.equal(trimTagValue('   '), '');
  });
});

describe('buildOptionalTagArgs (system-create / system-rollback)', () => {
  it('includes the trimmed tag when given', () => {
    assert.deepEqual(buildOptionalTagArgs(' v1.2.4 '), { tag: 'v1.2.4' });
  });

  it('omits tag when blank so the server auto-resolves (auto-bump / previous)', () => {
    assert.deepEqual(buildOptionalTagArgs(''), {});
    assert.deepEqual(buildOptionalTagArgs('   '), {});
  });
});

describe('parseKeepInput', () => {
  it('returns empty for blank input (server default)', () => {
    assert.deepEqual(parseKeepInput(''), {});
    assert.deepEqual(parseKeepInput('   '), {});
  });

  it('parses a positive integer', () => {
    assert.deepEqual(parseKeepInput('10'), { keep: 10 });
    assert.deepEqual(parseKeepInput(' 3 '), { keep: 3 });
  });

  it('rejects zero, negatives, fractions, and non-numbers', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '10x']) {
      const parsed = parseKeepInput(bad);
      assert.ok(parsed.error, `expected error for ${JSON.stringify(bad)}`);
      assert.equal(parsed.keep, undefined);
    }
  });
});

describe('buildSystemGcArgs', () => {
  it('omits keep and dryRun by default', () => {
    assert.deepEqual(buildSystemGcArgs('', false, false), { args: {} });
  });

  it('passes keep through and forces dryRun for previews', () => {
    assert.deepEqual(buildSystemGcArgs('5', false, true), { args: { keep: 5, dryRun: true } });
    assert.deepEqual(buildSystemGcArgs('', false, true), { args: { dryRun: true } });
  });

  it('honours the dry-run checkbox for real runs', () => {
    assert.deepEqual(buildSystemGcArgs('', true, false), { args: { dryRun: true } });
    assert.deepEqual(buildSystemGcArgs('7', true, false), { args: { keep: 7, dryRun: true } });
  });

  it('returns an error for an invalid keep value', () => {
    const res = buildSystemGcArgs('zero', false, false);
    assert.ok(res.error);
    assert.equal(res.args, undefined);
  });
});

describe('buildSystemInitArgs', () => {
  it('requires a tag', () => {
    const res = buildSystemInitArgs('   ', '10');
    assert.ok(res.error);
    assert.equal(res.args, undefined);
  });

  it('builds tag + keep, trimming both', () => {
    assert.deepEqual(buildSystemInitArgs(' v1.0.0 ', '10'), {
      args: { tag: 'v1.0.0', keep: 10 },
    });
  });

  it('omits keep when blank (server default)', () => {
    assert.deepEqual(buildSystemInitArgs('v1.0.0', ''), { args: { tag: 'v1.0.0' } });
  });

  it('returns an error for an invalid keep value', () => {
    const res = buildSystemInitArgs('v1.0.0', '-3');
    assert.ok(res.error);
    assert.equal(res.args, undefined);
  });
});
