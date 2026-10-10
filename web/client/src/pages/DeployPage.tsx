import { useCallback, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CloudUpload, Hammer, Rocket, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import { Button, Card, EmptyState, Input, Label, PageHeader } from '../components/ui';

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

type Op = 'create' | 'deploy' | 'build' | 'push' | 'delete';

const OP_META: Record<Op, { title: string; description: string; icon: typeof Rocket }> = {
  create: {
    title: 'Create (full pipeline)',
    description: 'Build, push, and roll out in one go. Honors skip-build / skip-push below.',
    icon: Wrench,
  },
  deploy: {
    title: 'Deploy',
    description: 'Roll out the current image to the cluster. Use no-wait to return immediately.',
    icon: Rocket,
  },
  build: {
    title: 'Build',
    description: 'Build the container image locally without pushing.',
    icon: Hammer,
  },
  push: {
    title: 'Push',
    description: 'Push the built image to the registry.',
    icon: CloudUpload,
  },
  delete: {
    title: 'Delete',
    description: 'Tear down project workloads. Optionally keep secrets for re-create.',
    icon: AlertTriangle,
  },
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function DeployPage() {
  const { projects, activeId } = useProjects();
  const [tag, setTag] = useState('');
  const [noWait, setNoWait] = useState(false);
  const [skipBuild, setSkipBuild] = useState(false);
  const [skipPush, setSkipPush] = useState(false);
  const [keepSecrets, setKeepSecrets] = useState(false);
  const [pending, setPending] = useState<Op | null>(null);
  const [result, setResult] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = projects.find((p) => p.id === activeId) ?? null;

  const submit = useCallback(
    async (e: FormEvent, op: Op) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      if (!active) {
        setError('Select a project first.');
        return;
      }
      if (op === 'delete' && !window.confirm(`Delete workloads for "${active.name}"?`)) return;
      const trimmedTag = tag.trim();
      const args: Record<string, unknown> = {};
      if (trimmedTag) args.tag = trimmedTag;
      if (op === 'create') {
        if (skipBuild) args.skipBuild = true;
        if (skipPush) args.skipPush = true;
      }
      if (op === 'deploy' && noWait) args.noWait = true;
      if (op === 'delete' && keepSecrets) args.keepSecrets = true;
      setPending(op);
      try {
        const job = await api.post<JobResponse>('/api/jobs', { op, projectId: active.id, args });
        setResult(job);
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setPending(null);
      }
    },
    [active, tag, noWait, skipBuild, skipPush, keepSecrets],
  );

  const checkboxRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    fontSize: 14,
  };

  const ops: Op[] = ['create', 'deploy', 'build', 'push'];

  return (
    <div>
      <PageHeader title="Deploy" description="Build, publish, and roll out container images." />

      <Card style={{ marginBottom: 24 }}>
        <ProjectPicker />
        {projects.length > 0 && !active && (
          <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
            Select a project to enable deploy actions.
          </p>
        )}

        <div style={{ display: 'grid', gap: 12, maxWidth: 520, marginTop: 16 }}>
          <div>
            <Label htmlFor="deploy-tag">Tag override (optional)</Label>
            <Input
              id="deploy-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="v1.2.3"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 24px' }}>
            <label style={checkboxRow}>
              <input type="checkbox" checked={noWait} onChange={(e) => setNoWait(e.target.checked)} />
              no-wait (deploy)
            </label>
            <label style={checkboxRow}>
              <input type="checkbox" checked={skipBuild} onChange={(e) => setSkipBuild(e.target.checked)} />
              skip-build (create)
            </label>
            <label style={checkboxRow}>
              <input type="checkbox" checked={skipPush} onChange={(e) => setSkipPush(e.target.checked)} />
              skip-push (create)
            </label>
            <label style={checkboxRow}>
              <input
                type="checkbox"
                checked={keepSecrets}
                onChange={(e) => setKeepSecrets(e.target.checked)}
              />
              keep-secrets (delete)
            </label>
          </div>
        </div>
      </Card>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Add a project first, then come back to deploy."
          action={<Link to="/projects">Go to Projects</Link>}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          {ops.map((op) => {
            const meta = OP_META[op];
            const Icon = meta.icon;
            return (
              <Card key={op}>
                <h2 style={{ fontSize: 16, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon size={18} aria-hidden="true" /> {meta.title}
                </h2>
                <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>{meta.description}</p>
                <form onSubmit={(e) => void submit(e, op)}>
                  <Button type="submit" disabled={pending !== null || !active}>
                    {pending === op ? 'Starting…' : meta.title}
                  </Button>
                </form>
              </Card>
            );
          })}

          <Card style={{ borderColor: 'var(--color-error, #b3261e)' }}>
            <h2 style={{ fontSize: 16, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={18} aria-hidden="true" /> {OP_META.delete.title}
            </h2>
            <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>
              {OP_META.delete.description}
            </p>
            <form onSubmit={(e) => void submit(e, 'delete')}>
              <Button type="submit" variant="secondary" disabled={pending !== null || !active}>
                {pending === 'delete' ? 'Starting…' : 'Delete workloads'}
              </Button>
            </form>
          </Card>
        </div>
      )}

      <Card style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>CLI-parity notes</h2>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-muted)' }}>
          <li>In global image mode the tag floats on the shared team image.</li>
          <li>Build and push are refused by the server in global mode — any refusal is shown below.</li>
          <li>Flags map 1:1 to CLI args (--tag, --no-wait, --skip-build, --skip-push, --keep-secrets).</li>
        </ul>
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
