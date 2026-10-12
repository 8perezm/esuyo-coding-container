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

interface SummaryResponse {
  ok: boolean;
  workloads?: Workload[];
  nodes?: ClusterNode[];
  metricsAvailable?: boolean;
  ports?: UsedPort[];
  nodesError?: string;
  portsError?: string;
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

function isRunning(w: Workload): boolean {
  return Boolean(w.deployed && w.ready);
}

function compareWorkloads(a: Workload, b: Workload): number {
  const runningDiff = Number(isRunning(b)) - Number(isRunning(a));
  if (runningDiff !== 0) return runningDiff;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

// Human-readable CPU/memory. kubectl-style values look like "250m", "1",
// "1500000n" (CPU) and "220Mi", "1Gi" (memory) — raw strings confuse the
// projects table, especially when a workload has several pods.
export function parseCpuToMillicores(raw?: string | null): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s || s === '—') return null;
  if (s.endsWith('n')) {
    const v = Number.parseFloat(s.slice(0, -1));
    return Number.isNaN(v) ? null : v / 1e6;
  }
  if (s.endsWith('u')) {
    const v = Number.parseFloat(s.slice(0, -1));
    return Number.isNaN(v) ? null : v / 1000;
  }
  if (s.endsWith('m') && !s.endsWith('Mi')) {
    const v = Number.parseFloat(s.slice(0, -1));
    return Number.isNaN(v) ? null : v;
  }
  const v = Number.parseFloat(s);
  return Number.isNaN(v) ? null : v * 1000;
}

export function parseMemoryToBytes(raw?: string | null): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s || s === '—') return null;
  const m = s.match(/^([0-9.]+)\s*([A-Za-z]*)$/);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const suffix = m[2] ?? '';
  const binary: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const decimal: Record<string, number> = {
    k: 1000,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  };
  if (!suffix) return value;
  if (binary[suffix] !== undefined) return value * binary[suffix];
  if (decimal[suffix] !== undefined) return value * decimal[suffix];
  if (suffix === 'm') return value / 1000;
  return null;
}

