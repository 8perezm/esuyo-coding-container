import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, Rocket, SquareTerminal, Trash2, Upload, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import type { Project } from '../lib/projects';
import { JobOutput } from '../components/JobOutput';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Label,
  PageHeader,
  Spinner,
  Table,
  TableContainer,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

interface ConfigResponse {
  merged: {
    project?: string;
    image?: { registry?: string; name?: string; tag?: string };
    imageMode?: string;
    k8s?: { namespace?: string; nodePort?: number };
  };
  rawYaml?: string;
  imageMode?: string;
  configPath?: string;
}

interface WorkloadStatus {
  projectId?: string | null;
  deployed: boolean;
}

interface WorkloadsResponse {
  ok: boolean;
  workloads?: WorkloadStatus[];
}

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

type LifecycleOp = 'create' | 'deploy' | 'delete';

type StatusFilter = 'all' | 'running' | 'stopped';
type SortKey = 'name' | 'status' | 'namespace' | 'nodePort';
type SortDir = 'asc' | 'desc';

const JOB_NOTICE_TTL_MS = 20000;

const SORT_KEY_STORAGE_KEY = 'projectsTableSortKey';
const SORT_DIR_STORAGE_KEY = 'projectsTableSortDir';
const FILTER_STORAGE_KEY = 'projectsTableStatusFilter';
const SORT_KEYS: SortKey[] = ['name', 'status', 'namespace', 'nodePort'];
const STATUS_FILTERS: StatusFilter[] = ['all', 'running', 'stopped'];

function readStoredStatusFilter(): StatusFilter {
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw && (STATUS_FILTERS as string[]).includes(raw)) return raw as StatusFilter;
  } catch {
    /* storage unavailable — fall back to default */
  }
  return 'all';
}

function readStoredSortKey(): SortKey {
  try {
    const raw = window.localStorage.getItem(SORT_KEY_STORAGE_KEY);
    if (raw && (SORT_KEYS as string[]).includes(raw)) return raw as SortKey;
  } catch {
    /* storage unavailable — fall back to default */
  }
  return 'name';
}

function readStoredSortDir(): SortDir {
  try {
    const raw = window.localStorage.getItem(SORT_DIR_STORAGE_KEY);
    if (raw === 'asc' || raw === 'desc') return raw;
  } catch {
    /* storage unavailable — fall back to default */
  }
  return 'asc';
}

