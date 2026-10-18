import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract tests for the Projects pages and the per-project Deploy tab.
// The client has no component test runner (and no new deps are allowed),
// so these tests statically assert the pages implement the backend API
// contracts from web/server/server.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const libPath = path.join(root, 'web/client/src/lib/projects.tsx');
const projectsPath = path.join(root, 'web/client/src/pages/ProjectsPage.tsx');
const editPath = path.join(root, 'web/client/src/pages/ProjectEditPage.tsx');
const deployTabPath = path.join(root, 'web/client/src/components/ProjectDeployTab.tsx');
const appPath = path.join(root, 'web/client/src/App.tsx');
const sidebarPath = path.join(root, 'web/client/src/components/layout/Sidebar.tsx');

const lib = await readFile(libPath, 'utf8');
const projects = await readFile(projectsPath, 'utf8');
const edit = await readFile(editPath, 'utf8');
const deploy = await readFile(deployTabPath, 'utf8');
const app = await readFile(appPath, 'utf8');
const sidebar = await readFile(sidebarPath, 'utf8');

describe('projects lib contract', () => {
  it('exports ProjectsProvider, useProjects, and ProjectPicker', () => {
    assert.match(lib, /export function ProjectsProvider\(/);
    assert.match(lib, /export function useProjects\(\)/);
    assert.match(lib, /export function ProjectPicker\(/);
  });

  it('fetches GET /api/projects on mount and exposes refresh/loading/error', () => {
    assert.match(lib, /\/api\/projects/);
    for (const key of ['projects', 'refresh', 'loading', 'error']) {
      assert.ok(lib.includes(key), `missing context key ${key}`);
    }
    assert.ok(!lib.includes('activeId'), 'global activeId must be removed');
    assert.ok(!lib.includes('setActiveId'), 'global setActiveId must be removed');
  });

  it('has no global active selection; ProjectPicker is controlled via value/onChange', () => {
    assert.ok(!lib.includes('activeProjectId'), 'global activeProjectId storage must be removed');
    assert.match(lib, /value/);
    assert.match(lib, /onChange/);
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

  it('renders active/inactive tables with Name, Image, Namespace, NodePort, Actions and no config paths', () => {
    assert.match(projects, /<Table/);
    for (const col of ['Name', 'Image', 'Namespace', 'NodePort', 'Actions']) {
      assert.ok(projects.includes(col), `missing column ${col}`);
    }
    assert.ok(!projects.includes('<TH>Mode</TH>'), 'Mode column must be removed');
    assert.ok(!projects.includes('Config path'), 'config paths must not be shown in tables');
    assert.ok(!projects.includes('page-projects-active-card'), 'active detail card must be removed');
    for (const ref of ['page-projects-row-create', 'page-projects-row-deploy', 'page-projects-row-workloads-delete']) {
      assert.ok(projects.includes(ref), `missing per-row action ${ref}`);
    }
  });

  it('prefers the cluster-resolved image (with version) from workloads over the saved config', () => {
    assert.ok(projects.includes('/api/cluster/workloads'), 'must load workloads status');
    assert.ok(projects.includes('workloadImages'), 'must map workload images by project');
    assert.ok(projects.includes('imageDisplay'), 'row must render the resolved image with version');
  });

  it('shows Running/Stopped status badges and no Active badge', () => {
    assert.match(projects, /<Badge/);
    assert.ok(projects.includes('Running'), 'missing Running badge');
    assert.ok(projects.includes('Stopped'), 'missing Stopped badge');
    assert.ok(!projects.includes('Active'), 'Active badge must be removed');
    assert.ok(!projects.includes('Select active'), 'Select active action must be removed');
    assert.ok(!projects.includes('page-projects-row-select'), 'row select ref must be removed');
  });

  it('confirms workload delete via ConfirmDialog and surfaces failures via role=alert', () => {
    assert.match(projects, /ConfirmDialog/);
    assert.ok(projects.includes('page-projects-row-workloads-delete'), 'missing workloads delete action');
    assert.match(projects, /role="alert"/);
  });

  it('links to /projects/new for adding projects (creation POST lives in ProjectCreatePage)', () => {
    assert.ok(projects.includes('to="/projects/new"'), 'missing link to /projects/new');
    assert.ok(projects.includes('Add project'), 'missing add-project affordance');
  });

  it('defaults the status filter to running and persists the selection', () => {
    assert.ok(projects.includes('projectsTableStatusFilter'), 'missing persisted filter key');
    assert.match(projects, /readStoredStatusFilter/);
    assert.ok(
      projects.includes('useState<StatusFilter>(() => readStoredStatusFilter())'),
      'status filter must init from storage (default running)',
    );
    assert.ok(projects.includes("return 'running'"), 'stored-filter fallback must default to running');
  });

  it('shows an EmptyState when there are no projects and a Spinner while loading', () => {
    assert.match(projects, /EmptyState/);
    assert.match(projects, /Spinner/);
    assert.ok(projects.includes('No projects yet'), 'missing empty state copy');
  });

  it('fetches GET /api/config per project and shows mode/image/namespace/nodePort', () => {
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

describe('ProjectDeployTab contract', () => {
  it('exports ProjectDeployTab scoped to a single project (no global picker)', () => {
    assert.match(deploy, /export function ProjectDeployTab\(/);
    assert.ok(deploy.includes('project: Project') || deploy.includes('{ project }'), 'must take the project as a prop');
    assert.ok(!deploy.includes('<ProjectPicker'), 'deploy tab must not render a global ProjectPicker');
  });

  it('has a tag override input and noWait/skipBuild/skipPush/keepSecrets checkboxes', () => {
    assert.ok(deploy.includes('Tag override'), 'missing tag override input');
    for (const flag of ['noWait', 'skipBuild', 'skipPush', 'keepSecrets']) {
      assert.ok(deploy.includes(flag), `missing flag ${flag}`);
    }
    assert.match(deploy, /type="checkbox"/);
  });

  it('renders Create/Deploy/Build/Push cards plus danger-zone Delete and Project GC cards', () => {
    for (const title of ['Create (full pipeline)', 'Deploy', 'Build', 'Push', 'Delete', 'Project GC']) {
      assert.ok(deploy.includes(title), `missing card ${title}`);
    }
    assert.match(deploy, /<Card/);
  });

  it('runs project GC with keep/dryRun preview affordance', () => {
    assert.ok(deploy.includes("'gc'"), 'missing gc op');
    assert.match(deploy, /parseKeep/);
    assert.ok(deploy.includes('gcDryRun') || deploy.includes('dryRun'), 'missing dry-run flag');
    assert.ok(/preview/i.test(deploy), 'missing preview affordance');
  });

  it('confirms destructive delete and posts op/projectId/args to POST /api/jobs', () => {
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
});

describe('ProjectEditPage deploy tab contract', () => {
  it('renders Settings/Configuration/Deploy tabs in the shadcn line variant', () => {
    assert.match(edit, /<Tabs/);
    assert.match(edit, /<TabsList/);
    assert.match(edit, /<TabsTrigger/);
    assert.match(edit, /<TabsContent/);
    assert.ok(edit.includes('tabs-list-line'), 'TabsList must use the line variant');
    assert.ok(edit.includes('tabs-trigger-line'), 'TabsTrigger must use the line variant');
    for (const value of ['value="settings"', 'value="config"', 'value="deploy"']) {
      assert.ok(edit.includes(value), `missing tab ${value}`);
    }
  });

  it('renders the deploy tab via ProjectDeployTab for the current project', () => {
    assert.match(edit, /ProjectDeployTab/);
    assert.ok(edit.includes('<ProjectDeployTab project={project}'), 'deploy tab must render for the edited project');
    assert.ok(edit.includes('page-project-edit-tab-deploy'), 'missing deploy tab ref');
    assert.ok(edit.includes('page-project-edit-panel-deploy'), 'missing deploy panel ref');
  });
});

describe('App routes contract', () => {
  it('mounts the Projects page without a standalone Deploy page', () => {
    assert.match(app, /<ProjectsPage \/>/);
    assert.match(app, /path="projects"/);
    assert.ok(!app.includes('DeployPage'), 'standalone DeployPage must be removed');
    assert.ok(!app.includes('path="deploy"'), 'standalone /deploy route must be removed');
  });

  it('wraps Layout with ProjectsProvider inside RequireAuth', () => {
    assert.match(app, /<RequireAuth>/);
    assert.match(app, /<ProjectsProvider>/);
    assert.ok(app.indexOf('<ProjectsProvider>') < app.indexOf('<Layout'), 'provider must wrap Layout');
  });

  it('does not route projects to placeholders and has no deploy nav entry', () => {
    assert.ok(!app.includes('PLACEHOLDERS'), 'projects must not use placeholder routes');
    assert.ok(!app.includes('<PlaceholderPage title="Projects"'), 'projects must not be a placeholder');
    assert.ok(!app.includes('<PlaceholderPage title="Deploy"'), 'deploy must not be a placeholder');
    assert.ok(!sidebar.includes("'/deploy'"), 'Sidebar must not link to /deploy');
    assert.ok(!sidebar.includes('>Deploy<'), 'Sidebar must not show a Deploy entry');
  });
});
