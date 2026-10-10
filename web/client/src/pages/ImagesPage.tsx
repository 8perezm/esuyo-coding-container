import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import {
  buildOptionalTagArgs,
  buildSystemGcArgs,
  parseKeepInput,
} from '../lib/systemJobs';
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
  fontSize: 14,
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

function useSystemState(projectId: string | null) {
  const [state, setState] = useState<SystemState | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setState(null);
    setImage(null);
    setWarning(null);
    setError(null);
    api
      .get<StateResponse>(`/api/system/state?projectId=${encodeURIComponent(projectId)}`)
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
  }, [projectId]);

  return { state, image, warning, error, loading };
}

function StateCard({
  loading,
  error,
  warning,
  state,
  image,
}: {
  loading: boolean;
  error: string | null;
  warning: string | null;
  state: SystemState | null;
  image: string | null;
}) {
  if (loading) {
    return (
      <Card>
        <Spinner label="Loading system state…" />
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <p role="alert" style={{ margin: 0, fontSize: 14 }}>
          Could not load system state: {error}
        </p>
      </Card>
    );
  }
  if (!state) {
    return (
      <Card>
        <p style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>System is not initialized.</p>
        {warning ? (
          <p style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--text-muted)' }}>{warning}</p>
        ) : null}
        <p style={{ margin: 0, fontSize: 14 }}>
          Run system init from the <Link to="/system">System page</Link> to create the first version.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px 24px' }}>
        <div>
          <dt style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Current</dt>
          <dd style={{ margin: '4px 0 0' }}>
            <Badge tone="accent">{state.current}</Badge>
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Previous</dt>
          <dd style={{ margin: '4px 0 0', fontSize: 14 }}>{state.previous ?? '—'}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Max ever</dt>
          <dd style={{ margin: '4px 0 0', fontSize: 14 }}>{state.maxEver}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Keep</dt>
          <dd style={{ margin: '4px 0 0', fontSize: 14 }}>{state.keep}</dd>
        </div>
      </dl>
      {image ? (
        <p style={{ margin: '12px 0 0', fontSize: 13, wordBreak: 'break-all' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Resolved image: </span>
          <code style={monoStyle}>{image}</code>
        </p>
      ) : null}
    </Card>
  );
}

function TagsSection({
  projectId,
  current,
  previous,
}: {
  projectId: string;
  current: string | null;
  previous: string | null;
}) {
  const [tags, setTags] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTags(null);
    setError(null);
    api
      .get<TagsResponse>(`/api/system/tags?projectId=${encodeURIComponent(projectId)}`)
      .then((data) => {
        if (cancelled) return;
        setTags(data.tags ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errMsg(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) {
    return (
      <Card>
        <p role="alert" style={{ margin: 0, fontSize: 14 }}>
          Could not load tags: {error}
        </p>
      </Card>
    );
  }
  if (tags === null) {
    return (
      <Card>
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
  return (
    <TableContainer>
      <Table>
        <THead>
          <TR>
            <TH>Tag</TH>
            <TH>Status</TH>
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
  );
}

function JobNotice({ job, op }: { job: JobResponse | null; op: string }) {
  if (!job) return null;
  return (
    <p style={{ margin: '12px 0 0', fontSize: 14 }}>
      {op} started: <code>{job.id}</code> ({job.status}) — <Link to="/jobs">View jobs</Link>
    </p>
  );
}

export function ImagesPage() {
  const { projects, activeId } = useProjects();
  const active = projects.find((p) => p.id === activeId) ?? null;
  const sys = useSystemState(active?.id ?? null);

  const [publishTag, setPublishTag] = useState('');
  const [rollbackTag, setRollbackTag] = useState('');
  const [gcKeep, setGcKeep] = useState('');
  const [gcDryRun, setGcDryRun] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitJob(op: string, args: Record<string, unknown>) {
    if (!active) {
      setError('Select a project first.');
      return;
    }
    setPending(op);
    setError(null);
    setJob(null);
    try {
      const created = await api.post<JobResponse>('/api/jobs', { op, projectId: active.id, args });
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
    if (!active) {
      setError('Select a project first.');
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
    void submitJob('system-gc', parsed.args);
  }

  // Client-side mirror of the server keep validation for an instant message.
  const gcKeepError = parseKeepInput(gcKeep).error ?? null;

  return (
    <div>
      <PageHeader title="Images" description="Shared team image versions, publishing, and rollback." />

      <Card style={{ marginBottom: 24 }}>
        <ProjectPicker />
        {projects.length > 0 && !active && (
          <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
            Select a project to manage system images.
          </p>
        )}
      </Card>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Add a project first, then come back to manage images."
          action={<Link to="/projects">Go to Projects</Link>}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section key={`state-${active?.id ?? 'none'}`}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>System state</h2>
            <StateCard
              loading={sys.loading}
              error={sys.error}
              warning={sys.warning}
              state={sys.state}
              image={sys.image}
            />
          </section>

          {active ? (
            <section>
              <h2 style={{ fontSize: 18, marginBottom: 12 }}>Versions</h2>
              <TagsSection
                projectId={active.id}
                current={sys.state?.current ?? null}
                previous={sys.state?.previous ?? null}
              />
            </section>
          ) : null}

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Publish new version</h2>
            <Card>
              <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
                Builds and tags a new shared image. Custom-mode projects are refused by the server —
                any refusal is shown below.
              </p>
              <form onSubmit={handlePublish}>
                <div style={{ maxWidth: 480 }}>
                  <Label htmlFor="images-publish-tag">Tag (optional)</Label>
                  <Input
                    id="images-publish-tag"
                    value={publishTag}
                    onChange={(e) => setPublishTag(e.target.value)}
                    placeholder="auto-bump when empty (e.g. v1.2.4)"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div style={{ marginTop: 12 }}>
                  <Button type="submit" disabled={pending !== null || !active}>
                    {pending === 'system-create' ? 'Publishing…' : 'Publish new version'}
                  </Button>
                </div>
              </form>
            </Card>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Roll back</h2>
            <Card>
              <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
                Rolls the shared image back to the previous version, or to the tag you name.
              </p>
              <form onSubmit={handleRollback}>
                <div style={{ maxWidth: 480 }}>
                  <Label htmlFor="images-rollback-tag">Tag (optional, defaults to previous)</Label>
                  <Input
                    id="images-rollback-tag"
                    value={rollbackTag}
                    onChange={(e) => setRollbackTag(e.target.value)}
                    placeholder="previous when empty"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div style={{ marginTop: 12 }}>
                  <Button type="submit" disabled={pending !== null || !active}>
                    {pending === 'system-rollback' ? 'Rolling back…' : 'Roll back'}
                  </Button>
                </div>
              </form>
            </Card>
          </section>

          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>System garbage collection</h2>
            <Card>
              <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
                Removes old shared image versions beyond the keep window. Preview first with a dry
                run — flags map 1:1 to CLI args (--keep, --dry-run).
              </p>
              <form onSubmit={(e) => { e.preventDefault(); handleGc(false); }}>
                <div style={{ maxWidth: 480 }}>
                  <Label htmlFor="images-gc-keep">Keep (optional number of versions)</Label>
                  <Input
                    id="images-gc-keep"
                    value={gcKeep}
                    onChange={(e) => setGcKeep(e.target.value)}
                    placeholder="server default when empty"
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </div>
                <label style={checkboxRow}>
                  <input
                    type="checkbox"
                    checked={gcDryRun}
                    onChange={(e) => setGcDryRun(e.target.checked)}
                  />
                  Dry run (preview only)
                </label>
                {gcKeepError ? (
                  <p role="alert" style={{ margin: '0 0 12px', fontSize: 14 }}>
                    {gcKeepError}
                  </p>
                ) : null}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => handleGc(true)}
                    disabled={pending !== null || !active}
                  >
                    {pending === 'system-gc-preview' ? 'Running…' : 'Preview (dry run)'}
                  </Button>
                  <Button type="submit" disabled={pending !== null || !active}>
                    {pending === 'system-gc' ? 'Running…' : 'Run GC'}
                  </Button>
                </div>
              </form>
            </Card>
          </section>

          {job ? (
            <Card>
              <JobNotice job={job} op={job.op} />
            </Card>
          ) : null}
          {error ? (
            <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 14 }}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