function trimNum(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

export function formatCpuMillicores(millicores: number | null): string {
  if (millicores === null || Number.isNaN(millicores)) return '—';
  if (millicores >= 1000) return `${trimNum(millicores / 1000, 2)} cores`;
  if (millicores >= 100) return `${trimNum(Math.round(millicores * 10) / 10, 1)} mCPU`;
  if (millicores >= 1) return `${trimNum(Math.round(millicores * 10) / 10, 1)} mCPU`;
  return `${trimNum(Math.round(millicores * 100) / 100, 2)} mCPU`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return '—';
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  const KiB = 1024;
  if (bytes >= GiB) return `${trimNum(bytes / GiB, 2)} GiB`;
  if (bytes >= MiB) {
    const v = bytes / MiB;
    return `${trimNum(v, v >= 100 ? 0 : 1)} MiB`;
  }
  if (bytes >= KiB) return `${trimNum(bytes / KiB, 0)} KiB`;
  return `${Math.round(bytes)} B`;
}

function workloadCpuMillicores(w: Workload): number | null {
  if (!w.deployed || w.pods.length === 0) return null;
  let total = 0;
  let seen = false;
  for (const p of w.pods) {
    const v = parseCpuToMillicores(p.cpu);
    if (v !== null) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

function workloadMemoryBytes(w: Workload): number | null {
  if (!w.deployed || w.pods.length === 0) return null;
  let total = 0;
  let seen = false;
  for (const p of w.pods) {
    const v = parseMemoryToBytes(p.memory);
    if (v !== null) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

function workloadNodeName(w: Workload): string {
  return w.pods[0]?.node ?? w.nodeName ?? '';
}

type ProjectSortKey = 'name' | 'status' | 'cpu' | 'memory' | 'node';
type StatusFilter = 'all' | 'running' | 'stopped';

const FILTER_STORAGE_KEY = 'overviewProjectsFilter';
const SORT_KEY_STORAGE_KEY = 'overviewProjectsSortKey';
const SORT_DIR_STORAGE_KEY = 'overviewProjectsSortDir';

const SORT_KEYS: ProjectSortKey[] = ['name', 'status', 'cpu', 'memory', 'node'];

function readStoredFilter(): StatusFilter {
  try {
    const v = window.localStorage.getItem(FILTER_STORAGE_KEY);
    return v === 'running' || v === 'stopped' ? v : 'all';
  } catch {
    return 'all';
  }
}

function readStoredSortKey(): ProjectSortKey | null {
  try {
    const v = window.localStorage.getItem(SORT_KEY_STORAGE_KEY);
    return (SORT_KEYS as string[]).includes(v ?? '') ? (v as ProjectSortKey) : null;
  } catch {
    return null;
  }
}

function readStoredSortDir(): 1 | -1 {
  try {
    return window.localStorage.getItem(SORT_DIR_STORAGE_KEY) === '-1' ? -1 : 1;
  } catch {
    return 1;
  }
}

function persistStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — selection just won't persist */
  }
}

function compareWorkloadsByKey(a: Workload, b: Workload, key: ProjectSortKey, dir: 1 | -1): number {
  let diff = 0;
  switch (key) {
    case 'name':
      diff = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      break;
    case 'status':
      diff = statusLabel(a).localeCompare(statusLabel(b), undefined, { sensitivity: 'base' });
      break;
    case 'cpu': {
      const av = workloadCpuMillicores(a) ?? -1;
      const bv = workloadCpuMillicores(b) ?? -1;
      diff = av - bv;
      break;
    }
    case 'memory': {
      const av = workloadMemoryBytes(a) ?? -1;
      const bv = workloadMemoryBytes(b) ?? -1;
      diff = av - bv;
      break;
    }
    case 'node':
      diff = workloadNodeName(a).localeCompare(workloadNodeName(b), undefined, { sensitivity: 'base' });
      break;
  }
  if (diff === 0) diff = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return diff * dir;
}

// Five table rows (plus the sticky header) set the default ports-table
// height; users can drag the handle to grow/shrink it.
const PORTS_ROW_PX = 45;
const PORTS_HEADER_PX = 45;
const PORTS_DEFAULT_ROWS = 5;
const PORTS_DEFAULT_HEIGHT = PORTS_HEADER_PX + PORTS_ROW_PX * PORTS_DEFAULT_ROWS;

function clusterErr(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return 'endpoint not found (404) — the GUI server is running old code. Restart it from this repo (see below) so it serves /api/cluster/*.';
  }
  if (err instanceof ApiError && err.status === 401) return 'Unauthorized — log in again.';
  return errMsg(err);
}

// One small green square per pod, shown to the right of the project name.
// Hovering (or keyboard-focusing) the squares shows a compact "N pods" tip.
function PodSquares({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  if (count <= 0) return null;
  const label = count === 1 ? '1 pod' : `${count} pods`;
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 8 }}
      data-ref="page-overview-pod-squares"
      aria-label={label}
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          data-ref="page-overview-pod-square"
          style={{
            width: 10,
            height: 10,
            borderRadius: 2,
            backgroundColor: 'var(--color-success, #1a7f37)',
            display: 'inline-block',
          }}
        />
      ))}
      {open && (
        <span
          role="tooltip"
          data-ref="page-overview-pod-squares-tip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '2px 6px',
            whiteSpace: 'nowrap',
            backgroundColor: 'var(--text-primary)',
            color: 'var(--bg-card)',
            borderRadius: 4,
            fontSize: 'var(--font-size-xs)',
            zIndex: 5,
            pointerEvents: 'none',
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
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
  const [rowJobs, setRowJobs] = useState<Record<string, { op: string; project: string; id: string; status: string; startedAt: number }>>({});
  const [deleteTarget, setDeleteTarget] = useState<Workload | null>(null);
  const [sortKey, setSortKey] = useState<ProjectSortKey | null>(readStoredSortKey);
  const [sortDir, setSortDir] = useState<1 | -1>(readStoredSortDir);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(readStoredFilter);
  const [portsHeight, setPortsHeight] = useState(PORTS_DEFAULT_HEIGHT);
  const [portsResizing, setPortsResizing] = useState(false);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoaded(false);
    else setRefreshing(true);
    // One shared snapshot (server batches kubectl + caches 5s). Falls back
    // to the three legacy endpoints when the server is old.
    const [sRes, jRes] = await Promise.allSettled([
      api.get<SummaryResponse>('/api/cluster/summary'),
      api.get<JobsResponse | Job[]>('/api/jobs'),
    ]);
    if (sRes.status === 'fulfilled') {
      const s = sRes.value;
      setWorkloads(s.workloads ?? []);
      setWorkloadsError(s.ok ? null : (s.error ?? 'Cluster unavailable'));
      setNodes(s.nodes ?? []);
      setNodesMetrics(s.metricsAvailable ?? true);
      setNodesError(s.nodesError ?? (s.ok ? null : (s.error ?? 'Cluster unavailable')));
      setPorts(s.ports ?? []);
      setPortsError(s.portsError ?? (s.ok ? null : (s.error ?? 'Cluster unavailable')));
    } else if (sRes.reason instanceof ApiError && sRes.reason.status === 404) {
      const [wRes, nRes, pRes] = await Promise.allSettled([
        api.get<WorkloadsResponse>('/api/cluster/workloads'),
        api.get<NodesResponse>('/api/cluster/nodes'),
        api.get<PortsResponse>('/api/cluster/ports'),
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
    } else {
      const err = clusterErr(sRes.reason);
      setWorkloads([]);
      setWorkloadsError(err);
      setNodes([]);
      setNodesError(err);
      setPorts([]);
      setPortsError(err);
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
      const entry = { op, project: w.name, id: job.id, status: job.status, startedAt: Date.now() };
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
      const entry = { op: 'delete', project: w.name, id: job.id, status: job.status, startedAt: Date.now() };
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

  // Auto-hide row job notices 10 seconds after they started.
  useEffect(() => {
    const ids = Object.keys(rowJobs);
    if (ids.length === 0) return;
    const prune = () => {
      setRowJobs((prev) => {
        const cutoff = Date.now() - 10000;
        const next: typeof prev = {};
        for (const [id, entry] of Object.entries(prev)) {
          if (entry.startedAt > cutoff) next[id] = entry;
        }
        return next;
      });
    };
    const oldest = Math.min(...ids.map((id) => rowJobs[id]?.startedAt ?? Date.now()));
    const delay = Math.max(oldest + 10000 - Date.now(), 0);
    const timer = window.setTimeout(prune, delay);
    return () => window.clearTimeout(timer);
  }, [rowJobs]);

  const runningCount = workloads?.filter((w) => w.deployed && w.ready).length ?? 0;
  const readyNodes = nodes?.filter((n) => n.ready).length ?? 0;
  const filteredWorkloads = (workloads ?? []).filter((w) => {
    const label = statusLabel(w);
    if (statusFilter === 'running') return label === 'Running';
    if (statusFilter === 'stopped') return label === 'Stopped';
    return true;
  });
  const sortedWorkloads = [...filteredWorkloads].sort((a, b) =>
    sortKey ? compareWorkloadsByKey(a, b, sortKey, sortDir) : compareWorkloads(a, b),
  );

  const toggleSort = useCallback((key: ProjectSortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir(1);
    } else {
      setSortDir((d) => (d === 1 ? -1 : 1));
    }
  }, [sortKey]);

  useEffect(() => {
    persistStored(FILTER_STORAGE_KEY, statusFilter);
  }, [statusFilter]);

  useEffect(() => {
    persistStored(SORT_KEY_STORAGE_KEY, sortKey ?? '');
  }, [sortKey]);

  useEffect(() => {
    persistStored(SORT_DIR_STORAGE_KEY, String(sortDir));
  }, [sortDir]);

  const sortIndicator = (key: ProjectSortKey): string => {
    if (sortKey !== key) return '';
    return sortDir === 1 ? ' ▲' : ' ▼';
  };

  const sortAria = (key: ProjectSortKey): 'ascending' | 'descending' | 'none' => {
    if (sortKey !== key) return 'none';
    return sortDir === 1 ? 'ascending' : 'descending';
  };

  const startPortsResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = portsHeight;
    setPortsResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(800, Math.max(120, startHeight + (ev.clientY - startY)));
      setPortsHeight(next);
    };
    const onUp = () => {
      setPortsResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [portsHeight]);

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

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }} data-ref="page-overview-projects-header-row">
        <h2 style={{ fontSize: 'var(--font-size-2xl)', margin: 0 }} data-ref="page-overview-projects-heading">Projects</h2>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
          <span>Status</span>
          <select
            className="input"
            style={{ minHeight: 32, width: 'auto', padding: '4px 8px' }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            aria-label="Filter projects by status"
            data-ref="page-overview-projects-filter"
          >
            <option value="all">All</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
          </select>
        </label>
      </div>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh' }}>
            <Spinner label="Loading cluster status…" />
          </div>
        </div>
      ) : workloadsError && (!workloads || workloads.length === 0) ? (
        <Card data-ref="page-overview-workloads-error-card"><p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-overview-workloads-error">Could not load workloads: {workloadsError}</p></Card>
      ) : !workloads || workloads.length === 0 ? (
        <div data-ref="page-overview-empty">
          <EmptyState title="No projects yet" description="Add a project first, then deploy it to the cluster." action={<Link to="/projects" data-ref="page-overview-empty-projects-link">Go to Projects</Link>} />
        </div>
      ) : sortedWorkloads.length === 0 ? (
        <Card data-ref="page-overview-projects-filtered-empty-card">
          <p style={{ margin: 0, fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="page-overview-projects-filtered-empty">
            No projects match this filter.
          </p>
        </Card>
      ) : (
        <TableContainer data-ref="page-overview-projects-table-container">
          <Table aria-label="Projects dashboard" data-ref="page-overview-projects-table">
            <THead>
              <TR>
                <TH aria-sort={sortAria('name')} style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('name')} title="Sort by project" data-ref="page-overview-sort-name">Project{sortIndicator('name')}</TH>
                <TH aria-sort={sortAria('status')} style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('status')} title="Sort by status" data-ref="page-overview-sort-status">Status{sortIndicator('status')}</TH>
                <TH>Ports</TH>
                <TH aria-sort={sortAria('cpu')} style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('cpu')} title="Sort by CPU" data-ref="page-overview-sort-cpu">CPU{sortIndicator('cpu')}</TH>
                <TH aria-sort={sortAria('memory')} style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('memory')} title="Sort by memory" data-ref="page-overview-sort-memory">Memory{sortIndicator('memory')}</TH>
                <TH aria-sort={sortAria('node')} style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('node')} title="Sort by node" data-ref="page-overview-sort-node">Node{sortIndicator('node')}</TH>
                <TH>Actions</TH>
              </TR>
            </THead>
            <TBody>
              {sortedWorkloads.map((w) => {
                const key = w.projectId ?? w.name;
                const isPending = pending === `deploy:${w.projectId}` || pending === `delete:${w.projectId}`;
                const cpuTotal = workloadCpuMillicores(w);
                const memTotal = workloadMemoryBytes(w);
                const cpuRaw = !w.deployed ? null : w.pods.length === 0 ? null : w.pods.map((p) => p.cpu ?? '—').join(', ');
                const memRaw = !w.deployed ? null : w.pods.length === 0 ? null : w.pods.map((p) => p.memory ?? '—').join(', ');
                const cpuHuman = !w.deployed ? '—' : w.pods.length === 0 ? '—' : formatCpuMillicores(cpuTotal);
                const memHuman = !w.deployed ? '—' : w.pods.length === 0 ? '—' : formatBytes(memTotal);
                const podNode = w.pods[0]?.node ?? w.nodeName ?? '—';
                return (
                  <TR key={key}>
                    <TD>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center' }}>
                        <span>{w.name}</span>
                        {w.deployed && w.pods.length > 0 && <PodSquares count={w.pods.length} />}
                      </div>
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
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }} title={cpuRaw ?? undefined}>
                      {cpuHuman}
                      {w.deployed && !w.metricsAvailable && <span style={{ display: 'block', fontSize: 'var(--font-size-2xs)', color: 'var(--text-muted)' }}>metrics n/a</span>}
                      {w.resources?.limits?.cpu && <span style={{ display: 'block', fontSize: 'var(--font-size-2xs)', color: 'var(--text-muted)' }}>limit {w.resources.limits.cpu}</span>}
                    </TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }} title={memRaw ?? undefined}>
                      {memHuman}
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
                          <Trash2 size={16} aria-hidden="true" />{pending === `delete:${w.projectId}` ? ' Starting…' : null}
                        </Button>
                      </span>
                      {w.projectId && rowJobs[w.projectId] ? (
                        <JobOutput
                          key={rowJobs[w.projectId].id}
                          job={{ id: rowJobs[w.projectId].id, op: rowJobs[w.projectId].op, status: rowJobs[w.projectId].status }}
                          dataRef="page-overview-row-job"
                          compact
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
            {ports.length} port{ports.length === 1 ? '' : 's'} in use{ports.length > 5 ? ' — scroll or drag the handle to see more' : ''}.
          </p>
          <TableContainer
            data-ref="page-overview-ports-table-container"
            style={{ height: portsHeight, overflowY: 'auto', position: 'relative' }}
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
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Drag to resize ports table"
            aria-valuenow={Math.round(portsHeight)}
            title="Drag up or down to resize"
            data-ref="page-overview-ports-resize"
            onMouseDown={startPortsResize}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 20,
              marginTop: 2,
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              backgroundColor: 'var(--bg-card)',
              cursor: 'ns-resize',
              touchAction: 'none',
              userSelect: 'none',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-xs)',
            }}
          >
            <span aria-hidden="true" style={{ letterSpacing: 2 }}>═══</span>
            <span>{portsResizing ? 'Resizing…' : 'Drag to resize'}</span>
          </div>
        </div>
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
