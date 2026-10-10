import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { buildSetupArgs } from './job-helpers';
import { Badge, Button, Card, Input, Label, PageHeader, Spinner } from '../components/ui';

interface GlobalConfigResponse {
  exists: boolean;
  path: string;
  rawYaml: string | null;
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

export function SetupPage() {
  const [config, setConfig] = useState<GlobalConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [registry, setRegistry] = useState('');
  const [nfsServer, setNfsServer] = useState('');
  const [nfsBasePath, setNfsBasePath] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      setPending(true);
      try {
        const args = buildSetupArgs(registry, nfsServer, nfsBasePath);
        const job = await api.post<JobResponse>('/api/jobs', { op: 'setup', args });
        setResult(job);
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setPending(false);
      }
    },
    [registry, nfsServer, nfsBasePath],
  );

  return (
    <div>
      <PageHeader
        title="Setup"
        description="One-time environment setup: global config, Dockerfile, and SSH key pair."
      />

      <Card style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Global config status</h2>
        {!config && !configError ? (
          <Spinner label="Loading global config status…" />
        ) : configError ? (
          <p role="alert" style={{ margin: 0, fontSize: 14 }}>
            Could not load global config status: {configError}
          </p>
        ) : (
          config && (
            <p style={{ margin: 0, fontSize: 14 }}>
              <Badge tone={config.exists ? 'default' : 'accent'}>
                {config.exists ? 'exists' : 'missing'}
              </Badge>{' '}
              <code style={{ fontSize: 13 }}>{config.path}</code>
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

      <Card>
        <h2
          style={{ fontSize: 16, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <Wrench size={18} aria-hidden="true" /> Run setup
        </h2>
        <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>
          Never overwrites existing files. Values left blank fall back to interactive prompts on
          the server, or clearly-marked placeholders when non-interactive.
        </p>
        <form onSubmit={(e) => void submit(e)}>
          <div style={{ display: 'grid', gap: 12, maxWidth: 520, marginBottom: 16 }}>
            <div>
              <Label htmlFor="setup-registry">Container registry (optional)</Label>
              <Input
                id="setup-registry"
                value={registry}
                onChange={(e) => setRegistry(e.target.value)}
                placeholder="registry.example.com/you"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <Label htmlFor="setup-nfs-server">NFS server (optional)</Label>
              <Input
                id="setup-nfs-server"
                value={nfsServer}
                onChange={(e) => setNfsServer(e.target.value)}
                placeholder="10.0.0.5"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <Label htmlFor="setup-nfs-base-path">NFS base path (optional)</Label>
              <Input
                id="setup-nfs-base-path"
                value={nfsBasePath}
                onChange={(e) => setNfsBasePath(e.target.value)}
                placeholder="/workspaces"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Starting…' : 'Run setup'}
          </Button>
        </form>
        <p style={{ margin: '16px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
          Afterwards, on a fresh cluster run <Link to="/system">system init</Link> once, then{' '}
          <Link to="/deploy">create</Link> in a project folder.
        </p>
      </Card>

      {result && (
        <Card style={{ marginTop: 16 }}>
          <p style={{ margin: 0, fontSize: 14 }}>
            Job started: <code>{result.id}</code> ({result.status}) — <Link to="/jobs">View jobs</Link>
          </p>
        </Card>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 14, marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}
