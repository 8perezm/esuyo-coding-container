import { Suspense, lazy, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import { buildSystemInitArgs } from '../lib/systemJobs';
import { jobTone } from './job-helpers';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  Spinner,
} from '../components/ui';
import { useValidation } from '../components/ValidatePanel';

const YamlEditor = lazy(() =>
  import('../components/YamlEditor').then((m) => ({ default: m.YamlEditor })),
);

const ValidateActions = lazy(() =>
  import('../components/ValidatePanel').then((m) => ({ default: m.ValidateActions })),
);

const ValidationResults = lazy(() =>
  import('../components/ValidatePanel').then((m) => ({ default: m.ValidationResults })),
);

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

interface GlobalConfigResponse {
  exists: boolean;
  path: string;
  rawYaml: string | null;
}

interface SystemState {
  current: string;
  previous: string | null;
  maxEver: string;
  keep: number;
}

interface StateResponse {
  ok: boolean;
  state?: SystemState;
  image?: string;
  error?: string;
}

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

interface JobDetail {
  id: string;
  op: string;
  status: string;
  exitCode?: number | null;
  argv?: string[];
  logs?: string;
  logTail?: string;
  startedAt?: string;
  finishedAt?: string | null;
}

interface JobDetailResponse {
  job: JobDetail;
}

function useJobDetail(jobId: string | null) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const data = await api.get<JobDetailResponse>(
          `/api/jobs/${encodeURIComponent(jobId as string)}`,
        );
        if (!cancelled) {
          setDetail(data.job);
          setDetailError(null);
        }
      } catch (err) {
        if (!cancelled) setDetailError(errMsg(err));
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId]);

  return { detail, detailError };
}

function JobProgress({ job }: { job: JobResponse }) {
  const { detail, detailError } = useJobDetail(job.id);
  const live = detail ?? job;
  const running = live.status === 'running';
  const logs = (detail?.logs ?? detail?.logTail ?? '').trim();
  const liveExit = (live as Partial<JobDetail>).exitCode;

  return (
    <div data-ref="page-system-init-job-detail">
      <p data-ref="page-system-status-init-job" style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }}>
        {job.op} started: <code data-ref="page-system-init-job-id">{job.id}</code> ({job.status}) —{' '}
        <Link data-ref="page-system-link-jobs" to="/jobs">View jobs</Link>
      </p>
      <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)' }}>
        <Badge tone={jobTone(live.status)}>{live.status}</Badge>
        {running ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>running, refreshing…</span>
        ) : liveExit !== null && liveExit !== undefined ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>exit {liveExit}</span>
        ) : null}
      </p>
      {detailError ? (
        <p data-ref="page-system-init-job-detail-error" role="alert" style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }}>
          Could not load job output: {detailError}
        </p>
      ) : !detail ? (
        <Spinner label="Loading job output…" />
      ) : (
        <pre
          data-ref="page-system-init-job-detail-logs"
          aria-label="Job logs"
          style={{
            margin: 0,
            maxHeight: 400,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 'var(--font-size-sm)',
            lineHeight: 1.5,
            padding: 12,
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
          }}
        >
          {logs || '(no output yet)'}
        </pre>
      )}
      <p data-ref="page-system-init-job-detail-status" style={{ margin: '8px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
        Status: {live.status}
      </p>
    </div>
  );
}

