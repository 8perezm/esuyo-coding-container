import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import { buildSystemInitArgs } from '../lib/systemJobs';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  Spinner,
} from '../components/ui';

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

function GlobalConfigCard() {
  const [path, setPath] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [yaml, setYaml] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  async function handleSave(e: FormEvent) {
    e.preventDefault();
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
    <section>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Global configuration</h2>
      {loading ? (
        <Card>
          <Spinner label="Loading global config…" />
        </Card>
      ) : loadError ? (
        <Card>
          <p role="alert" style={{ margin: 0, fontSize: 14 }}>
            Could not load global config: {loadError}
          </p>
        </Card>
      ) : (
        <Card>
          <p style={{ margin: '0 0 8px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            {exists ? <Badge tone="accent">exists</Badge> : <Badge>missing</Badge>}
            {path ? <code style={{ ...monoStyle, fontSize: 13, wordBreak: 'break-all' }}>{path}</code> : null}
          </p>
          <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
            Warning: the shared registry and NFS settings live here. Editing them affects every
            project.
          </p>
          <form onSubmit={(e) => void handleSave(e)}>
            <Label htmlFor="system-global-yaml">global.yaml</Label>
            <textarea
              id="system-global-yaml"
              className="input"
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              placeholder="# global.yaml — registry, NFS, defaults"
              spellCheck={false}
              style={{ ...monoStyle, minHeight: 300, overflow: 'auto', resize: 'vertical' }}
            />
            <div style={{ marginTop: 12 }}>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save global config'}
              </Button>
            </div>
          </form>
          {saveNotice ? (
            <p style={{ margin: '12px 0 0', fontSize: 14 }}>{saveNotice}</p>
          ) : null}
          {saveError ? (
            <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
              Save failed: {saveError}
            </p>
          ) : null}
        </Card>
      )}
    </section>
  );
}

function StateSummary({ projectId }: { projectId: string | null }) {
  const [line, setLine] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setLine(null);
    setWarning(null);
    setError(null);
    api
      .get<StateResponse>(`/api/system/state?projectId=${encodeURIComponent(projectId)}`)
      .then((data) => {
        if (cancelled) return;
        if (data.ok && data.state) {
          setLine(
            `current ${data.state.current} · previous ${data.state.previous ?? '—'} · max ever ${data.state.maxEver} · keep ${data.state.keep}`,
          );
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
    <section>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>State summary</h2>
      <Card>
        {loading ? (
          <Spinner label="Loading state…" />
        ) : error ? (
          <p role="alert" style={{ margin: 0, fontSize: 14 }}>
            Could not load system state: {error}
          </p>
        ) : warning ? (
          <p style={{ margin: 0, fontSize: 14 }}>
            {warning} Run system init below, or see <Link to="/images">Images</Link>.
          </p>
        ) : line ? (
          <p style={{ margin: 0, fontSize: 14 }}>{line}</p>
        ) : (
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
            Select a project to view system state.
          </p>
        )}
      </Card>
    </section>
  );
}

export function SystemPage() {
  const { projects, activeId } = useProjects();
  const active = projects.find((p) => p.id === activeId) ?? null;

  const [initTag, setInitTag] = useState('');
  const [initKeep, setInitKeep] = useState('10');
  const [pending, setPending] = useState(false);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleInit(e: FormEvent) {
    e.preventDefault();
    if (!active) {
      setError('Select a project first.');
      return;
    }
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
      .post<JobResponse>('/api/jobs', { op: 'system-init', projectId: active.id, args: parsed.args })
      .then((created) => setJob(created))
      .catch((err) => setError(errMsg(err)))
      .finally(() => setPending(false));
  }

  return (
    <div>
      <PageHeader title="System" description="Cluster health, versions, and global configuration." />

      <Card style={{ marginBottom: 24 }}>
        <ProjectPicker />
        <p style={{ margin: '12px 0 0', fontSize: 14, color: 'var(--text-muted)' }}>
          System jobs need a global-mode project. Custom-mode projects are refused by the server —
          any refusal is shown below.
        </p>
        {projects.length > 0 && !active && (
          <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
            Select a project to run system init.
          </p>
        )}
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <GlobalConfigCard />

        <section key={`state-${active?.id ?? 'none'}`}>
          <StateSummary projectId={active?.id ?? null} />
        </section>

        <section>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>System init</h2>
          <Card>
            <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
              Creates the first system version and state ConfigMap. Run once per cluster, then
              publish new versions from the Images page.
            </p>
            <form onSubmit={handleInit}>
              <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
                <div>
                  <Label htmlFor="system-init-tag">Tag (required)</Label>
                  <Input
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
                <Button type="submit" disabled={pending || !active}>
                  {pending ? 'Starting…' : 'Initialize system'}
                </Button>
              </div>
            </form>
            {job ? (
              <p style={{ margin: '12px 0 0', fontSize: 14 }}>
                {job.op} started: <code>{job.id}</code> ({job.status}) —{' '}
                <Link to="/jobs">View jobs</Link>
              </p>
            ) : null}
            {error ? (
              <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
                system-init failed: {error}
              </p>
            ) : null}
          </Card>
        </section>
      </div>
    </div>
  );
}
