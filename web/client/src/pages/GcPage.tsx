import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Recycle, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import { parseKeep } from './job-helpers';
import { Button, Card, EmptyState, Input, Label, PageHeader } from '../components/ui';

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

type GcOp = 'gc' | 'system-gc';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function GcPage() {
  const { projects, activeId } = useProjects();
  const [keep, setKeep] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [pending, setPending] = useState<GcOp | null>(null);
  const [result, setResult] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = projects.find((p) => p.id === activeId) ?? null;

  const submit = useCallback(
    async (e: FormEvent, op: GcOp, preview: boolean) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      if (!active) {
        setError('Select a project first.');
        return;
      }
      const parsed = parseKeep(keep);
      if (parsed.error) {
        setError(parsed.error);
        return;
      }
      const args: Record<string, unknown> = {};
      if (parsed.keep !== undefined) args.keep = parsed.keep;
      if (preview || dryRun) args.dryRun = true;
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
    [active, keep, dryRun],
  );

  return (
    <div>
      <PageHeader
        title="GC"
        description="Garbage-collect old image tags from the project repo or the shared global repo."
      />

      <Card style={{ marginBottom: 24 }}>
        <ProjectPicker />
        <div style={{ display: 'grid', gap: 12, maxWidth: 520, marginTop: 16 }}>
          <div>
            <Label htmlFor="gc-keep">Keep (versions behind the pin; empty = server default)</Label>
            <Input
              id="gc-keep"
              value={keep}
              onChange={(e) => setKeep(e.target.value)}
              placeholder="5"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, fontSize: 14 }}
          >
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            dry-run (preview only, nothing deleted)
          </label>
        </div>
      </Card>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Add a project first, then come back to garbage-collect."
          action={<Link to="/projects">Go to Projects</Link>}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          <Card>
            <h2 style={{ fontSize: 16, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Trash2 size={18} aria-hidden="true" /> Project GC
            </h2>
            <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>
              Prune the project&apos;s custom image repo. Custom-mode projects only — global-mode
              projects use System GC below.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <form onSubmit={(e) => void submit(e, 'gc', true)}>
                <Button type="submit" variant="secondary" disabled={pending !== null || !active}>
                  {pending === 'gc' ? 'Starting…' : 'Preview'}
                </Button>
              </form>
              <form onSubmit={(e) => void submit(e, 'gc', false)}>
                <Button type="submit" disabled={pending !== null || !active || dryRun}>
                  {pending === 'gc' ? 'Starting…' : 'Run GC'}
                </Button>
              </form>
            </div>
          </Card>

          <Card>
            <h2 style={{ fontSize: 16, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Recycle size={18} aria-hidden="true" /> System GC
            </h2>
            <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>
              Prune the shared global image repo. Keeps current, previous, every in-use tag, and
              the keep-many predecessors of current.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <form onSubmit={(e) => void submit(e, 'system-gc', true)}>
                <Button type="submit" variant="secondary" disabled={pending !== null || !active}>
                  {pending === 'system-gc' ? 'Starting…' : 'Preview'}
                </Button>
              </form>
              <form onSubmit={(e) => void submit(e, 'system-gc', false)}>
                <Button type="submit" disabled={pending !== null || !active || dryRun}>
                  {pending === 'system-gc' ? 'Starting…' : 'Run system GC'}
                </Button>
              </form>
            </div>
          </Card>
        </div>
      )}

      <Card style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Retention rules</h2>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-muted)' }}>
          <li>A tag is never deleted while in use by a deployment in the namespace.</li>
          <li>The pin (project tag, or current for the global repo) and previous are always kept.</li>
          <li>Everything else is deleted oldest-first; non-semver tags are deleted unless in use.</li>
          <li>Deleting a tag frees disk only once the registry runs its own garbage collection.</li>
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
