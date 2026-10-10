import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, Rocket, Trash2, Wrench } from 'lucide-react';
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

export function ProjectsPage() {
  const { projects, activeId, refresh, loading, error } = useProjects();
  const [actionError, setActionError] = useState<string | null>(null);
  const [workloadsDeleteTarget, setWorkloadsDeleteTarget] = useState<Project | null>(null);

  const [configs, setConfigs] = useState<Record<string, ConfigResponse>>({});
  const [jobNotices, setJobNotices] = useState<Record<string, JobResponse>>({});
  const [jobPendingKey, setJobPendingKey] = useState<string | null>(null);
  const [deployedIds, setDeployedIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<WorkloadsResponse>('/api/cluster/workloads')
      .then((data) => {
        if (cancelled) return;
        setDeployedIds(
          new Set((data.workloads ?? []).filter((w) => w.deployed && w.projectId).map((w) => w.projectId as string)),
        );
      })
      .catch(() => {
        if (!cancelled) setDeployedIds(new Set());
      });
    return () => {
      cancelled = true;
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
        setJobNotices((prev) => ({ ...prev, [project.id]: job }));
      } catch (err) {
        setActionError(errMsg(err));
      } finally {
        setJobPendingKey((prev) => (prev === key ? null : prev));
      }
    },
    [],
  );

  const isPending = useCallback(
    (projectId: string, op: LifecycleOp) => jobPendingKey === `${projectId}:${op}`,
    [jobPendingKey],
  );
  const isRowBusy = useCallback(
    (projectId: string) => jobPendingKey?.startsWith(`${projectId}:`) ?? false,
    [jobPendingKey],
  );

  const activeProjects = projects.filter((p) => deployedIds?.has(p.id));
  const inactiveProjects = projects.filter((p) => !deployedIds?.has(p.id));

  const renderProjectRow = (p: Project) => {
    const isSelected = p.id === activeId;
    const isDeployed = deployedIds?.has(p.id) ?? false;
    const config = configs[p.id] ?? null;
    const image = config?.merged.image;
    const k8s = config?.merged.k8s;
    const mode = config?.imageMode ?? config?.merged.imageMode;
    const imageText = config
      ? `${[image?.registry, image?.name].filter(Boolean).join('/') || '—'}${image?.tag ? `:${image.tag}` : ''}`
      : '…';
    const notice = jobNotices[p.id] ?? null;
    return (
      <TR key={p.id}>
        <TD>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {p.name}{' '}
            {isSelected && (
              <Badge tone="accent">Active</Badge>
            )}
            {isDeployed ? <Badge tone="accent">Deployed</Badge> : <Badge>Stopped</Badge>}
          </span>
        </TD>
        <TD>{config ? <Badge tone={mode === 'global' ? 'violet' : 'default'}>{mode ?? '—'}</Badge> : '…'}</TD>
        <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-md)' }}>{imageText}</TD>
        <TD>{config ? (k8s?.namespace ?? '—') : '…'}</TD>
        <TD>{config ? (k8s?.nodePort ?? '—') : '…'}</TD>
        <TD>
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            {!isDeployed && (
              <Button
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
              <Button
                variant="secondary"
                onClick={() => setWorkloadsDeleteTarget(p)}
                disabled={isRowBusy(p.id)}
                aria-label={`Delete workloads for ${p.name}`}
                data-ref="page-projects-row-workloads-delete"
              >
                <Trash2 size={16} aria-hidden="true" />{' '}
                {isPending(p.id, 'delete') ? 'Starting…' : 'Delete'}
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

  const renderProjectTable = (list: Project[], label: string) => (
    <TableContainer data-ref={`page-projects-table-container-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <Table aria-label={label} data-ref={`page-projects-table-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Mode</TH>
            <TH>Image</TH>
            <TH>Namespace</TH>
            <TH>NodePort</TH>
            <TH>Actions</TH>
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
          <Link to="/projects/new" className="btn btn-primary" data-ref="page-projects-action-add">
            <Plus size={16} aria-hidden="true" /> Add project
          </Link>
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
              <Link to="/projects/new" className="btn btn-primary" data-ref="page-projects-empty-add">
                <Plus size={16} aria-hidden="true" /> Add project
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <h2 style={{ fontSize: 'var(--font-size-2xl)', margin: '0 0 12px' }} data-ref="page-projects-active-heading">Active projects</h2>
          {activeProjects.length === 0 ? (
            <Card style={{ marginBottom: 24 }} data-ref="page-projects-active-empty-card">
              <p style={{ margin: 0, fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="page-projects-active-empty">
                No active projects — nothing is currently deployed to the cluster.
              </p>
            </Card>
          ) : (
            <div style={{ marginBottom: 24 }} data-ref="page-projects-active-table">{renderProjectTable(activeProjects, 'Active projects')}</div>
          )}

          <h2 style={{ fontSize: 'var(--font-size-2xl)', margin: '0 0 12px' }} data-ref="page-projects-inactive-heading">Inactive projects</h2>
          {inactiveProjects.length === 0 ? (
            <Card data-ref="page-projects-inactive-empty-card">
              <p style={{ margin: 0, fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="page-projects-inactive-empty">
                No inactive projects — everything is deployed.
              </p>
            </Card>
          ) : (
            <div data-ref="page-projects-inactive-table">{renderProjectTable(inactiveProjects, 'Inactive projects')}</div>
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
