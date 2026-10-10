import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract tests for the SSH & Keys page and the inline ValidatePanel.
// The client has no component test runner (and no new deps are allowed),
// so these tests statically assert the components implement the backend API
// contracts from web/server/server.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sshPath = path.join(root, 'web/client/src/pages/SshKeysPage.tsx');
const validatePath = path.join(root, 'web/client/src/components/ValidatePanel.tsx');
const editPath = path.join(root, 'web/client/src/pages/ProjectEditPage.tsx');
const systemPath = path.join(root, 'web/client/src/pages/SystemPage.tsx');
const appPath = path.join(root, 'web/client/src/App.tsx');
const sidebarPath = path.join(root, 'web/client/src/components/layout/Sidebar.tsx');

const ssh = await readFile(sshPath, 'utf8');
const validate = await readFile(validatePath, 'utf8');
const edit = await readFile(editPath, 'utf8');
const system = await readFile(systemPath, 'utf8');
const app = await readFile(appPath, 'utf8');
const sidebar = await readFile(sidebarPath, 'utf8');

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

describe('ValidatePanel contract', () => {
  it('exports useValidation, ValidateActions and ValidationResults', () => {
    assert.match(validate, /export function useValidation\(/);
    assert.match(validate, /export function ValidateActions\(/);
    assert.match(validate, /export function ValidationResults\(/);
    assert.match(validate, /projectId/);
    assert.match(validate, /globalYaml/);
    assert.match(validate, /saveButton/);
  });

  it('supports a compact mode hiding heading, description and tag override', () => {
    assert.match(validate, /compact/);
    assert.ok(validate.includes('!compact'), 'heading/tag input must be gated behind compact');
  });

  it('POSTs drafts to /api/validate with projectId and tag override', () => {
    assert.match(validate, /api\.post<.*>\('\/api\/validate'/);
    assert.match(validate, /projectId/);
    assert.match(validate, /tagOverride/);
  });

  it('renders actions for use directly under the editor, save left of Run validation', () => {
    assert.ok(validate.includes('{saveButton}'), 'save button must be rendered in the actions');
    assert.ok(
      validate.indexOf('{saveButton}') < validate.indexOf('validate-panel-run-button'),
      'save button must come before the Run validation button',
    );
    assert.match(validate, /data-ref="validate-actions"/);
  });

  it('shows an ok Badge, output lines in <pre>, and errors via role=alert', () => {
    assert.match(validate, /<Badge/);
    assert.match(validate, /<pre/);
    assert.match(validate, /role="alert"/);
  });

  it('POSTs drafts to /api/manifest and renders warnings plus YAML in a ~500px scrollable <pre>', () => {
    assert.match(validate, /api\.post<.*>\('\/api\/manifest'/);
    assert.match(validate, /warnings/i);
    assert.match(validate, /maxHeight: 500/);
    assert.match(validate, /overflow: 'auto'/);
  });

  it('notes that secrets are redacted', () => {
    assert.match(validate, /redacted/i);
  });
});

describe('ValidatePanel placement contract', () => {
  it('renders validation actions directly under the YamlEditor in ProjectEditPage', () => {
    assert.match(edit, /YamlEditor/);
    assert.match(edit, /ValidateActions/);
    assert.match(edit, /ValidationResults/);
    assert.match(edit, /useValidation/);
    assert.ok(
      edit.indexOf('edit-project-yaml') < edit.indexOf('validate-panel-run-button') ||
        edit.includes('ValidateActions'),
      'actions must sit with the editor',
    );
    assert.ok(edit.includes('page-project-edit-validate-section'), 'missing results section below editor');
  });

  it('passes the live editor draft and save button into the actions in ProjectEditPage', () => {
    assert.ok(edit.includes('draft={{ yaml }}'), 'must pass the unsaved editor draft, not the saved file');
    assert.match(edit, /saveButton=\{/);
    assert.ok(edit.includes('page-project-edit-config-save'), 'save button ref must be kept');
  });

  it('renders validation actions directly under the YamlEditor in SystemPage', () => {
    assert.match(system, /YamlEditor/);
    assert.match(system, /ValidateActions/);
    assert.match(system, /ValidationResults/);
    assert.ok(!system.includes('page-system-global-validate'), 'results must not be wrapped in an extra div');
  });

  it('passes the live global draft and save button into the actions in SystemPage', () => {
    assert.ok(system.includes('draft={{ globalYaml: yaml }}'), 'must pass the unsaved global draft, not the saved file');
    assert.match(system, /saveButton=\{/);
    assert.ok(system.includes('page-system-submit-global'), 'save button ref must be kept');
  });

  it('uses compact mode on SystemPage (buttons only, no heading/tag override)', () => {
    assert.ok(system.includes('compact'), 'SystemPage must render the panel in compact mode');
  });

  it('removes the standalone /validate route, nav entry and page', () => {
    assert.ok(!app.includes('ValidatePage'), 'App must not reference ValidatePage');
    assert.ok(!app.includes('path="validate"'), 'App must not route /validate');
    assert.ok(!sidebar.includes("'/validate'"), 'Sidebar must not link to /validate');
    assert.ok(!sidebar.includes('Validate'), 'Sidebar must not show a Validate entry');
  });
});
