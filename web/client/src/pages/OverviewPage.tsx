import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, RefreshCw, Rocket, Trash2, X } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { JobOutput } from '../components/JobOutput';
import { Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner, Table, TableContainer, TBody, TD, TH, THead, TR } from '../components/ui';

interface PodStatus {
  name: string;
  phase?: string | null;
  ready?: string;
  restarts?: number;
  node?: string | null;
  cpu?: string | null;
  memory?: string | null;
}

interface Workload {
  projectId?: string | null;
  name: string;
  namespace?: string | null;
  project?: string | null;
  deployed: boolean;
  ready?: boolean | null;
  replicas?: { replicas?: number | null; ready?: number; updated?: number; available?: number } | null;
  pods: PodStatus[];
  servicePorts: Array<{ name: string; port?: number | null; targetPort?: number | string | null; nodePort?: number | null; protocol?: string }>;
  configuredPorts?: {
    sshNodePort?: number | null;
    sshPort?: number | null;
    web: Array<{ name: string; port: number; hosts: string[]; nodePort?: number | null }>;
    sidecars: Array<{ name: string; port: number; nodePort: number }>;
    nodeName?: string | null;
  } | null;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> } | null;
  image?: string | null;
  nodeName?: string | null;
  metricsAvailable?: boolean;
  error?: string | null;
}

interface WorkloadsResponse {
  ok: boolean;
  workloads?: Workload[];
  error?: string;
}

interface ClusterNode {
  name: string;
  ready: boolean;
  cpuCapacity?: string | null;
  cpuAllocatable?: string | null;
  memoryCapacity?: string | null;
  memoryAllocatable?: string | null;
  pods?: number | null;
  kubelet?: string | null;
  osImage?: string | null;
  arch?: string | null;
  cpu?: string | null;
  cpuPercent?: number | null;
  memory?: string | null;
  memoryPercent?: number | null;
}

interface NodesResponse {
  ok: boolean;
  nodes?: ClusterNode[];
  metricsAvailable?: boolean;
  error?: string;
}

interface UsedPort {
  namespace: string;
  service: string;
  name: string;
  port?: number | null;
  targetPort?: number | string | null;
  nodePort: number;
  protocol?: string;
}

interface PortsResponse {
  ok: boolean;
  ports?: UsedPort[];
  error?: string;
}

interface Job {
  id: string;
  op: string;
  status: string;
  startedAt?: string | null;
}

interface JobsResponse {
  jobs?: Job[];
}

interface JobStarted {
  id: string;
  status: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

function dash(v?: string | number | null): string {
  return v === undefined || v === null || v === '' ? '—' : String(v);
}

function statusTone(w: Workload): 'accent' | 'default' | 'violet' {
  if (w.error && !w.deployed) return 'violet';
  if (w.deployed && w.ready) return 'accent';
  return 'default';
}

function statusLabel(w: Workload): string {
  if (w.error && !w.deployed) return 'Error';
  if (!w.deployed) return 'Stopped';
  if (w.ready) return 'Running';
  return 'Degraded';
}

function clusterErr(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return 'endpoint not found (404) — the GUI server is running old code. Restart it from this repo (see below) so it serves /api/cluster/*.';
  }
  if (err instanceof ApiError && err.status === 401) return 'Unauthorized — log in again.';
  return errMsg(err);
}

