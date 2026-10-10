import { useState } from 'react';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import { Badge, Button, Card, Input, Label, PageHeader, Spinner } from '../components/ui';

interface ValidateResponse {
  ok: boolean;
  lines?: string[];
  summary?: string;
  error?: string;
}

interface ManifestResponse {
  manifest: string;
  warnings?: string[];
}

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

const preStyle = {
  ...monoStyle,
  margin: 0,
  padding: 12,
  fontSize: 13,
  whiteSpace: 'pre',
  overflow: 'auto',
} as const;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export function ValidatePage() {
  const { activeId: activeProjectId } = useProjects();

  const [tagOverride, setTagOverride] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ValidateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  function buildQuery(): string {
    const qs = new URLSearchParams();
    if (activeProjectId) qs.set('projectId', activeProjectId);
    if (tagOverride.trim()) qs.set('tagOverride', tagOverride.trim());
    return qs.toString();
  }

  async function handleRun() {
    if (!activeProjectId) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.get<ValidateResponse>(`/api/validate?${buildQuery()}`);
      setResult(data);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRunning(false);
    }
  }

  async function handleManifest() {
    if (!activeProjectId) return;
    setManifestLoading(true);
    setManifestError(null);
    setManifest(null);
    try {
      const data = await api.get<ManifestResponse>(`/api/manifest?${buildQuery()}`);
      setManifest(data);
    } catch (err) {
      setManifestError(errMessage(err));
    } finally {
      setManifestLoading(false);
    }
  }

  const resultLines = result?.lines ?? [];
  const manifestWarnings = manifest?.warnings ?? [];

  return (
    <div>
      <PageHeader title="Validate" description="Check project configuration before create and deploy." />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Card>
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Configuration check</h2>
          <div style={{ marginBottom: 16 }}>
            <ProjectPicker />
          </div>
          <div style={{ marginBottom: 16, maxWidth: 480 }}>
            <Label htmlFor="validate-tag-override">Tag override</Label>
            <Input
              id="validate-tag-override"
              type="text"
              placeholder="e.g. v1.2.3 (optional)"
              autoComplete="off"
              value={tagOverride}
              onChange={(e) => setTagOverride(e.target.value)}
            />
          </div>
          <Button onClick={() => void handleRun()} disabled={!activeProjectId || running}>
            {running ? 'Running…' : 'Run validation'}
          </Button>
          {!activeProjectId ? (
            <p style={{ margin: '12px 0 0', fontSize: 14, color: 'var(--text-muted)' }}>
              Select a project to run validation.
            </p>
          ) : null}
          {running ? (
            <div style={{ marginTop: 16 }}>
              <Spinner label="Running validation…" />
            </div>
          ) : null}
          {error ? (
            <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
              Validation failed: {error}
            </p>
          ) : null}
          {result ? (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {result.ok ? <Badge tone="accent">Valid</Badge> : <Badge>Failed</Badge>}
              {result.error ? (
                <p role="alert" style={{ margin: 0, fontSize: 14 }}>
                  {result.error}
                </p>
              ) : null}
              {resultLines.length > 0 ? (
                <pre
                  style={{
                    ...preStyle,
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-surface)',
                    maxHeight: 400,
                  }}
                >
                  {resultLines.join('\n')}
                </pre>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Manifest preview</h2>
          <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
            Secrets are redacted from the rendered manifest.
          </p>
          <Button
            variant="secondary"
            onClick={() => void handleManifest()}
            disabled={!activeProjectId || manifestLoading}
          >
            {manifestLoading ? 'Loading…' : 'Load manifest'}
          </Button>
          {manifestLoading ? (
            <div style={{ marginTop: 16 }}>
              <Spinner label="Loading manifest…" />
            </div>
          ) : null}
          {manifestError ? (
            <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
              Could not load manifest: {manifestError}
            </p>
          ) : null}
          {manifest ? (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {manifestWarnings.length > 0 ? (
                <div>
                  <h3 style={{ fontSize: 14, marginBottom: 8 }}>Warnings</h3>
                  <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
                    {manifestWarnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div
                style={{
                  overflow: 'auto',
                  maxHeight: 500,
                  borderRadius: 8,
                  border: '1px solid var(--border-color)',
                  backgroundColor: 'var(--bg-surface)',
                }}
              >
                <pre style={{ ...preStyle, border: 'none', backgroundColor: 'transparent' }}>{manifest.manifest}</pre>
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
