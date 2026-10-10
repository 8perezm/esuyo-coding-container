import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract tests for the GC, Setup and Jobs frontend pages.
// The client has no component test runner (and no new deps are allowed),
// so these tests statically assert the pages implement the backend API
// contracts from web/server/server.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gcPath = path.join(root, 'web/client/src/pages/GcPage.tsx');
const setupPath = path.join(root, 'web/client/src/pages/SetupPage.tsx');
const jobsPath = path.join(root, 'web/client/src/pages/JobsPage.tsx');
const appPath = path.join(root, 'web/client/src/App.tsx');

const gc = await readFile(gcPath, 'utf8');
const setup = await readFile(setupPath, 'utf8');
const jobs = await readFile(jobsPath, 'utf8');
const app = await readFile(appPath, 'utf8');

describe('GcPage contract', () => {
  it('exports GcPage', () => {
    assert.match(gc, /export function GcPage\(\)/);
  });

  it('uses the shared ProjectPicker without creating it', () => {
    assert.match(gc, /from '\.\.\/lib\/projects'/);
    assert.match(gc, /ProjectPicker/);
  });

  it('posts gc and system-gc jobs with keep and dryRun args', () => {
    assert.ok(gc.includes("'gc'"), 'missing gc op');
    assert.ok(gc.includes("'system-gc'"), 'missing system-gc op');
    assert.match(gc, /dryRun/);
    assert.match(gc, /parseKeep/);
  });

  it('offers preview and real runs plus retention notes', () => {
    assert.ok(/preview/i.test(gc), 'missing preview affordance');
    assert.ok(/in use/i.test(gc), 'missing in-use retention note');
  });

  it('surfaces errors via role=alert and links to /jobs', () => {
    assert.match(gc, /role="alert"/);
    assert.match(gc, /\/jobs/);
  });
});

describe('SetupPage contract', () => {
  it('exports SetupPage', () => {
    assert.match(setup, /export function SetupPage\(\)/);
  });

  it('reads global config status from GET /api/global-config', () => {
    assert.match(setup, /\/api\/global-config/);
    assert.match(setup, /exists/);
  });

  it('posts a setup job without projectId, dropping blank fields', () => {
    assert.match(setup, /op: 'setup'/);
    assert.match(setup, /buildSetupArgs/);
    assert.ok(!setup.includes('projectId'), 'setup must not send projectId');
  });

  it('points at system init and create as next steps', () => {
    assert.match(setup, /\/system/);
    assert.match(setup, /\/deploy/);
  });
});

describe('JobsPage contract', () => {
  it('exports JobsPage', () => {
    assert.match(jobs, /export function JobsPage\(\)/);
  });

  it('lists jobs from GET /api/jobs and polls', () => {
    assert.match(jobs, /\/api\/jobs/);
    assert.match(jobs, /setInterval/);
  });

  it('loads detail from GET /api/jobs/:id with logs in a scrollable pre', () => {
    assert.match(jobs, /\/api\/jobs\/\$\{/);
    assert.match(jobs, /aria-label="Job logs"/);
    assert.match(jobs, /logs/);
  });

  it('uses shared job tone/format helpers with grayscale+accent discipline', () => {
    assert.match(jobs, /jobTone/);
    assert.match(jobs, /formatDateTime/);
    assert.match(jobs, /shortId/);
  });

  it('shows an empty state when there are no jobs', () => {
    assert.match(jobs, /EmptyState/);
    assert.match(jobs, /No jobs yet/);
  });
});

describe('App routes for gc/setup/jobs', () => {
  it('mounts GcPage, SetupPage and JobsPage', () => {
    for (const line of [
      '<Route path="gc" element={<GcPage />} />',
      '<Route path="setup" element={<SetupPage />} />',
      '<Route path="jobs" element={<JobsPage />} />',
    ]) {
      assert.ok(app.includes(line), `missing route ${line}`);
    }
  });
});
