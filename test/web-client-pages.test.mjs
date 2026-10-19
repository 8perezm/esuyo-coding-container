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
const terminalPath = path.join(root, 'web/client/src/pages/SshTerminalPage.tsx');
const validatePath = path.join(root, 'web/client/src/components/ValidatePanel.tsx');
const editPath = path.join(root, 'web/client/src/pages/ProjectEditPage.tsx');
const createPath = path.join(root, 'web/client/src/pages/ProjectCreatePage.tsx');
const systemPath = path.join(root, 'web/client/src/pages/SystemPage.tsx');
const appPath = path.join(root, 'web/client/src/App.tsx');
const sidebarPath = path.join(root, 'web/client/src/components/layout/Sidebar.tsx');

const ssh = await readFile(sshPath, 'utf8');
const terminal = await readFile(terminalPath, 'utf8');
const validate = await readFile(validatePath, 'utf8');
const edit = await readFile(editPath, 'utf8');
const create = await readFile(createPath, 'utf8');
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

  it('fetches the key via GET /api/key for the selected project', () => {
    assert.match(ssh, /\/api\/key\?projectId=/);
    assert.match(ssh, /selectedId/);
    assert.match(ssh, /fingerprint/);
  });

  it('confirms before posting a key-rotate job with force', () => {
    assert.match(ssh, /ConfirmDialog/);
    assert.match(ssh, /showRotateConfirm/);
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

describe('Project create/edit contract (managed configs + starter)', () => {
  it('create page is name-only and posts just the name', () => {
    assert.match(create, /export function ProjectCreatePage\(\)/);
    assert.ok(create.includes('page-project-create-input-name'), 'missing name input ref');
    assert.ok(!create.includes('page-project-create-input-config-path'), 'create page must not ask for a config path');
    assert.ok(create.includes("'/api/projects'"), 'must POST to /api/projects');
    assert.ok(create.includes('/projects/${encodeURIComponent(res.project.id)}/edit'), 'must land on the edit page to fill the config');
  });

  it('edit page keeps the path field and offers fill/download starter actions', () => {
    assert.ok(edit.includes('page-project-edit-input-config-path'), 'settings must keep the config path field');
    assert.ok(edit.includes('page-project-edit-config-fill'), 'missing fill-with-example button');
    assert.ok(edit.includes('page-project-edit-config-download'), 'missing download-example button');
    assert.ok(edit.includes('/api/project-starter?projectId='), 'must fetch the starter from /api/project-starter');
  });
});

describe('SshTerminalPage tabs contract', () => {
  it('exports SshTerminalPage', () => {
    assert.match(terminal, /export function SshTerminalPage\(\)/);
  });

  it('renders one unified bar with a trigger per tab plus new-tab and close-tab controls', () => {
    assert.ok(terminal.includes('page-project-ssh-unified-bar'), 'missing unified bar ref');
    assert.ok(!terminal.includes('page-project-ssh-tabbar'), 'old tabbar ref must be gone');
    assert.ok(!terminal.includes('page-project-ssh-statusbar'), 'old statusbar ref must be gone');
    assert.ok(terminal.includes('page-project-ssh-tablist'), 'missing tablist ref');
    assert.ok(terminal.includes('page-project-ssh-tab"'), 'missing per-tab ref');
    assert.ok(terminal.includes('page-project-ssh-new-tab'), 'missing new-tab button');
    assert.ok(terminal.includes('page-project-ssh-close-tab'), 'missing close-tab button');
    assert.match(terminal, /role="tablist"|TabsList/);
  });

  it('carries the connection status in the active tab and uses icon-only bar actions', () => {
    assert.ok(terminal.includes('page-project-ssh-status'), 'active tab must show the status word');
    assert.ok(terminal.includes("·{' '}"), 'active tab must read "Tab N · <status>"');
    assert.ok(!terminal.includes('Badge'), 'status badge must be gone; status lives in the active tab');
    assert.ok(
      terminal.includes('aria-label="Open a new terminal tab"'),
      'new-tab must be an icon-only button with an accessible label',
    );
    assert.ok(
      terminal.includes("aria-label={isFullscreen ? 'Exit full screen'"),
      'fullscreen must be an icon-only toggle with an accessible label',
    );
  });

  it('gives every tab its own terminal plus WebSocket session', () => {
    assert.match(terminal, /function SshTerminalPane\(/);
    // Per-pane refs (not a single shared terminal/ws) so each tab dials its
    // own /api/ssh/<projectId> socket with its own shell channel.
    assert.ok(terminal.includes('wsRef = useRef'), 'each pane must own its WebSocket');
    assert.ok(terminal.includes('termRef = useRef'), 'each pane must own its terminal');
    assert.ok(terminal.includes('/api/ssh/${encodeURIComponent(projectId)}'), 'each pane must open its own session socket');
  });

  it('keeps background tabs mounted and only refits the visible pane', () => {
    assert.match(terminal, /TabsContent/);
    assert.ok(
      terminal.includes('stays mounted') || terminal.includes('Every pane stays mounted'),
      'must document that background panes stay mounted',
    );
    assert.ok(terminal.includes('activeRef'), 'window resizes must skip hidden panes');
    assert.ok(
      terminal.includes('clientWidth === 0'),
      'fitting must skip zero-size (hidden) containers so a late socket-open cannot collapse a background tab',
    );
    assert.ok(
      terminal.includes('becomes visible') || terminal.includes('refit once it becomes visible'),
      'switching tabs must refit the newly visible pane',
    );
  });

  it('reconnects and reports status for the active tab, and resets tabs between projects', () => {
    assert.ok(terminal.includes('reconnectActive'), 'header reconnect must target the active tab');
    assert.ok(terminal.includes('handleConnChange'), 'panes must report state for the tab status');
    assert.ok(
      terminal.includes('firstProjectRef'),
      'navigating between projects must reset to a single fresh tab',
    );
  });

  it('supports copy/paste without clipboard permission (shortcuts, menu, toolbar)', () => {
    assert.ok(terminal.includes('page-project-ssh-copy'), 'missing toolbar copy button');
    assert.ok(terminal.includes('page-project-ssh-paste'), 'missing toolbar paste button');
    assert.ok(terminal.includes('page-project-ssh-context-menu'), 'missing right-click menu');
    assert.ok(terminal.includes('page-project-ssh-context-copy'), 'missing menu copy item');
    assert.ok(terminal.includes('page-project-ssh-context-paste'), 'missing menu paste item');
    assert.ok(terminal.includes('getSelection'), 'copy must read the xterm selection');
    assert.ok(terminal.includes('execCommand'), 'copy must fall back when the async clipboard API is denied');
    assert.ok(terminal.includes('attachCustomKeyEventHandler'), 'must intercept copy/paste keys');
    assert.ok(terminal.includes("addEventListener('paste'"), 'keyboard paste must use the paste event (no permission needed)');
    assert.ok(terminal.includes("addEventListener('contextmenu'"), 'right-click must open the clipboard menu');
  });

  it('bridges remote copy (OSC 52) and Shift-drag selection in full-screen apps', () => {
    assert.ok(terminal.includes('registerOscHandler(52'), 'must handle OSC 52 remote copy requests');
    assert.ok(terminal.includes('decodeOsc52'), 'must decode the OSC 52 base64 payload');
    assert.ok(terminal.includes('pendingRemote'), 'denied remote copies must wait for a click gesture');
    assert.ok(terminal.includes('confirmRemoteCopy'), 'clicking the notice must retry the pending remote copy');
    assert.ok(
      terminal.includes('page-project-ssh-clipboard-hint'),
      'must hint that full-screen apps capture the mouse (hold Shift to select)',
    );
    assert.ok(
      terminal.includes('page-project-ssh-copy-wrap'),
      'hint must live in a popover on the copy button, not as a bar row',
    );
    assert.ok(
      terminal.includes('role="tooltip"'),
      'copy hint must render as a tooltip popover',
    );
  });
});