function GlobalConfigCard({ projectId }: { projectId: string | null }) {
  const [path, setPath] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [yaml, setYaml] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const validation = useValidation(projectId);

  useEffect(() => {
    let cancelled = false;
    api
      .get<GlobalConfigResponse>('/api/global-config')
      .then((data) => {
        if (cancelled) return;
        setPath(data.path);
        setExists(data.exists);
        setYaml(data.rawYaml ?? '');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errMsg(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaveNotice(null);
    setSaveError(null);
    try {
      const res = await api.put<{ ok: boolean; path: string }>('/api/global-config', { yaml });
      setExists(true);
      setSaveNotice(`Saved to ${res.path}`);
    } catch (err) {
      setSaveError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-ref="page-system-global-section">
      <h2 data-ref="page-system-heading-global" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>Global configuration</h2>
      {loading ? (
        <Card data-ref="page-system-global-card-loading">
          <Spinner label="Loading global config…" />
        </Card>
      ) : loadError ? (
        <Card data-ref="page-system-global-card-error">
          <p data-ref="page-system-alert-global-load" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
            Could not load global config: {loadError}
          </p>
        </Card>
      ) : (
        <Card data-ref="page-system-global-card">
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {exists ? <Badge tone="accent">exists</Badge> : <Badge>missing</Badge>}
            {path ? <code style={{ ...monoStyle, fontSize: 'var(--font-size-sm)', wordBreak: 'break-all' }}>{path}</code> : null}
          </p>
          <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
            Warning: the shared registry and NFS settings live here. Editing them affects every
            project.
          </p>
          <div data-ref="page-system-form-global">
            <Label htmlFor="system-global-yaml">global.yaml</Label>
            <Suspense fallback={<Spinner label="Loading editor…" />}>
              <YamlEditor id="system-global-yaml" value={yaml} onChange={setYaml} height="300px" />
            </Suspense>
          </div>
          {saveNotice ? (
            <p data-ref="page-system-status-global-save" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)' }}>{saveNotice}</p>
          ) : null}
          {saveError ? (
            <p data-ref="page-system-alert-global-save" role="alert" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)' }}>
              Save failed: {saveError}
            </p>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <Suspense fallback={<Spinner label="Loading validator…" />}>
              <ValidateActions
                validation={validation}
                draft={{ globalYaml: yaml }}
                compact
                saveButton={
                  <Button data-ref="page-system-submit-global" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? 'Saving…' : 'Save global config'}
                  </Button>
                }
              />
            </Suspense>
          </div>
          <Suspense fallback={<Spinner label="Loading validator…" />}>
            <ValidationResults validation={validation} />
          </Suspense>
        </Card>
      )}
    </section>
  );
}

function StateSummary({ projectId }: { projectId: string | null }) {
  const [summary, setSummary] = useState<SystemState | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    setWarning(null);
    setError(null);
    // projectId is optional: without it the server uses the repo-root default
    // config (same as `coding-container system ...` with no -c flag).
    const url = projectId
      ? `/api/system/state?projectId=${encodeURIComponent(projectId)}`
      : '/api/system/state';
    api
      .get<StateResponse>(url)
      .then((data) => {
        if (cancelled) return;
        if (data.ok && data.state) {
          setSummary(data.state);
        } else {
          setWarning(data.error ?? 'System is not initialized.');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errMsg(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <section data-ref="page-system-state-section">
      <h2 data-ref="page-system-heading-state" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>State summary</h2>
      <Card data-ref="page-system-state-card">
        {loading ? (
          <Spinner label="Loading state…" />
        ) : error ? (
          <p data-ref="page-system-alert-state" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
            Could not load system state: {error}
          </p>
        ) : warning ? (
          <p data-ref="page-system-status-state-warning" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
            {warning} Run system init below, or see <Link data-ref="page-system-link-images" to="/images">Images</Link>.
          </p>
        ) : summary ? (
          <dl data-ref="page-system-status-state" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px 24px' }}>
            <div>
              <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Current</dt>
              <dd style={{ margin: '4px 0 0' }}>
                <Badge tone="accent">{summary.current}</Badge>
              </dd>
            </div>
            <div>
              <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Previous</dt>
              <dd style={{ margin: '4px 0 0', fontSize: 'var(--font-size-md)' }}>{summary.previous ?? '—'}</dd>
            </div>
            <div>
              <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Max ever</dt>
              <dd style={{ margin: '4px 0 0', fontSize: 'var(--font-size-md)' }}>{summary.maxEver}</dd>
            </div>
            <div>
              <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Keep</dt>
              <dd style={{ margin: '4px 0 0', fontSize: 'var(--font-size-md)' }}>{summary.keep}</dd>
            </div>
          </dl>
        ) : (
          <p style={{ margin: 0, fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
            No state to show yet.
          </p>
        )}
      </Card>
    </section>
  );
}

export function SystemPage() {
  const { projects } = useProjects();
  // Validation needs a project context; default to the first project.
  // State + init are global and use the repo default (projectId null).
  const validationProjectId = projects[0]?.id ?? null;

  const [initTag, setInitTag] = useState('');
  const [initKeep, setInitKeep] = useState('10');
  const [pending, setPending] = useState(false);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleInit(e: FormEvent) {
    e.preventDefault();
    const parsed = buildSystemInitArgs(initTag, initKeep);
    if (parsed.error || !parsed.args) {
      setError(parsed.error ?? 'Invalid init values.');
      setJob(null);
      return;
    }
    setPending(true);
    setError(null);
    setJob(null);
    api
      .post<JobResponse>('/api/jobs', { op: 'system-init', projectId: null, args: parsed.args })
      .then((created) => setJob(created))
      .catch((err) => setError(errMsg(err)))
      .finally(() => setPending(false));
  }

  return (
    <div data-ref="page-system">
      <PageHeader title="System" description="Cluster health, versions, and global configuration." />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <GlobalConfigCard projectId={validationProjectId} />

        <section key="state-global">
          <StateSummary projectId={null} />
        </section>

        <section>
          <h2 data-ref="page-system-heading-init" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>System init</h2>
          <Card data-ref="page-system-init-card">
            <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
              Creates the first system version and state ConfigMap. Run once per cluster, then
              publish new versions from the Images page. No project needed — runs with the repo
              default config. global-mode is required, custom-mode projects are refused by the server.
            </p>
            <form data-ref="page-system-form-init" onSubmit={handleInit}>
              <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
                <div>
                  <Label htmlFor="system-init-tag">Tag (required)</Label>
                  <Input
                    data-ref="page-system-init-tag-field"
                    id="system-init-tag"
                    value={initTag}
                    onChange={(e) => setInitTag(e.target.value)}
                    placeholder="v1.0.0"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <Label htmlFor="system-init-keep">Keep</Label>
                  <Input
                    data-ref="page-system-init-keep-field"
                    id="system-init-keep"
                    value={initKeep}
                    onChange={(e) => setInitKeep(e.target.value)}
                    placeholder="10"
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <Button data-ref="page-system-submit-init" type="submit" disabled={pending}>
                  {pending ? 'Starting…' : 'Initialize system'}
                </Button>
              </div>
            </form>
            {job ? (
              <div style={{ marginTop: 16 }}>
                <JobProgress key={job.id} job={job} />
              </div>
            ) : null}
            {error ? (
              <p data-ref="page-system-alert-init" role="alert" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)' }}>
                system-init failed: {error}
              </p>
            ) : null}
          </Card>
        </section>
      </div>
    </div>
  );
}
