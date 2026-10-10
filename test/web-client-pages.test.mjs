import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract tests for the SSH & Keys and Validate frontend pages.
// The client has no component test runner (and no new deps are allowed),
// so these tests statically assert the pages implement the backend API
// contracts from web/server/server.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sshPath = path.join(root, 'web/client/src/pages/SshKeysPage.tsx');
const validatePath = path.join(root, 'web/client/src/pages/ValidatePage.tsx');

const ssh = await readFile(sshPath, 'utf8');
const validate = await readFile(validatePath, 'utf8');

describe('SshKeysPage contract', () => {
  it('exports SshKeysPage', () => {
    assert.match(ssh, /export function SshKeysPage\(\)/);
  });

  it('consumes the shared projects module without creating it', () => {
    assert.match(ssh, /from '\.\.\/lib\/projects'/);
    assert.match(ssh, /ProjectPicker/);
    assert.match(ssh, /useProjects/);
  });

  it('loads aliases from GET /api/ssh-list', () => {
    assert.match(ssh, /\/api\/ssh-list/);
    for (const col of ['Alias', 'Host', 'Port', 'User', 'IdentityFile']) {
      assert.ok(ssh.includes(col), `missing column ${col}`);
    }
  });

  it('shows an EmptyState hinting to deploy a project when there are no aliases', () => {
    assert.match(ssh, /EmptyState/);
    assert.ok(ssh.includes('Deploy a project to register one.'));
  });

  it('starts a list-update job with a dryRun flag and no projectId', () => {
    assert.match(ssh, /list-update/);
    assert.match(ssh, /dryRun/);
    assert.match(ssh, /type="checkbox"/);
    assert.ok(!ssh.includes("op: 'list-update',\n        projectId"), 'list-update must not send projectId');
  });

  it('notes that node IPs go stale after node changes', () => {
    assert.match(ssh, /stale/i);
  });

  it('fetches the key via GET /api/key for the active project', () => {
    assert.match(ssh, /\/api\/key\?projectId=/);
    assert.match(ssh, /activeProjectId/);
    assert.match(ssh, /fingerprint/);
  });

  it('confirms before posting a key-rotate job with force', () => {
    assert.match(ssh, /window\.confirm/);
    assert.match(ssh, /key-rotate/);
    assert.match(ssh, /force: true/);
  });

  it('warns that rotation invalidates access and redeploy is needed', () => {
    assert.match(ssh, /invalidates/i);
    assert.match(ssh, /redeploy/i);
  });
});

describe('ValidatePage contract', () => {
  it('exports ValidatePage', () => {
    assert.match(validate, /export function ValidatePage\(\)/);
  });

  it('consumes the shared projects module without creating it', () => {
    assert.match(validate, /from '\.\.\/lib\/projects'/);
    assert.match(validate, /ProjectPicker/);
    assert.match(validate, /useProjects/);
  });

  it('runs GET /api/validate with projectId and tag override', () => {
    assert.match(validate, /\/api\/validate\?/);
    assert.match(validate, /projectId/);
    assert.match(validate, /tagOverride/);
  });

  it('shows an ok Badge, output lines in <pre>, and errors via role=alert', () => {
    assert.match(validate, /<Badge/);
    assert.match(validate, /<pre/);
    assert.match(validate, /role="alert"/);
  });

  it('loads GET /api/manifest and renders warnings plus YAML in a ~500px scrollable <pre>', () => {
    assert.match(validate, /\/api\/manifest\?/);
    assert.match(validate, /warnings/i);
    assert.match(validate, /maxHeight: 500/);
    assert.match(validate, /overflow: 'auto'/);
  });

  it('notes that secrets are redacted', () => {
    assert.match(validate, /redacted/i);
  });
});
