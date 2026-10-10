import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract tests for the Projects and Deploy frontend pages.
// The client has no component test runner (and no new deps are allowed),
// so these tests statically assert the pages implement the backend API
// contracts from web/server/server.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const libPath = path.join(root, 'web/client/src/lib/projects.tsx');
const projectsPath = path.join(root, 'web/client/src/pages/ProjectsPage.tsx');
const deployPath = path.join(root, 'web/client/src/pages/DeployPage.tsx');
const appPath = path.join(root, 'web/client/src/App.tsx');

const lib = await readFile(libPath, 'utf8');
const projects = await readFile(projectsPath, 'utf8');
const deploy = await readFile(deployPath, 'utf8');
const app = await readFile(appPath, 'utf8');

describe('projects lib contract', () => {
  it('exports ProjectsProvider, useProjects, and ProjectPicker', () => {
    assert.match(lib, /export function ProjectsProvider\(/);
    assert.match(lib, /export function useProjects\(\)/);
    assert.match(lib, /export function ProjectPicker\(/);
  });

  it('fetches GET /api/projects on mount and exposes refresh/loading/error', () => {
    assert.match(lib, /\/api\/projects/);
    for (const key of ['projects', 'activeId', 'setActiveId', 'refresh', 'loading', 'error']) {
      assert.ok(lib.includes(key), `missing context key ${key}`);
    }
  });

  it('persists activeId in localStorage under activeProjectId, defaulting to the first project', () => {
    assert.match(lib, /activeProjectId/);
    assert.match(lib, /localStorage/);
    assert.match(lib, /list\[0\]/);
  });

  it('ProjectPicker renders a label+select with a >=44px target', () => {
    assert.match(lib, /<Label/);
    assert.match(lib, /<select/);
    assert.match(lib, /minHeight: 44/);
  });
});

describe('ProjectsPage contract', () => {
  it('exports ProjectsPage and consumes the shared projects module', () => {
    assert.match(projects, /export function ProjectsPage\(\)/);
    assert.match(projects, /from '\.\.\/lib\/projects'/);
    assert.match(projects, /useProjects/);
  });

  it('renders a table with Name, Config path, and actions columns', () => {
    assert.match(projects, /<Table/);
    for (const col of ['Name', 'Config path', 'Actions']) {
      assert.ok(projects.includes(col), `missing column ${col}`);
    }
  });

  it('marks the active project with a Badge and offers Select active', () => {
    assert.match(projects, /<Badge/);
    assert.ok(projects.includes('Active'), 'missing Active badge');
    assert.ok(projects.includes('Select active'), 'missing Select active action');
  });

  it('confirms before DELETE /api/projects/:id and surfaces failures via role=alert', () => {
    assert.match(projects, /window\.confirm/);
    assert.match(projects, /\/api\/projects\//);
    assert.match(projects, /role="alert"/);
  });

  it('adds projects via POST /api/projects with name + configPath, showing errors via role=alert', () => {
    assert.match(projects, /api\.post<.*>\('\/api\/projects'/);
    assert.ok(projects.includes('configPath'), 'missing configPath field');
    assert.ok(projects.includes('Add project'), 'missing add-project form');
  });

  it('shows an EmptyState when there are no projects and a Spinner while loading', () => {
    assert.match(projects, /EmptyState/);
    assert.match(projects, /Spinner/);
    assert.ok(projects.includes('No projects yet'), 'missing empty state copy');
  });

  it('fetches GET /api/config for the active project and shows mode/image/namespace/nodePort', () => {
    assert.match(projects, /\/api\/config\?projectId=/);
    for (const field of ['nodePort', 'namespace', 'registry']) {
      assert.ok(projects.includes(field), `missing config field ${field}`);
    }
  });

  it('offers Create/Deploy/Delete quick actions via POST /api/jobs with projectId', () => {
    assert.match(projects, /api\.post<.*>\('\/api\/jobs'/);
    for (const op of ["'create'", "'deploy'", "'delete'"]) {
      assert.ok(projects.includes(`startJob(${op}`) || projects.includes(`'${op}'`), `missing op ${op}`);
    }
    assert.ok(projects.includes('projectId'), 'jobs must carry projectId');
  });

  it('shows the returned job id with a link to /jobs', () => {
    assert.match(projects, /jobNotice\.id/);
    assert.ok(projects.includes('to="/jobs"'), 'missing link to /jobs');
  });
});

describe('DeployPage contract', () => {
  it('exports DeployPage and renders ProjectPicker at the top', () => {
    assert.match(deploy, /export function DeployPage\(\)/);
    assert.match(deploy, /<ProjectPicker/);
  });

  it('has a tag override input and noWait/skipBuild/skipPush/keepSecrets checkboxes', () => {
    assert.ok(deploy.includes('Tag override'), 'missing tag override input');
    for (const flag of ['noWait', 'skipBuild', 'skipPush', 'keepSecrets']) {
      assert.ok(deploy.includes(flag), `missing flag ${flag}`);
    }
    assert.match(deploy, /type="checkbox"/);
  });

  it('renders Create/Deploy/Build/Push cards plus a danger-zone Delete card', () => {
    for (const title of ['Create (full pipeline)', 'Deploy', 'Build', 'Push', 'Delete']) {
      assert.ok(deploy.includes(title), `missing card ${title}`);
    }
    assert.match(deploy, /<Card/);
  });

  it('confirms destructive delete and posts op/projectId/args to POST /api/jobs', () => {
    assert.match(deploy, /window\.confirm/);
    assert.match(deploy, /api\.post<.*>\('\/api\/jobs'/);
    assert.ok(deploy.includes('projectId'), 'jobs must carry projectId');
    for (const arg of ['skipBuild', 'skipPush', 'noWait', 'keepSecrets']) {
      assert.ok(deploy.includes(`args.${arg}`) || deploy.includes(`${arg} = true`), `missing arg ${arg}`);
    }
  });

  it('disables buttons while submitting and shows the job id with a link to /jobs', () => {
    assert.match(deploy, /disabled=\{pending/);
    assert.match(deploy, /result\.id/);
    assert.ok(deploy.includes('to="/jobs"'), 'missing link to /jobs');
  });

  it('surfaces server errors via role=alert and notes global-mode build/push refusal', () => {
    assert.match(deploy, /role="alert"/);
    assert.match(deploy, /global/i);
    assert.ok(deploy.includes('refuse') || deploy.includes('refused'), 'missing refusal hint');
  });

  it('shows an EmptyState linking to /projects when there are no projects', () => {
    assert.match(deploy, /EmptyState/);
    assert.ok(deploy.includes('to="/projects"'), 'missing link to /projects');
  });
});

describe('App routes contract', () => {
  it('mounts real Projects and Deploy pages instead of placeholders', () => {
    assert.match(app, /<ProjectsPage \/>/);
    assert.match(app, /<DeployPage \/>/);
    assert.match(app, /path="projects"/);
    assert.match(app, /path="deploy"/);
  });

  it('wraps Layout with ProjectsProvider inside RequireAuth', () => {
    assert.match(app, /<RequireAuth>/);
    assert.match(app, /<ProjectsProvider>/);
    assert.ok(app.indexOf('<ProjectsProvider>') < app.indexOf('<Layout'), 'provider must wrap Layout');
  });

  it('does not route projects/deploy to placeholders', () => {
    assert.ok(!app.includes('PLACEHOLDERS'), 'projects/deploy must not use placeholder routes');
    assert.ok(!app.includes('<PlaceholderPage title="Projects"'), 'projects must not be a placeholder');
    assert.ok(!app.includes('<PlaceholderPage title="Deploy"'), 'deploy must not be a placeholder');
  });
});
