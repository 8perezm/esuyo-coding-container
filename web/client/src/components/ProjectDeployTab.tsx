import { useCallback, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CloudUpload, Hammer, Recycle, Rocket, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import type { Project } from '../lib/projects';
import { parseKeep } from '../pages/job-helpers';
import { JobOutput } from './JobOutput';
import { Button, Card, ConfirmDialog, Input, Label } from './ui';

interface JobResponse {
  id: string;
  op: string;
  status: string;
  startedAt?: string;
}

type Op = 'create' | 'deploy' | 'build' | 'push' | 'delete' | 'gc';

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
  gc: {
    title: 'Project GC',
    description:
      'Prune old tags from this project\u2019s custom image repo. Custom-mode projects only — global-mode projects share the team image (see Images cleanup).',
    icon: Recycle,
  },
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function ProjectDeployTab({ project }: { project: Project }) {
  const [tag, setTag] = useState('');
  const [noWait, setNoWait] = useState(false);
  const [skipBuild, setSkipBuild] = useState(false);
  const [skipPush, setSkipPush] = useState(false);
  const [keepSecrets, setKeepSecrets] = useState(false);
  const [gcKeep, setGcKeep] = useState('');
  const [gcDryRun, setGcDryRun] = useState(true);
  const [pending, setPending] = useState<Op | null>(null);
  const [result, setResult] = useState<JobResponse | null>(null);
  const [jobsByOp, setJobsByOp] = useState<Partial<Record<Op, JobResponse>>>({});
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const runOp = useCallback(
    async (op: Op) => {
      const trimmedTag = tag.trim();
      const args: Record<string, unknown> = {};
      if (trimmedTag) args.tag = trimmedTag;
      if (op === 'create') {
        if (skipBuild) args.skipBuild = true;
        if (skipPush) args.skipPush = true;
      }
      if (op === 'deploy' && noWait) args.noWait = true;
      if (op === 'delete' && keepSecrets) args.keepSecrets = true;
      setError(null);
      setResult(null);
      setPending(op);
      try {
        const job = await api.post<JobResponse>('/api/jobs', { op, projectId: project.id, args });
        setResult(job);
        setJobsByOp((prev) => ({ ...prev, [op]: job }));
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setPending(null);
        if (op === 'delete') setShowDeleteConfirm(false);
      }
    },
    [project.id, tag, noWait, skipBuild, skipPush, keepSecrets],
  );

  const submit = useCallback(
    (e: FormEvent, op: Op) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      if (op === 'delete') {
        setShowDeleteConfirm(true);
        return;
      }
      void runOp(op);
    },
    [runOp],
  );

  const submitGc = useCallback(
    async (e: FormEvent, preview: boolean) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      const parsed = parseKeep(gcKeep);
      if (parsed.error) {
        setError(parsed.error);
        return;
      }
      const args: Record<string, unknown> = {};
      if (parsed.keep !== undefined) args.keep = parsed.keep;
      if (preview || gcDryRun) args.dryRun = true;
      setPending('gc');
      try {
        const job = await api.post<JobResponse>('/api/jobs', { op: 'gc', projectId: project.id, args });
        setResult(job);
        setJobsByOp((prev) => ({ ...prev, gc: job }));
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setPending(null);
      }
    },
    [project.id, gcKeep, gcDryRun],
  );

  const checkboxRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    fontSize: 'var(--font-size-md)',
  };

  const ops: Op[] = ['create', 'deploy', 'build', 'push'];

  return (
    <div data-ref="page-project-edit-deploy">
      <Card data-ref="page-project-edit-deploy-options-card" style={{ marginBottom: 24 }}>
        <div data-ref="page-project-edit-deploy-options" style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <div>
            <Label htmlFor="project-deploy-tag">Tag override (optional)</Label>
            <Input
              data-ref="page-project-edit-deploy-tag-field"
              id="project-deploy-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="v1.2.3"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 24px' }}>
            <label style={checkboxRow}>
              <input data-ref="page-project-edit-deploy-check-nowait" type="checkbox" checked={noWait} onChange={(e) => setNoWait(e.target.checked)} />
              no-wait (deploy)
            </label>
            <label style={checkboxRow}>
              <input data-ref="page-project-edit-deploy-check-skip-build" type="checkbox" checked={skipBuild} onChange={(e) => setSkipBuild(e.target.checked)} />
              skip-build (create)
            </label>
            <label style={checkboxRow}>
              <input data-ref="page-project-edit-deploy-check-skip-push" type="checkbox" checked={skipPush} onChange={(e) => setSkipPush(e.target.checked)} />
              skip-push (create)
            </label>
            <label style={checkboxRow}>
              <input
                data-ref="page-project-edit-deploy-check-keep-secrets"
                type="checkbox"
                checked={keepSecrets}
                onChange={(e) => setKeepSecrets(e.target.checked)}
              />
              keep-secrets (delete)
            </label>
          </div>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        {ops.map((op) => {
          const meta = OP_META[op];
          const Icon = meta.icon;
          return (
            <Card key={op} data-ref={`page-project-edit-deploy-card-${op}`}>
              <h2 data-ref={`page-project-edit-deploy-heading-${op}`} style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon size={18} aria-hidden="true" /> {meta.title}
              </h2>
              <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>{meta.description}</p>
              <form data-ref={`page-project-edit-deploy-form-${op}`} onSubmit={(e) => void submit(e, op)}>
                <Button data-ref={`page-project-edit-deploy-submit-${op}`} type="submit" disabled={pending !== null}>
                  {pending === op ? 'Starting…' : meta.title}
                </Button>
              </form>
              {jobsByOp[op] ? (
                <JobOutput key={jobsByOp[op].id} job={jobsByOp[op] as JobResponse} dataRef={`page-project-edit-deploy-job-${op}`} />
              ) : null}
            </Card>
          );
        })}

        <Card data-ref="page-project-edit-deploy-card-delete" style={{ borderColor: 'var(--color-error, #b3261e)' }}>
          <h2 data-ref="page-project-edit-deploy-heading-delete" style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} aria-hidden="true" /> {OP_META.delete.title}
          </h2>
          <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>
            {OP_META.delete.description}
          </p>
          <form data-ref="page-project-edit-deploy-form-delete" onSubmit={(e) => void submit(e, 'delete')}>
            <Button data-ref="page-project-edit-deploy-submit-delete" type="submit" variant="secondary" disabled={pending !== null}>
              {pending === 'delete' ? 'Starting…' : 'Delete workloads'}
            </Button>
          </form>
          {jobsByOp.delete ? (
            <JobOutput key={jobsByOp.delete.id} job={jobsByOp.delete as JobResponse} dataRef="page-project-edit-deploy-job-delete" />
          ) : null}
        </Card>

        <Card data-ref="page-project-edit-deploy-card-gc">
          <h2 data-ref="page-project-edit-deploy-heading-gc" style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Recycle size={18} aria-hidden="true" /> {OP_META.gc.title}
          </h2>
          <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>
            {OP_META.gc.description}
          </p>
          <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
            <div>
              <Label htmlFor="project-gc-keep">Keep (versions behind the pin; empty = server default)</Label>
              <Input
                data-ref="page-project-edit-deploy-gc-keep-field"
                id="project-gc-keep"
                value={gcKeep}
                onChange={(e) => setGcKeep(e.target.value)}
                placeholder="5"
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
            <label style={checkboxRow}>
              <input data-ref="page-project-edit-deploy-gc-dryrun-field" type="checkbox" checked={gcDryRun} onChange={(e) => setGcDryRun(e.target.checked)} />
              dry-run (preview only, nothing deleted)
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <form data-ref="page-project-edit-deploy-form-gc-preview" onSubmit={(e) => void submitGc(e, true)}>
              <Button data-ref="page-project-edit-deploy-submit-gc-preview" type="submit" variant="secondary" disabled={pending !== null}>
                {pending === 'gc' ? 'Starting…' : 'Preview'}
              </Button>
            </form>
            <form data-ref="page-project-edit-deploy-form-gc-run" onSubmit={(e) => void submitGc(e, false)}>
              <Button data-ref="page-project-edit-deploy-submit-gc-run" type="submit" disabled={pending !== null || gcDryRun}>
                {pending === 'gc' ? 'Starting…' : 'Run GC'}
              </Button>
            </form>
          </div>
          {jobsByOp.gc ? (
            <JobOutput key={jobsByOp.gc.id} job={jobsByOp.gc as JobResponse} dataRef="page-project-edit-deploy-job-gc" />
          ) : null}
        </Card>
      </div>

      <Card data-ref="page-project-edit-deploy-notes-card" style={{ marginTop: 16 }}>
        <h2 data-ref="page-project-edit-deploy-heading-notes" style={{ fontSize: 'var(--font-size-md)', margin: '0 0 8px' }}>Notes</h2>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
          <li>In global image mode the tag floats on the shared team image.</li>
          <li>Build and push are refused by the server in global mode — any refusal is shown below.</li>
          <li>The tag override and checkboxes are passed straight through to each job.</li>
          <li>Project GC never deletes a tag in use by a deployment; the pin and previous are always kept.</li>
        </ul>
      </Card>

      {result && (
        <Card data-ref="page-project-edit-deploy-result-card" style={{ marginTop: 16 }}>
          <p data-ref="page-project-edit-deploy-status-result" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
            Job started: <code data-ref="page-project-edit-deploy-result-id">{result.id}</code> ({result.status}) — <Link data-ref="page-project-edit-deploy-link-jobs" to="/jobs">View jobs</Link>
          </p>
        </Card>
      )}
      {error && (
        <p data-ref="page-project-edit-deploy-error" role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)', marginTop: 12 }}>
          {error}
        </p>
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          title={`Delete "${project.name}"?`}
          confirmLabel="Delete workloads"
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={() => void runOp('delete')}
          confirming={pending === 'delete'}
        >
          <p style={{ margin: 0 }}>
            This tears down the deployment, service and ingress for <strong>{project.name}</strong>.
            {keepSecrets ? ' Secrets will be kept.' : ' Secrets will be removed.'} This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
