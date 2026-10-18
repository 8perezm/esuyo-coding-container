import { Suspense, lazy, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Save, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import type { Project } from '../lib/projects';
import { Button, Card, ConfirmDialog, Input, Label, PageHeader, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui';
import { useValidation } from '../components/ValidatePanel';
import { ProjectDeployTab } from '../components/ProjectDeployTab';

const YamlEditor = lazy(() =>
  import('../components/YamlEditor').then((m) => ({ default: m.YamlEditor })),
);

const ValidateActions = lazy(() =>
  import('../components/ValidatePanel').then((m) => ({ default: m.ValidateActions })),
);

const ValidationResults = lazy(() =>
  import('../components/ValidatePanel').then((m) => ({ default: m.ValidationResults })),
);

interface ConfigResponse {
  merged?: unknown;
  rawYaml?: string;
  configPath?: string;
}

interface ConfigMerged {
  image?: { registry?: string; name?: string; tag?: string };
  k8s?: { namespace?: string; nodePort?: number };
}

interface WorkloadEntry {
  projectId?: string | null;
  deployed: boolean;
  image?: string | null;
}

interface WorkloadsResponse {
  ok: boolean;
  workloads?: WorkloadEntry[];
}

function asMerged(value: unknown): ConfigMerged | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as ConfigMerged;
}

interface StarterResponse {
  yaml: string;
  slug: string;
  mainNodePort: number;
  dbNodePort: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function ProjectEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { projects, refresh, loading: projectsLoading } = useProjects();

  const [project, setProject] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [yaml, setYaml] = useState('');
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [configMissing, setConfigMissing] = useState(false);
  const [merged, setMerged] = useState<ConfigMerged | null>(null);
  const [workloadImage, setWorkloadImage] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsOk, setSettingsOk] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configOk, setConfigOk] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [starterPending, setStarterPending] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const validation = useValidation(project?.id ?? null);

  useEffect(() => {
    if (projectsLoading) return;
    if (!id) {
      setLoadError('Missing project id in URL.');
      setLoading(false);
      return;
    }
    const found = projects.find((p) => p.id === id) ?? null;
    setProject(found);
    if (!found) {
      setLoadError('Project not found.');
      setLoading(false);
      return;
    }
    setName(found.name);
    setConfigPath(found.configPath);
    setLoading(false);
  }, [id, projects, projectsLoading]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setConfigError(null);
    setConfigOk(null);
    setConfigMissing(false);
    setMerged(null);
    setWorkloadImage(null);
    api
      .get<ConfigResponse>(`/api/config?projectId=${encodeURIComponent(project.id)}`)
      .then((data) => {
        if (cancelled) return;
        setYaml(data.rawYaml ?? '');
        setResolvedPath(data.configPath ?? project.configPath);
        setMerged(asMerged(data.merged));
      })
      .catch((err) => {
        if (cancelled) return;
        // No file yet is the expected empty state (not an error): the
        // "saving below will create it" note already covers it.
        const msg = errMsg(err);
        setYaml('');
        setResolvedPath(project.configPath);
        setMerged(null);
        setConfigMissing(true);
        if (!/config file not found|cannot read config file|ENOENT|no such file/i.test(msg)) {
          setConfigError(`Could not load config (${msg}).`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cluster-resolved image (registry/name:tag) for this project, preferred
  // over the saved config below — saved configs often leave the tag floating
  // on the cluster.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    api
      .get<WorkloadsResponse>('/api/cluster/workloads')
      .then((data) => {
        if (cancelled) return;
        const entry = (data.workloads ?? []).find((w) => w.projectId === project.id) ?? null;
        setWorkloadImage(entry?.image ?? null);
      })
      .catch(() => {
        if (!cancelled) setWorkloadImage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setSettingsError(null);
    setSettingsOk(null);
    const trimmedName = name.trim();
    const trimmedPath = configPath.trim();
    if (!trimmedName || !trimmedPath) {
      setSettingsError('Name and config path are both required.');
      return;
    }
    setSavingSettings(true);
    try {
      const res = await api.put<{ project: Project }>(
        `/api/projects/${encodeURIComponent(project.id)}`,
        { name: trimmedName, configPath: trimmedPath },
      );
      setProject(res.project);
      setName(res.project.name);
      setConfigPath(res.project.configPath);
      setResolvedPath(res.project.configPath);
      setSettingsOk('Project settings saved.');
      await refresh();
    } catch (err) {
      setSettingsError(errMsg(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const onSaveConfig = async () => {
    if (!project) return;
    setConfigError(null);
    setConfigOk(null);
    if (!yaml.trim()) {
      setConfigError('Config content is required.');
      return;
    }
    setSavingConfig(true);
    try {
      const res = await api.put<{ ok: boolean; configPath?: string }>('/api/config', {
        projectId: project.id,
        yaml,
      });
      setConfigMissing(false);
      if (res.configPath) setResolvedPath(res.configPath);
      navigate('/projects');
    } catch (err) {
      setConfigError(errMsg(err));
    } finally {
      setSavingConfig(false);
    }
  };

  const fetchStarter = async () => {
    if (!project) throw new Error('Missing project');
    return api.get<StarterResponse>(`/api/project-starter?projectId=${encodeURIComponent(project.id)}`);
  };

  const onFillStarter = async () => {
    if (!project || starterPending) return;
    if (yaml.trim() && !window.confirm('Replace the editor content with the starter example? Unsaved changes will be lost.')) {
      return;
    }
    setConfigError(null);
    setConfigOk(null);
    setStarterPending(true);
    try {
      const starter = await fetchStarter();
      setYaml(starter.yaml);
      setConfigMissing(false);
      setConfigOk('Starter example loaded — review hosts and passwords, then Save config file.');
    } catch (err) {
      setConfigError(errMsg(err));
    } finally {
      setStarterPending(false);
    }
  };

  const onDownloadStarter = async () => {
    if (!project || starterPending) return;
    setConfigError(null);
    setStarterPending(true);
    try {
      const starter = await fetchStarter();
      const blob = new Blob([starter.yaml], { type: 'text/yaml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${starter.slug || project.name}-config.yaml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setConfigError(errMsg(err));
    } finally {
      setStarterPending(false);
    }
  };

  if (loading || projectsLoading) return <Spinner label="Loading project…" />;
  if (loadError || !project) {
    return (
      <div data-ref="page-project-edit">
        <PageHeader
          title="Edit project"
          description="Change project settings and config file."
          actions={
            <Link to="/projects" className="btn btn-secondary" data-ref="page-project-edit-back">
              Back to projects
            </Link>
          }
        />
        <Card data-ref="page-project-edit-load-error-card">
          <p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }} data-ref="page-project-edit-load-error">
            {loadError ?? 'Project not found.'}
          </p>
        </Card>
      </div>
    );
  }

  async function onConfirmRemove() {
    if (!project) return;
    setRemoveError(null);
    setRemoving(true);
    try {
      await api.del<{ ok: boolean }>(`/api/projects/${encodeURIComponent(project.id)}`);
      await refresh();
      navigate('/projects');
    } catch (err) {
      setRemoveError(errMsg(err));
    } finally {
      setRemoving(false);
      setShowRemoveConfirm(false);
    }
  }

  const configImage = merged
    ? `${[merged.image?.registry, merged.image?.name].filter(Boolean).join('/') || '—'}${merged.image?.tag ? `:${merged.image.tag}` : ''}`
    : '…';
  // Prefer the cluster-resolved image: saved configs often leave the tag
  // floating on the cluster.
  const imageDisplay = workloadImage ?? configImage;

  return (
    <div data-ref="page-project-edit">
      <PageHeader
        title={project.name}
        description="Change the name, config path, or config file content."
        actions={
          <>
            <Link to="/projects" className="btn btn-secondary" data-ref="page-project-edit-back">
              Back to projects
            </Link>
            <Link
              to={`/projects/${encodeURIComponent(project.id)}/ssh`}
              className="btn btn-secondary"
              data-ref="page-project-edit-terminal"
              aria-label={`Open terminal for ${project.name}`}
            >
              Terminal
            </Link>
            <Button variant="secondary" onClick={() => navigate('/projects')} data-ref="page-project-edit-done">
              Done
            </Button>
            <Button variant="secondary" onClick={() => setShowRemoveConfirm(true)} data-ref="page-project-edit-remove">
              <Trash2 size={16} aria-hidden="true" /> Remove
            </Button>
          </>
        }
      />
      {removeError && (
        <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)', marginTop: 0 }} data-ref="page-project-edit-remove-error">
          {removeError}
        </p>
      )}
      {showRemoveConfirm && (
        <ConfirmDialog
          title={`Remove "${project.name}"?`}
          confirmLabel="Remove entry"
          onCancel={() => setShowRemoveConfirm(false)}
          onConfirm={() => void onConfirmRemove()}
          confirming={removing}
        >
          <p style={{ margin: 0 }}>
            This only removes the registry entry for <strong>{project.name}</strong> — cluster
            workloads are left untouched. To tear those down, use Delete on the Projects page instead.
          </p>
        </ConfirmDialog>
      )}

      <Tabs data-ref="page-project-edit-tabs" defaultValue="config">
        <TabsList data-ref="page-project-edit-tabs-list" aria-label="Project sections" className="tabs-list-line">
          <TabsTrigger data-ref="page-project-edit-tab-settings" value="settings" className="tabs-trigger-line">Settings</TabsTrigger>
          <TabsTrigger data-ref="page-project-edit-tab-config" value="config" className="tabs-trigger-line">Configuration</TabsTrigger>
          <TabsTrigger data-ref="page-project-edit-tab-deploy" value="deploy" className="tabs-trigger-line">Deploy</TabsTrigger>
        </TabsList>

        <TabsContent data-ref="page-project-edit-panel-settings" value="settings" style={{ marginTop: 24 }}>
          <Card data-ref="page-project-edit-settings-card">
            <h2 style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 12px' }} data-ref="page-project-edit-settings-heading">Project settings</h2>
            {settingsError && (
              <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)', marginTop: 0 }} data-ref="page-project-edit-settings-error">
                {settingsError}
              </p>
            )}
            {settingsOk && (
              <p role="status" style={{ color: 'var(--color-success, #1a7f37)', fontSize: 'var(--font-size-md)', marginTop: 0 }} data-ref="page-project-edit-settings-ok">
                {settingsOk}
              </p>
            )}
            <form onSubmit={(e) => void onSaveSettings(e)} style={{ display: 'grid', gap: 12 }} data-ref="page-project-edit-settings-form">
              <div>
                <Label htmlFor="edit-project-name">Name</Label>
                <Input
                  id="edit-project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  style={{ width: '100%' }}
                  data-ref="page-project-edit-input-name"
                />
              </div>
              <div>
                <Label htmlFor="edit-project-config-path">Config path</Label>
                <Input
                  id="edit-project-config-path"
                  value={configPath}
                  onChange={(e) => setConfigPath(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ width: '100%' }}
                  data-ref="page-project-edit-input-config-path"
                />
                <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="page-project-edit-config-path-hint">
                  Renaming moves the file when it lives in the managed system folder. Custom paths stay put.
                </p>
              </div>
              <div data-ref="page-project-edit-image-wrap">
                <span style={{ display: 'block', fontSize: 'var(--font-size-md)', fontWeight: 600, marginBottom: 4 }}>Image</span>
                <code data-ref="page-project-edit-image" style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-sm)', overflowWrap: 'anywhere' }}>
                  {imageDisplay}
                </code>
              </div>
              <div>
                <Button type="submit" disabled={savingSettings} data-ref="page-project-edit-settings-save">
                  <Save size={16} aria-hidden="true" /> {savingSettings ? 'Saving…' : 'Save settings'}
                </Button>
              </div>
            </form>
          </Card>
        </TabsContent>

        <TabsContent data-ref="page-project-edit-panel-config" value="config" style={{ marginTop: 24 }}>
          <Card data-ref="page-project-edit-config-card">
            <h2 style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 8px' }} data-ref="page-project-edit-config-heading">Config file</h2>
            <p style={{ margin: '0 0 4px', fontSize: 'var(--font-size-md)' }} data-ref="page-project-edit-config-path">
              Stored on disk at:{' '}
              <code style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-sm)', overflowWrap: 'anywhere' }}>
                {resolvedPath ?? project.configPath}
              </code>
            </p>
            <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="page-project-edit-config-hint">
              You can also edit this file directly on the server. Keep a backup copy somewhere safe before
              making changes.
            </p>
            {configMissing && (
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="page-project-edit-config-missing">
                No config file exists at this path yet — saving below will create it (including parent
                directories).
              </p>
            )}
            {configError && (
              <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)' }} data-ref="page-project-edit-config-error">
                {configError}
              </p>
            )}
            {configOk && (
              <p role="status" style={{ color: 'var(--color-success, #1a7f37)', fontSize: 'var(--font-size-md)' }} data-ref="page-project-edit-config-ok">
                {configOk}
              </p>
            )}
            <div style={{ display: 'grid', gap: 12 }} data-ref="page-project-edit-config-form">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }} data-ref="page-project-edit-starter-actions">
                <Button variant="secondary" onClick={() => void onFillStarter()} disabled={starterPending} data-ref="page-project-edit-config-fill">
                  {starterPending ? 'Loading…' : 'Fill with example'}
                </Button>
                <Button variant="secondary" onClick={() => void onDownloadStarter()} disabled={starterPending} data-ref="page-project-edit-config-download">
                  Download example
                </Button>
              </div>
              <div>
                <Label htmlFor="edit-project-yaml">Config (YAML)</Label>
                <Suspense fallback={<Spinner label="Loading editor…" />}>
                  <YamlEditor id="edit-project-yaml" value={yaml} onChange={setYaml} height="480px" />
                </Suspense>
              </div>
              <div style={{ marginTop: 12 }}>
                <Suspense fallback={<Spinner label="Loading validator…" />}>
                  <ValidateActions
                    validation={validation}
                    draft={{ yaml }}
                    saveButton={
                      <Button onClick={() => void onSaveConfig()} disabled={savingConfig} data-ref="page-project-edit-config-save">
                        <Save size={16} aria-hidden="true" /> {savingConfig ? 'Saving…' : 'Save config file'}
                      </Button>
                    }
                  />
                </Suspense>
              </div>
            </div>
          </Card>

          <section data-ref="page-project-edit-validate-section" style={{ marginTop: 24 }}>
            <Suspense fallback={<Spinner label="Loading validator…" />}>
              <ValidationResults validation={validation} />
            </Suspense>
          </section>
        </TabsContent>

        <TabsContent data-ref="page-project-edit-panel-deploy" value="deploy" style={{ marginTop: 24 }}>
          <ProjectDeployTab project={project} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