export function ProjectsPage() {
  const { projects, refresh, loading, error } = useProjects();
  const [actionError, setActionError] = useState<string | null>(null);
  const [workloadsDeleteTarget, setWorkloadsDeleteTarget] = useState<Project | null>(null);

  const [configs, setConfigs] = useState<Record<string, ConfigResponse>>({});
  const [jobNotices, setJobNotices] = useState<Record<string, JobResponse & { noticedAt: number }>>({});
  const [jobPendingKey, setJobPendingKey] = useState<string | null>(null);
  const [deployedIds, setDeployedIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadWorkloads = () => {
      api
        .get<WorkloadsResponse>('/api/cluster/workloads')
        .then((data) => {
          if (cancelled) return;
          const workloads = data.workloads ?? [];
          setDeployedIds(
            new Set(workloads.filter((w) => w.deployed && w.projectId).map((w) => w.projectId as string)),
          );
        })
        .catch(() => {
          if (!cancelled) setDeployedIds(new Set());
        });
    };
    loadWorkloads();
    const timer = window.setInterval(loadWorkloads, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (projects.length === 0) {
      setConfigs({});
      return () => {
        cancelled = true;
      };
    }
    void Promise.all(
      projects.map(async (p) => {
        try {
          const data = await api.get<ConfigResponse>(`/api/config?projectId=${encodeURIComponent(p.id)}`);
          return [p.id, data] as const;
        } catch {
          return [p.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, ConfigResponse> = {};
      for (const [id, data] of entries) {
        if (data) next[id] = data;
      }
      setConfigs(next);
    });
    return () => {
      cancelled = true;
    };
  }, [projects.map((p) => p.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const startJob = useCallback(
    async (op: 'create' | 'deploy' | 'delete', project: Project, args: Record<string, unknown> = {}) => {
      setActionError(null);
      setJobNotices((prev) => {
        const next = { ...prev };
        delete next[project.id];
        return next;
      });
      const key = `${project.id}:${op}`;
      setJobPendingKey(key);
      try {
        const job = await api.post<JobResponse>('/api/jobs', { op, projectId: project.id, args });
        // jobNotice.id — per-project notice rendered inline in the row.
        // Auto-hides after 20s (see prune effect below).
        setJobNotices((prev) => ({ ...prev, [project.id]: { ...job, noticedAt: Date.now() } }));
      } catch (err) {
        setActionError(errMsg(err));
      } finally {
        setJobPendingKey((prev) => (prev === key ? null : prev));
      }
    },
    [],
  );

  // Auto-hide inline job responses 20 seconds after they started.
  useEffect(() => {
    const ids = Object.keys(jobNotices);
    if (ids.length === 0) return;
    const oldest = Math.min(...ids.map((id) => jobNotices[id]?.noticedAt ?? Date.now()));
    const delay = Math.max(oldest + JOB_NOTICE_TTL_MS - Date.now(), 0);
    const timer = window.setTimeout(() => {
      setJobNotices((prev) => {
        const cutoff = Date.now() - JOB_NOTICE_TTL_MS;
        const next: typeof prev = {};
        for (const [id, entry] of Object.entries(prev)) {
          if ((entry.noticedAt ?? Date.now()) > cutoff) next[id] = entry;
        }
        return next;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [jobNotices]);

  const isPending = useCallback(
    (projectId: string, op: LifecycleOp) => jobPendingKey === `${projectId}:${op}`,
    [jobPendingKey],
  );
  const isRowBusy = useCallback(
    (projectId: string) => jobPendingKey?.startsWith(`${projectId}:`) ?? false,
    [jobPendingKey],
  );

  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => readStoredStatusFilter());
  const [sortKey, setSortKey] = useState<SortKey>(() => readStoredSortKey());
  const [sortDir, setSortDir] = useState<SortDir>(() => readStoredSortDir());

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, statusFilter);
    } catch {
      /* storage unavailable — filter just won't persist */
    }
  }, [statusFilter]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_KEY_STORAGE_KEY, sortKey);
    } catch {
      /* storage unavailable — sorting just won't persist */
    }
  }, [sortKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_DIR_STORAGE_KEY, sortDir);
    } catch {
      /* storage unavailable — sorting just won't persist */
    }
  }, [sortDir]);

  const workloadsLoading = deployedIds === null;

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey],
  );

  const sortIndicator = useCallback(
    (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''),
    [sortKey, sortDir],
  );

  const ariaSortFor = useCallback(
    (key: SortKey): 'ascending' | 'descending' | 'none' =>
      sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
    [sortKey, sortDir],
  );

  const visibleProjects = useMemo(() => {
    const filtered = projects.filter((p) => {
      if (statusFilter === 'all') return true;
      const isDeployed = deployedIds?.has(p.id) ?? false;
      return statusFilter === 'running' ? isDeployed : !isDeployed;
    });

    const namespaceFor = (p: Project): string => configs[p.id]?.merged.k8s?.namespace ?? '';
    const nodePortFor = (p: Project): number | null => configs[p.id]?.merged.k8s?.nodePort ?? null;
    const statusFor = (p: Project): string => (deployedIds?.has(p.id) ? 'running' : 'stopped');

    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.name.localeCompare(b.name) * dir;
        case 'status': {
          const cmp = statusFor(a).localeCompare(statusFor(b));
          return (cmp !== 0 ? cmp : a.name.localeCompare(b.name)) * dir;
        }
        case 'namespace':
          return namespaceFor(a).localeCompare(namespaceFor(b)) * dir;
        case 'nodePort': {
          const av = nodePortFor(a);
          const bv = nodePortFor(b);
          if (av === null && bv === null) return a.name.localeCompare(b.name) * dir;
          if (av === null) return 1;
          if (bv === null) return -1;
          return (av - bv) * dir;
        }
        default:
          return 0;
      }
    });
  }, [projects, configs, deployedIds, statusFilter, sortKey, sortDir]);

  const renderWorkloadsLoading = (ref: string) => (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}
      aria-label="Loading cluster status"
      data-ref={ref}
    >
      <div className="skeleton" style={{ height: 48 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Spinner label="Loading cluster status…" />
      </div>
    </div>
  );

  const renderProjectRow = (p: Project) => {
    const isDeployed = deployedIds?.has(p.id) ?? false;
    const config = configs[p.id] ?? null;
    const k8s = config?.merged.k8s;
    const notice = jobNotices[p.id] ?? null;
    return (
      <TR key={p.id}>
        <TD>{p.name}</TD>
        <TD>{isDeployed ? <Badge tone="accent">Running</Badge> : <Badge>Stopped</Badge>}</TD>
        <TD>{config ? (k8s?.namespace ?? '—') : '…'}</TD>
        <TD>{config ? (k8s?.nodePort ?? '—') : '…'}</TD>
        <TD>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {!isDeployed && (
              <Button
                variant="secondary"
                onClick={() => void startJob('create', p)}
                disabled={isRowBusy(p.id)}
                data-ref="page-projects-row-create"
                aria-label={`Create project ${p.name}`}
              >
                <Wrench size={16} aria-hidden="true" />{' '}
                {isPending(p.id, 'create') ? 'Starting…' : 'Create'}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => void startJob('deploy', p)}
              disabled={isRowBusy(p.id)}
              data-ref="page-projects-row-deploy"
              aria-label={`Deploy project ${p.name}`}
            >
              <Rocket size={16} aria-hidden="true" /> {isPending(p.id, 'deploy') ? 'Starting…' : 'Deploy'}
            </Button>
            <Link
              to={`/projects/${encodeURIComponent(p.id)}/edit`}
              className="btn btn-secondary"
              aria-label={`Edit project ${p.name}`}
              data-ref="page-projects-row-edit"
            >
              <Pencil size={16} aria-hidden="true" /> Edit
            </Link>
            {isDeployed && (
              <Link
                to={`/projects/${encodeURIComponent(p.id)}/ssh`}
                className="btn btn-secondary"
                aria-label={`Open terminal for ${p.name}`}
                data-ref="page-projects-row-ssh"
              >
                <SquareTerminal size={16} aria-hidden="true" /> Terminal
              </Link>
            )}
            {isDeployed && (
              <Button
                variant="secondary"
                onClick={() => setWorkloadsDeleteTarget(p)}
                disabled={isRowBusy(p.id)}
                aria-label={`Delete workloads for ${p.name}`}
                data-ref="page-projects-row-workloads-delete"
              >
                <Trash2 size={16} aria-hidden="true" />
                {isPending(p.id, 'delete') ? ' Starting…' : null}
              </Button>
            )}
          </span>
          {notice && (
            <div style={{ marginTop: 8 }}>
              <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-md)' }} data-ref="page-projects-row-job-notice" role="status">
                Job started: <code>{notice.id}</code> ({notice.status}) —{' '}
                <Link to="/jobs" data-ref="page-projects-row-job-notice-link">View jobs</Link>
              </p>
              <JobOutput key={notice.id} job={{ id: notice.id, op: notice.op, status: notice.status }} dataRef="page-projects-row-job" />
            </div>
          )}
        </TD>
      </TR>
    );
  };

  const renderSortableHeader = (label: string, key: SortKey, ref: string) => (
    <TH aria-sort={ariaSortFor(key)}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        data-ref={ref}
        aria-label={`Sort by ${label}`}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          font: 'inherit',
          fontWeight: 'inherit',
          color: 'inherit',
          minHeight: 44,
        }}
      >
        {label}
        <span aria-hidden="true">{sortIndicator(key)}</span>
      </button>
    </TH>
  );

  const renderProjectTable = (list: Project[]) => (
    <TableContainer data-ref="page-projects-table-container">
      <Table aria-label="Projects" data-ref="page-projects-table">
        <THead>
          <TR>
            {renderSortableHeader('Name', 'name', 'page-projects-sort-name')}
            {renderSortableHeader('Status', 'status', 'page-projects-sort-status')}
            {renderSortableHeader('Namespace', 'namespace', 'page-projects-sort-namespace')}
            {renderSortableHeader('NodePort', 'nodePort', 'page-projects-sort-nodeport')}
            <TH style={{ textAlign: 'right' }} aria-label="Row actions" />
          </TR>
        </THead>
        <TBody>{list.map(renderProjectRow)}</TBody>
      </Table>
    </TableContainer>
  );

  return (
    <div data-ref="page-projects">
      <PageHeader
        title="Projects"
        description="Per-project containers, workspaces, and lifecycle actions."
        actions={
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to="/projects/import" className="btn btn-secondary" data-ref="page-projects-action-import">
              <Upload size={16} aria-hidden="true" /> Import project
            </Link>
            <Link to="/projects/new" className="btn btn-primary" data-ref="page-projects-action-add">
              <Plus size={16} aria-hidden="true" /> Add project
            </Link>
          </span>
        }
      />

      {loading ? (
        <div data-ref="page-projects-loading"><Spinner label="Loading projects…" /></div>
      ) : error ? (
        <Card data-ref="page-projects-error-card">
          <p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-projects-error">
            Could not load projects: {error}{' '}
            <Button variant="secondary" onClick={() => void refresh()} style={{ marginLeft: 8 }} data-ref="page-projects-retry">
              Retry
            </Button>
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <div data-ref="page-projects-empty">
          <EmptyState
            title="No projects yet"
            description="Add your first project — point it at a config file on the server."
            action={
              <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                <Link to="/projects/import" className="btn btn-secondary" data-ref="page-projects-empty-import">
                  <Upload size={16} aria-hidden="true" /> Import project
                </Link>
                <Link to="/projects/new" className="btn btn-primary" data-ref="page-projects-empty-add">
                  <Plus size={16} aria-hidden="true" /> Add project
                </Link>
              </span>
            }
          />
        </div>
      ) : (
        <>
          <div
            style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 0 12px' }}
            data-ref="page-projects-toolbar"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Label htmlFor="page-projects-status-filter">Status</Label>
              <select
                id="page-projects-status-filter"
                className="input"
                style={{ minHeight: 44, minWidth: 160 }}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                data-ref="page-projects-status-filter"
                aria-label="Filter by status"
              >
                <option value="all">All</option>
                <option value="running">Running</option>
                <option value="stopped">Stopped</option>
              </select>
            </div>
          </div>
          {workloadsLoading ? (
            renderWorkloadsLoading('page-projects-table-loading')
          ) : visibleProjects.length === 0 ? (
            <Card data-ref="page-projects-empty-filtered-card">
              <p style={{ margin: 0, fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="page-projects-empty-filtered">
                {statusFilter === 'running'
                  ? 'No running projects — nothing is currently running on the cluster.'
                  : statusFilter === 'stopped'
                    ? 'No stopped projects — everything is running.'
                    : 'No projects match this filter.'}
              </p>
            </Card>
          ) : (
            <div data-ref="page-projects-table-wrap">{renderProjectTable(visibleProjects)}</div>
          )}
        </>
      )}

      {actionError && (
        <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)', marginTop: 12 }} data-ref="page-projects-action-error">
          {actionError}
        </p>
      )}

      {workloadsDeleteTarget && (
        <ConfirmDialog
          title={`Delete "${workloadsDeleteTarget.name}"?`}
          confirmLabel="Delete workloads"
          onCancel={() => setWorkloadsDeleteTarget(null)}
          onConfirm={() => {
            const target = workloadsDeleteTarget;
            setWorkloadsDeleteTarget(null);
            void startJob('delete', target);
          }}
          confirming={isPending(workloadsDeleteTarget.id, 'delete')}
        >
          <p style={{ margin: 0 }}>
            This tears down the deployment, service and ingress for <strong>{workloadsDeleteTarget.name}</strong>. This cannot
            be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
