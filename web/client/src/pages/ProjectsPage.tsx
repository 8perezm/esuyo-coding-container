import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Plus, Rocket, Trash2, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import type { Project } from '../lib/projects';
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

interface CreateProjectResponse {
  project: Project;
}

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

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function ProjectsPage() {
  const { projects, activeId, setActiveId, refresh, loading, error } = useProjects();
  const [name, setName] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const active = projects.find((p) => p.id === activeId) ?? null;

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [jobNotice, setJobNotice] = useState<JobResponse | null>(null);
  const [jobPending, setJobPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setConfigError(null);
    setJobNotice(null);
    if (!active) return;
    setConfigLoading(true);
    api
      .get<ConfigResponse>(`/api/config?projectId=${encodeURIComponent(active.id)}`)
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch((err) => {
        if (!cancelled) setConfigError(errMsg(err));
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onCreate = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setFormError(null);
      const trimmedName = name.trim();
      const trimmedPath = configPath.trim();
      if (!trimmedName || !trimmedPath) {
        setFormError('Name and config path are both required.');
        return;
      }
      setCreating(true);
      try {
        const res = await api.post<CreateProjectResponse>('/api/projects', {
          name: trimmedName,
          configPath: trimmedPath,
        });
        setName('');
        setConfigPath('');
        setActiveId(res.project.id);
        await refresh();
      } catch (err) {
        setFormError(errMsg(err));
      } finally {
        setCreating(false);
      }
    },
    [name, configPath, refresh, setActiveId],
  );

  const onDelete = useCallback(
    async (project: Project) => {
      if (!window.confirm(`Delete project "${project.name}"? This only removes the registry entry.`)) return;
      setActionError(null);
      setDeletingId(project.id);
      try {
        await api.del<{ ok: boolean }>(`/api/projects/${encodeURIComponent(project.id)}`);
        if (activeId === project.id) setActiveId(null);
        await refresh();
      } catch (err) {
        setActionError(errMsg(err));
      } finally {
        setDeletingId(null);
      }
    },
    [activeId, refresh, setActiveId],
  );

  const startJob = useCallback(
    async (op: 'create' | 'deploy' | 'delete', args: Record<string, unknown> = {}) => {
      if (!active) return;
      setActionError(null);
      setJobNotice(null);
      setJobPending(op);
      try {
        const job = await api.post<JobResponse>('/api/jobs', { op, projectId: active.id, args });
        setJobNotice(job);
      } catch (err) {
        setActionError(errMsg(err));
      } finally {
        setJobPending(null);
      }
    },
    [active],
  );

  const image = config?.merged.image;
  const k8s = config?.merged.k8s;
  const mode = config?.imageMode ?? config?.merged.imageMode;

  return (
    <div>
      <PageHeader title="Projects" description="Per-project containers, workspaces, and lifecycle actions." />

      {loading ? (
        <Spinner label="Loading projects…" />
      ) : error ? (
        <Card>
          <p role="alert" style={{ margin: 0, fontSize: 14 }}>
            Could not load projects: {error}{' '}
            <Button variant="secondary" onClick={() => void refresh()} style={{ marginLeft: 8 }}>
              Retry
            </Button>
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Add your first project with the form below — point it at a config file on the server."
        />
      ) : (
        <TableContainer>
          <Table aria-label="Projects">
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Config path</TH>
                <TH>Actions</TH>
              </TR>
            </THead>
            <TBody>
              {projects.map((p) => {
                const isActive = p.id === activeId;
                return (
                  <TR key={p.id}>
                    <TD>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {p.name} {isActive && <Badge tone="accent">Active</Badge>}
                      </span>
                    </TD>
                    <TD style={{ fontFamily: 'monospace', fontSize: 13 }}>{p.configPath}</TD>
                    <TD>
                      <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                        {!isActive && (
                          <Button variant="secondary" onClick={() => setActiveId(p.id)}>
                            <CheckCircle2 size={16} aria-hidden="true" /> Select active
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          onClick={() => void onDelete(p)}
                          disabled={deletingId === p.id}
                          aria-label={`Delete project ${p.name}`}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                          {deletingId === p.id ? 'Deleting…' : 'Delete'}
                        </Button>
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableContainer>
      )}

      {actionError && (
        <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 14, marginTop: 12 }}>
          {actionError}
        </p>
      )}

      <Card style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Add project</h2>
        <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>
          The config path must already exist on the server.
        </p>
        {formError && (
          <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 14, marginTop: 0 }}>
            {formError}
          </p>
        )}
        <form onSubmit={(e) => void onCreate(e)} style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <div>
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="project-config-path">Config path</Label>
            <Input
              id="project-config-path"
              value={configPath}
              onChange={(e) => setConfigPath(e.target.value)}
              placeholder="/data/projects/my-project/config.yaml"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <Button type="submit" disabled={creating}>
              <Plus size={16} aria-hidden="true" /> {creating ? 'Adding…' : 'Add project'}
            </Button>
          </div>
        </form>
      </Card>

      {active && (
        <Card style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, margin: '0 0 12px' }}>Active project: {active.name}</h2>
          {configLoading ? (
            <Spinner label="Loading config…" />
          ) : configError ? (
            <p role="alert" style={{ margin: 0, fontSize: 14 }}>
              Could not load config: {configError}
            </p>
          ) : config ? (
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '8px 24px',
                margin: '0 0 16px',
                fontSize: 14,
              }}
            >
              <div>
                <dt style={{ color: 'var(--text-muted)' }}>Mode</dt>
                <dd style={{ margin: 0 }}>
                  <Badge tone={mode === 'global' ? 'violet' : 'default'}>{mode ?? '—'}</Badge>
                </dd>
              </div>
              <div>
                <dt style={{ color: 'var(--text-muted)' }}>Image</dt>
                <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: 13 }}>
                  {[image?.registry, image?.name].filter(Boolean).join('/') || '—'}
                  {image?.tag ? `:${image.tag}` : ''}
                </dd>
              </div>
              <div>
                <dt style={{ color: 'var(--text-muted)' }}>Namespace</dt>
                <dd style={{ margin: 0 }}>{k8s?.namespace ?? '—'}</dd>
              </div>
              <div>
                <dt style={{ color: 'var(--text-muted)' }}>NodePort</dt>
                <dd style={{ margin: 0 }}>{k8s?.nodePort ?? '—'}</dd>
              </div>
            </dl>
          ) : null}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => void startJob('create')} disabled={jobPending !== null}>
              <Wrench size={16} aria-hidden="true" />{' '}
              {jobPending === 'create' ? 'Starting…' : 'Create'}
            </Button>
            <Button onClick={() => void startJob('deploy')} disabled={jobPending !== null}>
              <Rocket size={16} aria-hidden="true" /> {jobPending === 'deploy' ? 'Starting…' : 'Deploy'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (window.confirm(`Delete workloads for "${active.name}"?`)) void startJob('delete');
              }}
              disabled={jobPending !== null}
            >
              <Trash2 size={16} aria-hidden="true" /> {jobPending === 'delete' ? 'Starting…' : 'Delete'}
            </Button>
          </div>

          {jobNotice && (
            <p style={{ margin: '12px 0 0', fontSize: 14 }}>
              Job started: <code>{jobNotice.id}</code> ({jobNotice.status}) —{' '}
              <Link to="/jobs">View jobs</Link>
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
