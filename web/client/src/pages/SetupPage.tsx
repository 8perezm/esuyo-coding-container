import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { api } from '../lib/api';
import {
  buildSetupArgs,
  extractGlobalSetupValues,
  isValidNamespaceName,
  mergeSetupPrefill,
} from './job-helpers';
import type { ClusterNamespaceEntry } from './job-helpers';
import { JobOutput } from '../components/JobOutput';
import { Badge, Button, Card, Input, Label, PageHeader, Spinner } from '../components/ui';

interface GlobalConfigResponse {
  exists: boolean;
  path: string;
  rawYaml: string | null;
}

interface NamespacesResponse {
  ok: boolean;
  namespaces?: ClusterNamespaceEntry[];
  error?: string;
}

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

type NamespaceMode = 'existing' | 'new';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function SetupPage() {
  const [config, setConfig] = useState<GlobalConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [registry, setRegistry] = useState('');
  const [nfsServer, setNfsServer] = useState('');
  const [nfsBasePath, setNfsBasePath] = useState('');
  const [namespaces, setNamespaces] = useState<ClusterNamespaceEntry[] | null>(null);
  const [namespacesAvailable, setNamespacesAvailable] = useState(false);
  const [mode, setMode] = useState<NamespaceMode>('new');
  const [selectedName, setSelectedName] = useState('');
  const [newNamespace, setNewNamespace] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const typedRef = useRef(false);
  const prefilledRef = useRef(false);

  const markTyped = useCallback(() => {
    typedRef.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<GlobalConfigResponse>('/api/global-config')
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch((err) => {
        if (!cancelled) setConfigError(errMsg(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<NamespacesResponse>('/api/cluster/namespaces')
      .then((data) => {
        if (cancelled) return;
        if (data.ok && Array.isArray(data.namespaces)) {
          setNamespaces(data.namespaces);
          setNamespacesAvailable(true);
        } else {
          setNamespaces([]);
          setNamespacesAvailable(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNamespaces([]);
          setNamespacesAvailable(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const globalFallback = useMemo(
    () => extractGlobalSetupValues(config?.rawYaml ?? null),
    [config],
  );

  // Initial prefill: once the namespace list arrives, pick the first entry
  // and fill the form from its stored values (global config fills the gaps).
  // Runs only before the user types anything, so typed edits are never lost.
  useEffect(() => {
    if (prefilledRef.current || typedRef.current || !namespacesAvailable) return;
    if (!namespaces || namespaces.length === 0) return;
    prefilledRef.current = true;
    const first = namespaces[0];
    const merged = mergeSetupPrefill(first.setupValues, globalFallback);
    setMode('existing');
    setSelectedName(first.name);
    setRegistry(merged.registry);
    setNfsServer(merged.nfsServer);
    setNfsBasePath(merged.nfsBasePath);
  }, [namespaces, namespacesAvailable, globalFallback]);

  const canPickExisting = namespacesAvailable && (namespaces?.length ?? 0) > 0;
  const selectedEntry = namespaces?.find((ns) => ns.name === selectedName) ?? null;
  const newNamespaceInvalid =
    mode === 'new' && newNamespace.trim() !== '' && !isValidNamespaceName(newNamespace);
  const effectiveNamespace = mode === 'existing' ? selectedName : newNamespace.trim();

  const chooseExisting = useCallback(
    (name: string) => {
      const entry = namespaces?.find((ns) => ns.name === name) ?? null;
      setSelectedName(name);
      // Explicit reselect: refill the form from the stored values.
      const merged = mergeSetupPrefill(entry?.setupValues, globalFallback);
      setRegistry(merged.registry);
      setNfsServer(merged.nfsServer);
      setNfsBasePath(merged.nfsBasePath);
    },
    [namespaces, globalFallback],
  );

  const switchMode = useCallback(
    (next: NamespaceMode) => {
      setMode(next);
      if (next === 'new') {
        // Start fresh: blanks, never a silent merge of the previous pick.
        setNewNamespace('');
        setRegistry('');
        setNfsServer('');
        setNfsBasePath('');
      } else if (namespaces && namespaces.length > 0) {
        chooseExisting(namespaces[0].name);
      }
    },
    [namespaces, chooseExisting],
  );

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      if (mode === 'new' && newNamespace.trim() !== '' && !isValidNamespaceName(newNamespace)) {
        setError('Namespace must be lowercase letters, numbers, and dashes (up to 63 characters).');
        return;
      }
      if (mode === 'existing' && !selectedName) {
        setError('Pick a namespace from the list, or create a new one.');
        return;
      }
      setPending(true);
      try {
        // Existing-namespace flow: send only the namespace. The server
        // fills registry/NFS from the namespace's stored values.
        const args =
          mode === 'existing'
            ? buildSetupArgs('', '', '', selectedName)
            : buildSetupArgs(registry, nfsServer, nfsBasePath, effectiveNamespace);
        const job = await api.post<JobResponse>('/api/jobs', { op: 'setup', args });
        setResult(job);
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setPending(false);
      }
    },
    [registry, nfsServer, nfsBasePath, effectiveNamespace, mode, newNamespace, selectedName],
  );

  return (
    <div data-ref="page-setup">
      <PageHeader
        title="Setup"
        description="One-time environment setup: global config, Dockerfile, and SSH key pair."
      />

      <Card data-ref="page-setup-config-card" style={{ marginBottom: 24 }}>
        <h2 data-ref="page-setup-config-heading" style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 8px' }}>Global config status</h2>
        {!config && !configError ? (
          <Spinner label="Loading global config status…" />
        ) : configError ? (
          <p data-ref="page-setup-config-error" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
            Could not load global config status: {configError}
          </p>
        ) : (
          config && (
            <p data-ref="page-setup-config-status" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
              <Badge tone={config.exists ? 'default' : 'accent'}>
                {config.exists ? 'exists' : 'missing'}
              </Badge>{' '}
              <code style={{ fontSize: 'var(--font-size-sm)' }}>{config.path}</code>
              {!config.exists && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}
                  — run setup below to create it.
                </span>
              )}
            </p>
          )
        )}
      </Card>

      <Card data-ref="page-setup-form-card">
        <h2
          data-ref="page-setup-form-heading"
          style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <Wrench size={18} aria-hidden="true" /> Run setup
        </h2>
        <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>
          Never overwrites existing files. Values left blank fall back to interactive prompts on
          the server, or clearly-marked placeholders when non-interactive.
        </p>
        <form data-ref="page-setup-form" onSubmit={(e) => void submit(e)}>
          <div style={{ marginBottom: 16 }}>
            <span id="setup-namespace-mode-label" style={{ display: 'block', fontSize: 'var(--font-size-md)', fontWeight: 600, marginBottom: 8 }}>
              Coding area
            </span>
            <div data-ref="page-setup-namespace-mode" role="radiogroup" aria-labelledby="setup-namespace-mode-label" style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-md)' }}>
                <input
                  data-ref="page-setup-namespace-mode-existing"
                  type="radio"
                  name="setup-namespace-mode"
                  value="existing"
                  checked={mode === 'existing'}
                  disabled={!canPickExisting}
                  onChange={() => switchMode('existing')}
                />
                Use existing
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-md)' }}>
                <input
                  data-ref="page-setup-namespace-mode-new"
                  type="radio"
                  name="setup-namespace-mode"
                  value="new"
                  checked={mode === 'new'}
                  onChange={() => switchMode('new')}
                />
                Create new
              </label>
            </div>
            {namespaces === null ? (
              <span data-ref="page-setup-namespaces-loading">
                <Spinner label="Loading existing areas…" />
              </span>
            ) : mode === 'existing' && canPickExisting ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <select
                  id="setup-namespace-select"
                  className="input"
                  style={{ minHeight: 44, minWidth: 220 }}
                  value={selectedName}
                  onChange={(e) => chooseExisting(e.target.value)}
                  data-ref="page-setup-namespace-select"
                  aria-label="Existing coding area"
                >
                  {(namespaces ?? []).map((ns) => (
                    <option key={ns.name} value={ns.name}>
                      {ns.name}
                    </option>
                  ))}
                </select>
                {selectedEntry ? (
                  <Badge
                    data-ref="page-setup-namespace-status"
                    tone={selectedEntry.initialized ? 'accent' : 'default'}
                  >
                    {selectedEntry.initialized ? 'ready' : 'empty'}
                  </Badge>
                ) : null}
              </div>
            ) : (
              <div>
                {!namespacesAvailable ? (
                  <p data-ref="page-setup-namespaces-unavailable" style={{ margin: '0 0 8px', color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>
                    The list of existing areas is unavailable — type a name instead.
                  </p>
                ) : (
                  <p data-ref="page-setup-namespaces-empty" style={{ margin: '0 0 8px', color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>
                    No existing areas yet — type a name to create the first one.
                  </p>
                )}
                <Label htmlFor="setup-namespace-new">Area name</Label>
                <Input
                  data-ref="page-setup-namespace-new-input"
                  id="setup-namespace-new"
                  value={newNamespace}
                  onChange={(e) => {
                    markTyped();
                    setNewNamespace(e.target.value);
                  }}
                  placeholder="team-alpha"
                  autoComplete="off"
                  spellCheck={false}
                />
                {newNamespaceInvalid ? (
                  <p data-ref="page-setup-namespace-error" role="alert" style={{ margin: '8px 0 0', fontSize: 'var(--font-size-md)', color: 'var(--color-error, #b3261e)' }}>
                    Use lowercase letters, numbers, and dashes (up to 63 characters).
                  </p>
                ) : null}
              </div>
            )}
            <p style={{ margin: '8px 0 0', color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              One name per developer keeps work private; one shared name lets a team float together.
            </p>
          </div>
          {mode === 'existing' && canPickExisting ? null : (
          <div style={{ display: 'grid', gap: 12, maxWidth: 520, marginBottom: 16 }}>
            <div>
              <Label htmlFor="setup-registry">Container registry (optional)</Label>
              <Input
                data-ref="page-setup-registry-input"
                id="setup-registry"
                value={registry}
                onChange={(e) => {
                  markTyped();
                  setRegistry(e.target.value);
                }}
                placeholder="registry.example.com/you"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <Label htmlFor="setup-nfs-server">NFS server (optional)</Label>
              <Input
                data-ref="page-setup-nfs-server-input"
                id="setup-nfs-server"
                value={nfsServer}
                onChange={(e) => {
                  markTyped();
                  setNfsServer(e.target.value);
                }}
                placeholder="10.0.0.5"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <Label htmlFor="setup-nfs-base-path">NFS base path (optional)</Label>
              <Input
                data-ref="page-setup-nfs-base-path-input"
                id="setup-nfs-base-path"
                value={nfsBasePath}
                onChange={(e) => {
                  markTyped();
                  setNfsBasePath(e.target.value);
                }}
                placeholder="/workspaces"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          )}
          <Button data-ref="page-setup-run-button" type="submit" disabled={pending || newNamespaceInvalid}>
            {pending ? 'Starting…' : 'Run setup'}
          </Button>
        </form>
        {result ? (
          <JobOutput key={result.id} job={result} dataRef="page-setup-job" />
        ) : null}
        <p style={{ margin: '16px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
          Afterwards, on a fresh cluster run <Link data-ref="page-setup-system-link" to="/system">system init</Link> once, then{' '}
          <Link data-ref="page-setup-deploy-link" to="/projects">create</Link> from a project page.
        </p>
      </Card>

      {error && (
        <p data-ref="page-setup-error" role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)', marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}
