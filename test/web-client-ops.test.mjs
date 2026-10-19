import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract tests for the Setup and Jobs frontend pages, plus the GC
// functionality that now lives in the project Deploy tab (project GC)
// and the Images cleanup tab (system GC) instead of a standalone page.
// The client has no component test runner (and no new deps are allowed),
// so these tests statically assert the components implement the backend API
// contracts from web/server/server.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deployTabPath = path.join(root, 'web/client/src/components/ProjectDeployTab.tsx');
const imagesPath = path.join(root, 'web/client/src/pages/ImagesPage.tsx');
const setupPath = path.join(root, 'web/client/src/pages/SetupPage.tsx');
const jobsPath = path.join(root, 'web/client/src/pages/JobsPage.tsx');
const appPath = path.join(root, 'web/client/src/App.tsx');
const sidebarPath = path.join(root, 'web/client/src/components/layout/Sidebar.tsx');

const deployTab = await readFile(deployTabPath, 'utf8');
const images = await readFile(imagesPath, 'utf8');
const setup = await readFile(setupPath, 'utf8');
const jobs = await readFile(jobsPath, 'utf8');
const app = await readFile(appPath, 'utf8');
const sidebar = await readFile(sidebarPath, 'utf8');

describe('Project GC contract (Deploy tab)', () => {
  it('posts project gc jobs with keep and dryRun args', () => {
    assert.ok(deployTab.includes("'gc'"), 'missing gc op');
    assert.match(deployTab, /dryRun/);
    assert.match(deployTab, /parseKeep/);
    assert.ok(deployTab.includes('projectId'), 'gc jobs must carry projectId');
  });

  it('offers preview and real runs plus retention notes', () => {
    assert.ok(/preview/i.test(deployTab), 'missing preview affordance');
    assert.ok(/in use/i.test(deployTab), 'missing in-use retention note');
  });

  it('surfaces errors via role=alert and links to /jobs', () => {
    assert.match(deployTab, /role="alert"/);
    assert.match(deployTab, /\/jobs/);
  });
});

describe('System GC contract (Images cleanup tab)', () => {
  it('posts system-gc jobs from the Images page', () => {
    assert.ok(images.includes('system-gc'), 'missing system-gc op');
    assert.match(images, /buildSystemGcArgs/);
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

  it('points at system init and project create as next steps', () => {
    assert.match(setup, /\/system/);
    assert.match(setup, /\/projects/);
    assert.ok(!setup.includes('to="/deploy"'), 'setup must not link to the removed /deploy page');
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

  it('renders detail inline below the selected row (not at the page bottom)', () => {
    assert.match(jobs, /page-jobs-detail-row/);
    assert.match(jobs, /colSpan=\{6\}/);
    assert.match(jobs, /aria-expanded/);
    assert.match(jobs, /aria-controls/);
    // toggling the same row collapses it again
    assert.match(jobs, /prev === job\.id \? null : job\.id/);
    // closing stays closed: polling must not auto-select the first job
    assert.ok(!jobs.includes('list[0].id'), 'closing a row must stay closed, not re-open the first job');
    // no detached bottom card and no inner card box: detail lives flat in the row
    assert.ok(!jobs.includes('marginTop: 24'), 'detail must not render as a detached bottom card');
    assert.ok(!jobs.includes('page-jobs-detail-card'), 'detail must not use an inner card box');
    const tbody = jobs.slice(jobs.indexOf('<TBody>'));
    assert.ok(
      tbody.indexOf('page-jobs-detail-heading') > 0 &&
        tbody.indexOf('page-jobs-detail-heading') < tbody.indexOf('</TBody>'),
      'detail content must render inside <TBody>',
    );
    assert.ok(
      tbody.indexOf('page-jobs-detail-logs') > 0 &&
        tbody.indexOf('page-jobs-detail-logs') < tbody.indexOf('</TBody>'),
      'detail logs must render inside <TBody>',
    );
  });
});

describe('App routes for setup/jobs (no standalone gc page)', () => {
  it('mounts SetupPage and JobsPage without a GcPage', () => {
    for (const line of [
      '<Route path="setup" element={<SetupPage />} />',
      '<Route path="jobs" element={<JobsPage />} />',
    ]) {
      assert.ok(app.includes(line), `missing route ${line}`);
    }
    assert.ok(!app.includes('GcPage'), 'standalone GcPage must be removed');
    assert.ok(!app.includes('path="gc"'), 'standalone /gc route must be removed');
    assert.ok(!sidebar.includes("'/gc'"), 'Sidebar must not link to /gc');
  });
});
