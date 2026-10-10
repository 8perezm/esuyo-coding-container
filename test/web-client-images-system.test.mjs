import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract tests for the Images and System frontend pages.
// The client has no component test runner (and no new deps are allowed),
// so these tests statically assert the pages implement the backend API
// contracts from web/server/server.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helperPath = path.join(root, 'web/client/src/lib/systemJobs.ts');
const imagesPath = path.join(root, 'web/client/src/pages/ImagesPage.tsx');
const systemPath = path.join(root, 'web/client/src/pages/SystemPage.tsx');
const appPath = path.join(root, 'web/client/src/App.tsx');

const helper = await readFile(helperPath, 'utf8');
const images = await readFile(imagesPath, 'utf8');
const system = await readFile(systemPath, 'utf8');
const app = await readFile(appPath, 'utf8');

describe('systemJobs helper contract', () => {
  it('exports arg builders matching the server job shapes', () => {
    assert.match(helper, /export function buildOptionalTagArgs\(/);
    assert.match(helper, /export function buildSystemGcArgs\(/);
    assert.match(helper, /export function buildSystemInitArgs\(/);
    assert.match(helper, /export function parseKeepInput\(/);
  });
});

describe('ImagesPage contract', () => {
  it('exports ImagesPage and renders ProjectPicker at the top', () => {
    assert.match(images, /export function ImagesPage\(\)/);
    assert.match(images, /<ProjectPicker/);
    assert.match(images, /from '\.\.\/lib\/projects'/);
  });

  it('fetches GET /api/system/state and shows current/previous/maxEver/keep + image', () => {
    assert.match(images, /\/api\/system\/state\?projectId=/);
    for (const field of ['current', 'previous', 'maxEver', 'keep']) {
      assert.ok(images.includes(field), `missing state field ${field}`);
    }
    assert.ok(images.includes('Resolved image'), 'missing resolved image line');
  });

  it('handles the !ok init hint with a link to /system and a Spinner while loading', () => {
    assert.ok(images.includes('System is not initialized'), 'missing init hint');
    assert.ok(images.includes('to="/system"'), 'missing link to /system');
    assert.match(images, /Spinner/);
  });

  it('renders the tags table with current/previous badges and an empty state', () => {
    assert.match(images, /\/api\/system\/tags\?projectId=/);
    assert.match(images, /<Table/);
    assert.ok(images.includes('current'), 'missing current badge');
    assert.ok(images.includes('previous'), 'missing previous badge');
    assert.match(images, /EmptyState/);
    assert.ok(images.includes('No versions yet'), 'missing empty state copy');
  });

  it('publishes via system-create and rolls back via system-rollback with optional tags', () => {
    assert.ok(images.includes('system-create'), 'missing system-create op');
    assert.ok(images.includes('system-rollback'), 'missing system-rollback op');
    assert.match(images, /buildOptionalTagArgs/);
    assert.ok(images.includes('defaults to previous'), 'missing rollback-previous hint');
  });

  it('runs system GC with keep + dryRun, offering dry-run and real-run buttons', () => {
    assert.ok(images.includes('system-gc'), 'missing system-gc op');
    assert.match(images, /buildSystemGcArgs/);
    assert.match(images, /type="checkbox"/);
    assert.ok(images.includes('Preview (dry run)'), 'missing dry-run button');
  });

  it('posts op/projectId/args to POST /api/jobs and surfaces errors via role=alert', () => {
    assert.match(images, /api\.post<.*>\('\/api\/jobs'/);
    assert.ok(images.includes('projectId'), 'jobs must carry projectId');
    assert.match(images, /role="alert"/);
  });

  it('shows the returned job id with a link to /jobs', () => {
    assert.match(images, /job\.id/);
    assert.ok(images.includes('to="/jobs"'), 'missing link to /jobs');
  });

  it('notes that custom-mode projects get a server refusal', () => {
    assert.match(images, /[Cc]ustom-mode/);
    assert.match(images, /refus/);
  });
});

describe('SystemPage contract', () => {
  it('exports SystemPage without a ProjectPicker (uses active project silently)', () => {
    assert.match(system, /export function SystemPage\(\)/);
    assert.ok(!system.includes('<ProjectPicker'), 'System page must not render a ProjectPicker');
    assert.ok(!system.includes('page-system-project-card'), 'project picker card must be removed');
    assert.match(system, /from '\.\.\/lib\/projects'/);
    assert.match(system, /useProjects/);
  });

  it('loads the global config and shows path + exists badge', () => {
    assert.match(system, /\/api\/global-config/);
    assert.ok(system.includes('exists'), 'missing exists badge');
    assert.ok(system.includes('missing'), 'missing missing badge');
  });

  it('edits rawYaml in the shared YamlEditor and saves via PUT', () => {
    assert.ok(system.includes('rawYaml'), 'missing rawYaml binding');
    assert.match(system, /YamlEditor/);
    assert.ok(!system.includes('<textarea'), 'must use YamlEditor, not a plain textarea');
    assert.match(system, /api\.put<.*>\('\/api\/global-config'/);
    assert.ok(system.includes('Save global config'), 'missing save button');
  });

  it('warns that registry/NFS live in the global config and surfaces failures via role=alert', () => {
    assert.match(system, /[Rr]egistry/);
    assert.match(system, /NFS/);
    assert.match(system, /role="alert"/);
  });

  it('initializes via system-init with a required tag and default keep 10', () => {
    assert.ok(system.includes('system-init'), 'missing system-init op');
    assert.match(system, /buildSystemInitArgs/);
    assert.ok(system.includes('v1.0.0'), 'missing tag placeholder');
    assert.ok(system.includes("'10'"), 'missing default keep 10');
  });

  it('shows a compact state summary reusing GET /api/system/state', () => {
    assert.match(system, /\/api\/system\/state\?projectId=/);
    assert.ok(system.includes('State summary'), 'missing state summary section');
  });

  it('notes the global-mode requirement and shows job id with a link to /jobs', () => {
    assert.match(system, /global-mode/);
    assert.match(system, /job\.id/);
    assert.ok(system.includes('to="/jobs"'), 'missing link to /jobs');
  });
});

describe('App routes contract (images/system)', () => {
  it('mounts real Images and System pages instead of placeholders', () => {
    assert.match(app, /<ImagesPage \/>/);
    assert.match(app, /<SystemPage \/>/);
    assert.match(app, /path="images"/);
    assert.match(app, /path="system"/);
  });
});
