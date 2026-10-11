import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import {
  buildOptionalTagArgs,
  buildSystemGcArgs,
  parseKeepInput,
  sortTagsNewestFirst,
} from '../lib/systemJobs';
import { jobTone } from './job-helpers';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Spinner,
  Table,
  TableContainer,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../components/ui';

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

const checkboxRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 44,
  fontSize: 'var(--font-size-md)',
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
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

interface TagsResponse {
  tags?: string[];
}

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

interface GlobalConfigResponse {
  exists: boolean;
  path: string;
  dockerfile?: { path: string; exists: boolean };
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

function useSystemState(projectId: string | null, refreshTick = 0) {
  const [state, setState] = useState<SystemState | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setState(null);
    setImage(null);
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
          setState(data.state);
          setImage(data.image ?? null);
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
  }, [projectId, refreshTick]);

  return { state, image, warning, error, loading };
}

function useGlobalDockerfile() {
  const [dockerfile, setDockerfile] = useState<{ path: string; exists: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<GlobalConfigResponse>('/api/global-config')
      .then((data) => {
        if (cancelled) return;
        setDockerfile(data.dockerfile ?? null);
      })
      .catch(() => {
        if (!cancelled) setDockerfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return dockerfile;
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

function StateCard({
  loading,
  error,
  warning,
  state,
  image,
  dockerfile,
  showDockerfile,
}: {
  loading: boolean;
  error: string | null;
  warning: string | null;
  state: SystemState | null;
  image: string | null;
  dockerfile: { path: string; exists: boolean } | null;
  showDockerfile: boolean;
}) {
  if (loading) {
    return (
      <Card data-ref="page-images-card-state-loading">
        <Spinner label="Loading system state…" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card data-ref="page-images-card-state-error">
        <p data-ref="page-images-alert-state-error" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
          Could not load system state: {error}
        </p>
      </Card>
    );
  }
  if (!state) {
    return (
      <Card data-ref="page-images-card-state-empty">
        <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)', fontWeight: 600 }}>System is not initialized.</p>
        {warning ? (
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>{warning}</p>
        ) : null}
        <p style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
          Run system init from the <Link data-ref="page-images-link-system" to="/system">System page</Link> to create the first version.
        </p>
      </Card>
    );
  }
  return (
    <Card data-ref="page-images-card-state">
      <dl data-ref="page-images-state-list" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px 24px' }}>
        <div>
          <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Current</dt>
          <dd style={{ margin: '4px 0 0' }}>
            <Badge tone="accent">{state.current}</Badge>
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Previous</dt>
          <dd style={{ margin: '4px 0 0', fontSize: 'var(--font-size-md)' }}>{state.previous ?? '—'}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Max ever</dt>
          <dd style={{ margin: '4px 0 0', fontSize: 'var(--font-size-md)' }}>{state.maxEver}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-muted)' }}>Keep</dt>
          <dd style={{ margin: '4px 0 0', fontSize: 'var(--font-size-md)' }}>{state.keep}</dd>
        </div>
      </dl>
      {image ? (
        <p data-ref="page-images-state-image" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-sm)', wordBreak: 'break-all' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Resolved image: </span>
          <code data-ref="page-images-state-image-code" style={monoStyle}>{image}</code>
        </p>
      ) : null}
      {showDockerfile && dockerfile ? (
        <p data-ref="page-images-state-dockerfile" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-sm)', wordBreak: 'break-all' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>System Dockerfile: </span>
          <code data-ref="page-images-state-dockerfile-code" style={monoStyle}>{dockerfile.path}</code>
          {!dockerfile.exists ? (
            <span data-ref="page-images-state-dockerfile-missing" style={{ color: 'var(--color-error, #b3261e)' }}> (missing — run setup to create it)</span>
          ) : null}
        </p>
      ) : null}
    </Card>
  );
}