function formatStartedAt(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function OverviewPage() {
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workloads, setWorkloads] = useState<Workload[] | null>(null);
  const [workloadsError, setWorkloadsError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<ClusterNode[] | null>(null);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [nodesMetrics, setNodesMetrics] = useState(true);
  const [ports, setPorts] = useState<UsedPort[] | null>(null);
  const [portsError, setPortsError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ op: string; project: string; id: string; status: string } | null>(null);
  const [rowJobs, setRowJobs] = useState<Record<string, { op: string; project: string; id: string; status: string }>>({});
  const [deleteTarget, setDeleteTarget] = useState<Workload | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoaded(false);
    else setRefreshing(true);
    const [wRes, nRes, pRes, jRes] = await Promise.allSettled([
      api.get<WorkloadsResponse>('/api/cluster/workloads'),
      api.get<NodesResponse>('/api/cluster/nodes'),
      api.get<PortsResponse>('/api/cluster/ports'),
      api.get<JobsResponse | Job[]>('/api/jobs'),
    ]);
    if (wRes.status === 'fulfilled') {
      setWorkloads(wRes.value.workloads ?? []);
      setWorkloadsError(wRes.value.ok ? null : (wRes.value.error ?? 'Cluster unavailable'));
    } else {
      setWorkloads([]);
      setWorkloadsError(clusterErr(wRes.reason));
    }
    if (nRes.status === 'fulfilled') {
      setNodes(nRes.value.nodes ?? []);
      setNodesMetrics(nRes.value.metricsAvailable ?? true);
      setNodesError(nRes.value.ok ? null : (nRes.value.error ?? 'Cluster unavailable'));
    } else {
      setNodes([]);
      setNodesError(clusterErr(nRes.reason));
    }
    if (pRes.status === 'fulfilled') {
      setPorts(pRes.value.ports ?? []);
      setPortsError(pRes.value.ok ? null : (pRes.value.error ?? 'Cluster unavailable'));
    } else {
      setPorts([]);
      setPortsError(clusterErr(pRes.reason));
    }
    if (jRes.status === 'fulfilled') {
      const data = jRes.value;
      setJobs(Array.isArray(data) ? data : (data.jobs ?? []));
    }
    setLoaded(true);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load(true).then(() => {});
    const timer = window.setInterval(() => {
      if (!cancelled) void load(false);
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load]);

  const runOp = useCallback(async (w: Workload, op: 'deploy' | 'delete') => {
    if (!w.projectId) {
      setActionError('Project is not in the registry; add it on the Projects page first.');
      return;
    }
    if (op === 'delete') {
      setDeleteTarget(w);
      return;
    }
    setActionError(null);
    setNotice(null);
    setPending(`${op}:${w.projectId}`);
    try {
      const job = await api.post<JobStarted>('/api/jobs', { op, projectId: w.projectId, args: {} });
      const entry = { op, project: w.name, id: job.id, status: job.status };
      setNotice(entry);
      setRowJobs((prev) => ({ ...prev, [w.projectId as string]: entry }));
    } catch (err) {
      setActionError(errMsg(err));
    } finally {
      setPending(null);
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    const w = deleteTarget;
    if (!w?.projectId) return;
    setActionError(null);
    setNotice(null);
    setPending(`delete:${w.projectId}`);
    try {
      const job = await api.post<JobStarted>('/api/jobs', { op: 'delete', projectId: w.projectId, args: {} });
      const entry = { op: 'delete', project: w.name, id: job.id, status: job.status };
      setNotice(entry);
      setRowJobs((prev) => ({ ...prev, [w.projectId as string]: entry }));
    } catch (err) {
      setActionError(errMsg(err));
    } finally {
      setPending(null);
      setDeleteTarget(null);
    }
  }, [deleteTarget]);

  // Auto-dismiss the job notice after 10 seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 10000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const runningCount = workloads?.filter((w) => w.deployed && w.ready).length ?? 0;
  const readyNodes = nodes?.filter((n) => n.ready).length ?? 0;

  const stats = [
    { label: 'Projects running', to: '/projects', hint: `${runningCount} / ${workloads?.length ?? '—'} deployed`, value: !loaded ? '…' : `${runningCount}/${workloads?.length ?? 0}` },
    { label: 'Nodes ready', to: '/', hint: 'kubelet Ready', value: !loaded ? '…' : `${readyNodes}/${nodes?.length ?? 0}` },
    { label: 'Ports in use', to: '/', hint: 'NodePorts allocated', value: !loaded ? '…' : String(ports?.length ?? 0) },
    { label: 'Jobs', to: '/jobs', hint: 'recent background ops', value: !loaded ? '…' : String(jobs.length) },
  ];

  return (
    <div data-ref="page-overview">
      <PageHeader
        title="Dashboard"
        description="Live projects, ports, resource usage and nodes."
        actions={
          <Button variant="secondary" onClick={() => void load(false)} disabled={refreshing} aria-label="Refresh dashboard" data-ref="page-overview-refresh">
            <RefreshCw size={16} aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />

      <div className="stat-grid" style={{ marginBottom: 24 }} data-ref="page-overview-stats">
        {stats.map((s) => (
          <Card key={s.label} data-ref="page-overview-stat-card">
            <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)', fontWeight: 600 }}>{s.label}</p>
            <p style={{ margin: '4px 0', fontFamily: 'var(--font-heading)', fontSize: 'var(--font-size-5xl)', fontWeight: 700 }}>
              <Link to={s.to}>{s.value}</Link>
            </p>
            <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>{s.hint}</p>
          </Card>
        ))}
      </div>

      {actionError && (
        <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)' }} data-ref="page-overview-action-error">{actionError}</p>
      )}
      {(workloadsError?.includes('404') || nodesError?.includes('404') || portsError?.includes('404')) && (
        <Card style={{ marginBottom: 16, borderColor: 'var(--color-error, #b3261e)' }} data-ref="page-overview-stale-api-card">
          <p style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
            The dashboard UI is newer than the API server. Restart the API server, then refresh.
          </p>
        </Card>
      )}

      <h2 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }} data-ref="page-overview-projects-heading">Projects</h2>
      {notice && (
        <Card
          role="status"
          data-ref="page-overview-notice"
          style={{
            marginBottom: 16,
            borderLeft: '4px solid var(--color-success, #1a7f37)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <CheckCircle2 size={20} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-success, #1a7f37)' }} />
          <div style={{ flex: 1, fontSize: 'var(--font-size-md)' }}>
            <p style={{ margin: 0, fontWeight: 600, textTransform: 'capitalize' }}>
              {notice.op} started for &ldquo;{notice.project}&rdquo;
            </p>
            <p style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>
              Job <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{notice.id.slice(0, 8)}</code>
              {' '}· <Badge tone={notice.status === 'running' ? 'accent' : 'default'}>{notice.status}</Badge>
              {' '}— <Link to="/jobs" data-ref="page-overview-notice-jobs-link">View jobs</Link>
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
            data-ref="page-overview-notice-dismiss"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </Card>
      )}
      {!loaded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Loading dashboard" data-ref="page-overview-loading">
          <div className="skeleton" style={{ height: 48 }} />
          <div className="skeleton" style={{ height: 48 }} />
          <Spinner label="Loading cluster status…" />
        </div>
      ) : workloadsError && (!workloads || workloads.length === 0) ? (
        <Card data-ref="page-overview-workloads-error-card"><p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-overview-workloads-error">Could not load workloads: {workloadsError}</p></Card>
      ) : !workloads || workloads.length === 0 ? (
        <div data-ref="page-overview-empty">
          <EmptyState title="No projects yet" description="Add a project first, then deploy it to the cluster." action={<Link to="/projects" data-ref="page-overview-empty-projects-link">Go to Projects</Link>} />
        </div>
      ) : (
        <TableContainer data-ref="page-overview-projects-table-container">
          <Table aria-label="Projects dashboard" data-ref="page-overview-projects-table">
            <THead>
              <TR>
                <TH>Project</TH>
                <TH>Status</TH>
                <TH>Ports</TH>
                <TH>CPU</TH>
                <TH>Memory</TH>
                <TH>Node</TH>
                <TH>Actions</TH>
              </TR>
            </THead>
            <TBody>
              {workloads.map((w) => {
                const key = w.projectId ?? w.name;
                const isPending = pending === `deploy:${w.projectId}` || pending === `delete:${w.projectId}`;
                const cpuText = !w.deployed ? '—' : w.pods.length === 0 ? '—' : w.pods.map((p) => p.cpu ?? '—').join(', ');
                const memText = !w.deployed ? '—' : w.pods.length === 0 ? '—' : w.pods.map((p) => p.memory ?? '—').join(', ');
                const podNode = w.pods[0]?.node ?? w.nodeName ?? '—';
                return (
                  <TR key={key}>
                    <TD>
                      <div style={{ fontWeight: 600 }}>{w.name}</div>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {dash(w.namespace)}{w.project && w.project !== w.name ? ` / ${w.project}` : ''}
                        {w.replicas ? ` · ${w.replicas.ready ?? 0}/${w.replicas.replicas ?? 0} ready` : ''}
                      </div>
                      {w.error && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-error, #b3261e)' }}>{w.error}</div>}
                    </TD>
                    <TD><Badge tone={statusTone(w)}>{statusLabel(w)}</Badge></TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}>
                      {w.configuredPorts ? (
                        <span>
                          ssh:{dash(w.configuredPorts.sshNodePort)}
                          {w.configuredPorts.web.map((p) => (
                            <span key={p.name} style={{ display: 'block' }}>
                              {p.name} {p.port}{p.nodePort ? ` → :${p.nodePort}` : ''}
                            </span>
                          ))}
                          {w.configuredPorts.sidecars.map((p) => (
                            <span key={p.name} style={{ display: 'block' }}>
                              {p.name} {p.port} → :{p.nodePort}
                            </span>
                          ))}
                        </span>
                      ) : '—'}
                    </TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}>
                      {cpuText}
                      {w.deployed && !w.metricsAvailable && <span style={{ display: 'block', fontSize: 'var(--font-size-2xs)', color: 'var(--text-muted)' }}>metrics n/a</span>}
                      {w.resources?.limits?.cpu && <span style={{ display: 'block', fontSize: 'var(--font-size-2xs)', color: 'var(--text-muted)' }}>limit {w.resources.limits.cpu}</span>}
                    </TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}>
                      {memText}
                      {w.resources?.limits?.memory && <span style={{ display: 'block', fontSize: 'var(--font-size-2xs)', color: 'var(--text-muted)' }}>limit {w.resources.limits.memory}</span>}
                    </TD>
                    <TD style={{ fontSize: 'var(--font-size-xs)' }}>{podNode}</TD>
                    <TD>
                      <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                        <Button
                          variant="secondary"
                          onClick={() => void runOp(w, 'deploy')}
                          disabled={isPending || !w.projectId}
                          aria-label={`Deploy project ${w.name}`}
                          data-ref="page-overview-action-deploy"
                        >
                          <Rocket size={16} aria-hidden="true" /> {pending === `deploy:${w.projectId}` ? 'Starting…' : 'Deploy'}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => void runOp(w, 'delete')}
                          disabled={isPending || !w.projectId || !w.deployed}
                          aria-label={`Delete project ${w.name}`}
                          title={!w.deployed ? 'Nothing deployed' : undefined}
                          data-ref="page-overview-action-delete"
                        >
                          <Trash2 size={16} aria-hidden="true" /> {pending === `delete:${w.projectId}` ? 'Starting…' : 'Delete'}
                        </Button>
                      </span>
                      {w.projectId && rowJobs[w.projectId] ? (
                        <JobOutput
                          key={rowJobs[w.projectId].id}
                          job={{ id: rowJobs[w.projectId].id, op: rowJobs[w.projectId].op, status: rowJobs[w.projectId].status }}
                          dataRef="page-overview-row-job"
                        />
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableContainer>
      )}

      <h2 style={{ fontSize: 'var(--font-size-2xl)', margin: '24px 0 12px' }} data-ref="page-overview-nodes-heading">Nodes</h2>
      {nodesError ? (
        <Card data-ref="page-overview-nodes-error-card"><p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-overview-nodes-error">Could not load nodes: {nodesError}</p></Card>
      ) : !nodes || nodes.length === 0 ? (
        <Card data-ref="page-overview-nodes-empty-card"><p style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-overview-nodes-empty">{!loaded ? 'Loading…' : 'No nodes found.'}</p></Card>
      ) : (
        <>
          {!nodesMetrics && (
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="page-overview-nodes-metrics-note">Live CPU/memory unavailable (metrics-server missing) — showing capacity only.</p>
          )}
          <TableContainer data-ref="page-overview-nodes-table-container">
            <Table aria-label="Cluster nodes" data-ref="page-overview-nodes-table">
              <THead>
                <TR>
                  <TH>Node</TH>
                  <TH>Status</TH>
                  <TH>CPU</TH>
                  <TH>Memory</TH>
                  <TH>Pods</TH>
                  <TH>Info</TH>
                </TR>
              </THead>
              <TBody>
                {nodes.map((n) => (
                  <TR key={n.name}>
                    <TD style={{ fontWeight: 600 }}>{n.name}</TD>
                    <TD><Badge tone={n.ready ? 'accent' : 'violet'}>{n.ready ? 'Ready' : 'NotReady'}</Badge></TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}>
                      {n.cpu ?? '—'}{n.cpuPercent != null ? ` (${n.cpuPercent}%)` : ''} / {dash(n.cpuAllocatable)}
                    </TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}>
                      {n.memory ?? '—'}{n.memoryPercent != null ? ` (${n.memoryPercent}%)` : ''} / {dash(n.memoryAllocatable)}
                    </TD>
                    <TD>{n.pods ?? '—'}</TD>
                    <TD style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                      {dash(n.kubelet)} · {dash(n.arch)}
                      <span style={{ display: 'block' }}>{dash(n.osImage)}</span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableContainer>
        </>
      )}

      <h2 style={{ fontSize: 'var(--font-size-2xl)', margin: '24px 0 12px' }} data-ref="page-overview-ports-heading">Ports in use</h2>
      {portsError ? (
        <Card data-ref="page-overview-ports-error-card"><p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-overview-ports-error">Could not load ports: {portsError}</p></Card>
      ) : !ports || ports.length === 0 ? (
        <Card data-ref="page-overview-ports-empty-card"><p style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-overview-ports-empty">{!loaded ? 'Loading…' : 'No NodePorts allocated.'}</p></Card>
      ) : (
        <div>
          <p data-ref="page-overview-ports-count" style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
            {ports.length} port{ports.length === 1 ? '' : 's'} in use{ports.length > 10 ? ' — scroll to see all' : ''}.
          </p>
          <TableContainer
            data-ref="page-overview-ports-table-container"
            style={{ maxHeight: 480, overflowY: 'auto' }}
          >
            <Table aria-label="Ports in use" data-ref="page-overview-ports-table">
              <THead>
                <TR>
                  <TH style={{ position: 'sticky', top: 0, backgroundColor: 'var(--bg-table-header)', zIndex: 1 }}>NodePort</TH>
                  <TH style={{ position: 'sticky', top: 0, backgroundColor: 'var(--bg-table-header)', zIndex: 1 }}>Service</TH>
                  <TH style={{ position: 'sticky', top: 0, backgroundColor: 'var(--bg-table-header)', zIndex: 1 }}>Port name</TH>
                  <TH style={{ position: 'sticky', top: 0, backgroundColor: 'var(--bg-table-header)', zIndex: 1 }}>Service port</TH>
                </TR>
              </THead>
              <TBody>
                {ports.map((p) => (
                  <TR key={`${p.namespace}/${p.service}/${p.nodePort}`}>
                    <TD style={{ fontFamily: 'monospace', fontWeight: 700 }}>{p.nodePort}</TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-sm)' }}>{p.namespace}/{p.service}</TD>
                    <TD>{dash(p.name)}</TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-sm)' }}>{dash(p.port)} → {dash(p.targetPort)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableContainer>
        </div>
      )}

      <h2 style={{ fontSize: 'var(--font-size-2xl)', margin: '24px 0 12px' }} data-ref="page-overview-jobs-heading">Recent jobs</h2>
      {jobs.length === 0 ? (
        <div data-ref="page-overview-jobs-empty">
          <EmptyState title="No jobs yet" description="Deploy / delete operations will appear here." action={<Link to="/jobs" data-ref="page-overview-jobs-empty-link">View jobs</Link>} />
        </div>
      ) : (
        <TableContainer data-ref="page-overview-jobs-table-container">
          <Table data-ref="page-overview-jobs-table">
            <THead>
              <TR>
                <TH>ID</TH>
                <TH>Op</TH>
                <TH>Status</TH>
                <TH>Started</TH>
              </TR>
            </THead>
            <TBody>
              {jobs.slice(0, 8).map((job) => (
                <TR key={job.id}>
                  <TD>
                    <Link to="/jobs" title={job.id} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {job.id.slice(0, 8)}
                    </Link>
                  </TD>
                  <TD>{job.op}</TD>
                  <TD><Badge tone={job.status === 'running' ? 'accent' : job.status === 'error' ? 'violet' : 'default'}>{job.status}</Badge></TD>
                  <TD>{formatStartedAt(job.startedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableContainer>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          confirmLabel="Delete workloads"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
          confirming={pending === `delete:${deleteTarget.projectId}`}
        >
          <p style={{ margin: 0 }}>
            This tears down the deployment, service and ingress for <strong>{deleteTarget.name}</strong>
            {deleteTarget.namespace ? <> in namespace <code>{deleteTarget.namespace}</code></> : null}.
            This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