function TagsSection({
  projectId,
  current,
  previous,
  refreshTick,
}: {
  projectId: string | null;
  current: string | null;
  previous: string | null;
  refreshTick: number;
}) {
  const [tags, setTags] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTags(null);
    setError(null);
    const url = projectId
      ? `/api/system/tags?projectId=${encodeURIComponent(projectId)}`
      : '/api/system/tags';
    api
      .get<TagsResponse>(url)
      .then((data) => {
        if (cancelled) return;
        setTags(sortTagsNewestFirst(data.tags ?? []));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errMsg(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshTick]);

  if (error) {
    return (
      <Card data-ref="page-images-card-tags-error">
        <p data-ref="page-images-alert-tags-error" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
          Could not load tags: {error}
        </p>
      </Card>
    );
  }
  if (tags === null) {
    return (
      <Card data-ref="page-images-card-tags-loading">
        <Spinner label="Loading tags…" />
      </Card>
    );
  }
  if (tags.length === 0) {
    return (
      <EmptyState
        title="No versions yet"
        description="Publish a version below and it will appear here."
      />
    );
  }
  // Newest first; scroll inside the table once there are more than ~10 rows.
  const showScrollHint = tags.length > 10;
  return (
    <div>
      <p data-ref="page-images-versions-count" style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
        {tags.length} version{tags.length === 1 ? '' : 's'}, newest first{showScrollHint ? ' — scroll to see all' : ''}.
      </p>
      <TableContainer
        data-ref="page-images-table-container-versions"
        style={{ maxHeight: 480, overflowY: 'auto' }}
      >
      <Table data-ref="page-images-table-versions">
        <THead>
          <TR>
            <TH style={{ position: 'sticky', top: 0, backgroundColor: 'var(--bg-table-header)', zIndex: 1 }}>Tag</TH>
            <TH style={{ position: 'sticky', top: 0, backgroundColor: 'var(--bg-table-header)', zIndex: 1 }}>Status</TH>
          </TR>
        </THead>
        <TBody>
          {tags.map((tag) => (
            <TR key={tag}>
              <TD>
                <code style={monoStyle}>{tag}</code>
              </TD>
              <TD>
                {tag === current ? (
                  <Badge tone="accent">current</Badge>
                ) : tag === previous ? (
                  <Badge>previous</Badge>
                ) : (
                  '—'
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableContainer>
    </div>
  );
}

function JobNotice({ job, op }: { job: JobResponse | null; op: string }) {
  if (!job) return null;
  return (
    <p data-ref="page-images-status-job" style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }}>
      {op} started: <code data-ref="page-images-job-id">{job.id}</code> ({job.status}) — <Link data-ref="page-images-link-jobs" to="/jobs">View jobs</Link>
    </p>
  );
}

function JobProgress({
  job,
  op,
  onFinished,
}: {
  job: JobResponse;
  op: string;
  onFinished: () => void;
}) {
  const { detail, detailError } = useJobDetail(job.id);
  const [notified, setNotified] = useState(false);

  const live = detail ?? job;
  const running = live.status === 'running';
  const logs = (detail?.logs ?? detail?.logTail ?? '').trim();
  const liveExit = (live as Partial<JobDetail>).exitCode;

  useEffect(() => {
    if (detail && detail.status !== 'running' && !notified) {
      setNotified(true);
      onFinished();
    }
  }, [detail, notified, onFinished]);

  // Keep polling a little after finish so the final log lines land; the
  // useJobDetail interval keeps refreshing in the background.
  return (
    <div data-ref="page-images-job-detail">
      <JobNotice job={job} op={op} />
      <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)' }}>
        <Badge tone={jobTone(live.status)}>{live.status}</Badge>
        {running ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>running, refreshing…</span>
        ) : liveExit !== null && liveExit !== undefined ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>exit {liveExit}</span>
        ) : null}
      </p>
      {detailError ? (
        <p data-ref="page-images-job-detail-error" role="alert" style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }}>
          Could not load job output: {detailError}
        </p>
      ) : !detail ? (
        <Spinner label="Loading job output…" />
      ) : (
        <pre
          data-ref="page-images-job-detail-logs"
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
      <p data-ref="page-images-job-detail-status" style={{ margin: '8px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
        Status: {live.status}
        {!running ? ' — versions and state refresh automatically.' : ''}
      </p>
    </div>
  );
}

export function ImagesPage() {
  const { projects, activeId } = useProjects();
  const active = projects.find((p) => p.id === activeId) ?? null;
  const [refreshTick, setRefreshTick] = useState(0);
  // System images are global: no project is needed. The picker below is an
  // optional override (e.g. to target another namespace/registry); off by
  // default so the page works exactly like `coding-container system ...`.
  const [useProjectOverride, setUseProjectOverride] = useState(false);
  const effectiveProjectId = useProjectOverride ? (active?.id ?? null) : null;
  const sys = useSystemState(effectiveProjectId, refreshTick);
  const globalDockerfile = useGlobalDockerfile();

  const [publishTag, setPublishTag] = useState('');
  const [rollbackTag, setRollbackTag] = useState('');
  const [gcKeep, setGcKeep] = useState('');
  const [gcDryRun, setGcDryRun] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitJob(op: string, args: Record<string, unknown>, pendingLabel?: string) {
    if (useProjectOverride && !active) {
      setError('Select a project first, or turn off the project override to use the repo default.');
      return;
    }
    setPending(pendingLabel ?? op);
    setError(null);
    setJob(null);
    try {
      const created = await api.post<JobResponse>('/api/jobs', { op, projectId: effectiveProjectId, args });
      setJob(created);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setPending(null);
    }
  }

  function handlePublish(e: FormEvent) {
    e.preventDefault();
    void submitJob('system-create', buildOptionalTagArgs(publishTag));
  }

  function handleRollback(e: FormEvent) {
    e.preventDefault();
    void submitJob('system-rollback', buildOptionalTagArgs(rollbackTag));
  }

  function handleGc(preview: boolean) {
    if (useProjectOverride && !active) {
      setError('Select a project first, or turn off the project override to use the repo default.');
      return;
    }
    const parsed = preview
      ? buildSystemGcArgs(gcKeep, true, true)
      : buildSystemGcArgs(gcKeep, gcDryRun, false);
    if (parsed.error || !parsed.args) {
      setError(parsed.error ?? 'Invalid keep value.');
      setJob(null);
      return;
    }
    void submitJob('system-gc', parsed.args, preview ? 'system-gc-preview' : 'system-gc');
  }

  function handleJobFinished() {
    setRefreshTick((t) => t + 1);
  }

  // Client-side mirror of the server keep validation for an instant message.
  const gcKeepError = parseKeepInput(gcKeep).error ?? null;

  const publishActivity = pending === 'system-create' || job?.op === 'system-create';
  const rollbackActivity = pending === 'system-rollback' || job?.op === 'system-rollback';
  const cleanupActivity =
    pending === 'system-gc' || pending === 'system-gc-preview' || job?.op === 'system-gc';

  return (
    <div data-ref="page-images">
      <PageHeader title="Images" description="Shared team image versions, publishing, rollback, and cleanup." />

      <Card data-ref="page-images-card-project" style={{ marginBottom: 24 }}>
        <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
          No project needed: system images are global and use the repo default config.
        </p>
        <label style={checkboxRow}>
          <input
            data-ref="page-images-use-project-field"
            type="checkbox"
            checked={useProjectOverride}
            onChange={(e) => setUseProjectOverride(e.target.checked)}
          />
          Use selected project config (optional override)
        </label>
        {useProjectOverride ? <ProjectPicker /> : null}
        {useProjectOverride && projects.length > 0 && !active && (
          <p data-ref="page-images-alert-no-project" role="alert" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)' }}>
            Select a project to manage system images, or turn off the override to use the repo default.
          </p>
        )}
      </Card>

        <Tabs data-ref="page-images-tabs" defaultValue="versions">
          <TabsList data-ref="page-images-tabs-list" aria-label="Image management">
            <TabsTrigger data-ref="page-images-tab-versions" value="versions">Versions</TabsTrigger>
            <TabsTrigger data-ref="page-images-tab-publish" value="publish" activity={publishActivity}>Publish</TabsTrigger>
            <TabsTrigger data-ref="page-images-tab-rollback" value="rollback" activity={rollbackActivity}>Roll back</TabsTrigger>
            <TabsTrigger data-ref="page-images-tab-cleanup" value="cleanup" activity={cleanupActivity}>Cleanup</TabsTrigger>
          </TabsList>

          <TabsContent data-ref="page-images-panel-versions" value="versions" style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section key={`state-${effectiveProjectId ?? 'default'}-${refreshTick}`}>
            <h2 data-ref="page-images-heading-state" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>System state</h2>
            <StateCard
              loading={sys.loading}
              error={sys.error}
              warning={sys.warning}
              state={sys.state}
              image={sys.image}
              dockerfile={globalDockerfile}
              showDockerfile={!useProjectOverride}
            />
          </section>

          <section>
            <h2 data-ref="page-images-heading-versions" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>Versions</h2>
            <TagsSection
              projectId={effectiveProjectId}
              current={sys.state?.current ?? null}
              previous={sys.state?.previous ?? null}
              refreshTick={refreshTick}
            />
          </section>
          </div>
          </TabsContent>

          <TabsContent data-ref="page-images-panel-publish" value="publish" style={{ marginTop: 24 }}>
          <section>
            <h2 data-ref="page-images-heading-publish" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>Publish new version</h2>
            <Card data-ref="page-images-publish-card">
              <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
                Builds and tags a new shared image. Custom-mode projects are refused by the server —
                any refusal is shown below.
              </p>
              <form data-ref="page-images-form-publish" onSubmit={handlePublish}>
                <div style={{ maxWidth: 480 }}>
                  <Label htmlFor="images-publish-tag">Tag (optional)</Label>
                  <Input
                    data-ref="page-images-publish-tag-field"
                    id="images-publish-tag"
                    value={publishTag}
                    onChange={(e) => setPublishTag(e.target.value)}
                    placeholder="auto-bump when empty (e.g. v1.2.4)"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div style={{ marginTop: 12 }}>
                  <Button data-ref="page-images-submit-publish" type="submit" disabled={pending !== null || (useProjectOverride && !active)}>
                    {pending === 'system-create' ? 'Publishing…' : 'Publish new version'}
                  </Button>
                </div>
              </form>
              {job && job.op === 'system-create' ? (
                <div data-ref="page-images-publish-job">
                  <hr data-ref="page-images-publish-job-divider" style={{ margin: '16px 0', border: 'none', borderTop: '1px solid var(--border-color)' }} />
                  <JobProgress key={job.id} job={job} op={job.op} onFinished={handleJobFinished} />
                </div>
              ) : null}
            </Card>
          </section>
          </TabsContent>

          <TabsContent data-ref="page-images-panel-rollback" value="rollback" style={{ marginTop: 24 }}>
          <section>
            <h2 data-ref="page-images-heading-rollback" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>Roll back</h2>
            <Card data-ref="page-images-rollback-card">
              <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
                Rolls the shared image back to the previous version, or to the tag you name.
              </p>
              <form data-ref="page-images-form-rollback" onSubmit={handleRollback}>
                <div style={{ maxWidth: 480 }}>
                  <Label htmlFor="images-rollback-tag">Tag (optional, defaults to previous)</Label>
                  <Input
                    data-ref="page-images-rollback-tag-field"
                    id="images-rollback-tag"
                    value={rollbackTag}
                    onChange={(e) => setRollbackTag(e.target.value)}
                    placeholder="previous when empty"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div style={{ marginTop: 12 }}>
                  <Button data-ref="page-images-submit-rollback" type="submit" disabled={pending !== null || (useProjectOverride && !active)}>
                    {pending === 'system-rollback' ? 'Rolling back…' : 'Roll back'}
                  </Button>
                </div>
              </form>
              {job && job.op === 'system-rollback' ? (
                <div data-ref="page-images-rollback-job">
                  <hr data-ref="page-images-rollback-job-divider" style={{ margin: '16px 0', border: 'none', borderTop: '1px solid var(--border-color)' }} />
                  <JobProgress key={job.id} job={job} op={job.op} onFinished={handleJobFinished} />
                </div>
              ) : null}
            </Card>
          </section>
          </TabsContent>

          <TabsContent data-ref="page-images-panel-cleanup" value="cleanup" style={{ marginTop: 24 }}>
          <section>
            <h2 data-ref="page-images-heading-gc" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>System garbage collection</h2>
            <Card data-ref="page-images-gc-card">
              <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
                Removes old shared image versions beyond the keep window. Preview first with a dry
                run — keep and dry run are passed straight through to the cleanup job.
              </p>
              <form data-ref="page-images-form-gc" onSubmit={(e) => { e.preventDefault(); handleGc(false); }}>
                <div style={{ maxWidth: 480 }}>
                  <Label htmlFor="images-gc-keep">Keep (optional number of versions)</Label>
                  <Input
                    data-ref="page-images-gc-keep-field"
                    id="images-gc-keep"
                    value={gcKeep}
                    onChange={(e) => setGcKeep(e.target.value)}
                    placeholder={
                      sys.state ? `server default ${sys.state.keep} when empty` : 'server default when empty'
                    }
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </div>
                <label style={checkboxRow}>
                  <input
                    data-ref="page-images-gc-dryrun-field"
                    type="checkbox"
                    checked={gcDryRun}
                    onChange={(e) => setGcDryRun(e.target.checked)}
                  />
                  Dry run (preview only)
                </label>
                {gcKeepError ? (
                  <p data-ref="page-images-alert-gc-keep" role="alert" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)' }}>
                    {gcKeepError}
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    data-ref="page-images-submit-gc-preview"
                    type="button"
                    variant="secondary"
                    onClick={() => handleGc(true)}
                    disabled={pending !== null || (useProjectOverride && !active)}
                  >
                    {pending === 'system-gc-preview' ? 'Running…' : 'Preview (dry run)'}
                  </Button>
                  <Button data-ref="page-images-submit-gc" type="submit" disabled={pending !== null || (useProjectOverride && !active)}>
                    {pending === 'system-gc' ? 'Running…' : 'Run GC'}
                  </Button>
                </div>
              </form>
              {job && job.op === 'system-gc' ? (
                <div data-ref="page-images-gc-job">
                  <hr data-ref="page-images-gc-job-divider" style={{ margin: '16px 0', border: 'none', borderTop: '1px solid var(--border-color)' }} />
                  <JobProgress key={job.id} job={job} op={job.op} onFinished={handleJobFinished} />
                </div>
              ) : null}
            </Card>
          </section>
          </TabsContent>
        </Tabs>
          {error ? (
            <p data-ref="page-images-error" role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)' }}>
              {error}
            </p>
          ) : null}
    </div>
  );
}
