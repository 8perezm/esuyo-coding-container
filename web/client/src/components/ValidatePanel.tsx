import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { Badge, Button, Input, Label, Spinner } from './ui';

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
  fontSize: 'var(--font-size-sm)',
  whiteSpace: 'pre',
  overflow: 'auto',
} as const;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

/** Unsaved editor content to validate. Sent as-is; the server validates it
 *  via temp files, so a bad draft never overwrites the good file on disk. */
export interface ValidationDraft {
  yaml?: string;
  globalYaml?: string;
}

export interface Validation {
  projectId: string | null;
  tagOverride: string;
  setTagOverride: (value: string) => void;
  running: boolean;
  result: ValidateResponse | null;
  error: string | null;
  manifestLoading: boolean;
  manifest: ManifestResponse | null;
  manifestError: string | null;
  runValidation: (draft?: ValidationDraft) => Promise<void>;
  loadManifest: (draft?: ValidationDraft) => Promise<void>;
}

/** Shared validation state for the buttons under a YamlEditor and the
 *  results rendered below. POSTs the live editor draft to the server. */
export function useValidation(projectId: string | null): Validation {
  const [tagOverride, setTagOverride] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ValidateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  function buildBody(draft: ValidationDraft = {}): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (projectId) body.projectId = projectId;
    if (tagOverride.trim()) body.tagOverride = tagOverride.trim();
    if (draft.yaml !== undefined) body.yaml = draft.yaml;
    if (draft.globalYaml !== undefined) body.globalYaml = draft.globalYaml;
    return body;
  }

  async function runValidation(draft: ValidationDraft = {}) {
    if (!projectId) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.post<ValidateResponse>('/api/validate', buildBody(draft));
      setResult(data);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRunning(false);
    }
  }

  async function loadManifest(draft: ValidationDraft = {}) {
    if (!projectId) return;
    setManifestLoading(true);
    setManifestError(null);
    setManifest(null);
    try {
      const data = await api.post<ManifestResponse>('/api/manifest', buildBody(draft));
      setManifest(data);
    } catch (err) {
      setManifestError(errMessage(err));
    } finally {
      setManifestLoading(false);
    }
  }

  return {
    projectId,
    tagOverride,
    setTagOverride,
    running,
    result,
    error,
    manifestLoading,
    manifest,
    manifestError,
    runValidation,
    loadManifest,
  };
}

interface ValidateActionsProps {
  validation: Validation;
  /** Live editor content validated on click (never saved first). */
  draft?: ValidationDraft;
  /** Page-owned save action, rendered to the left of "Run validation". */
  saveButton?: ReactNode;
  /** Hide the heading, description and tag-override input. */
  compact?: boolean;
}

/** Action row rendered directly underneath a YamlEditor: save + validate. */
export function ValidateActions({ validation, draft = {}, saveButton, compact }: ValidateActionsProps) {
  const { projectId, tagOverride, setTagOverride, running, manifestLoading } = validation;
  return (
    <div data-ref="validate-actions">
      {!compact && (
        <>
          <h2 data-ref="validate-panel-check-heading" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 16 }}>Configuration check</h2>
          <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
            Validates what is currently in the editor — nothing is saved first.
          </p>
          <div style={{ marginBottom: 16, maxWidth: 480 }}>
            <Label htmlFor="validate-panel-tag-override">Tag override</Label>
            <Input
              data-ref="validate-panel-tag-input"
              id="validate-panel-tag-override"
              type="text"
              placeholder="e.g. v1.2.3 (optional)"
              autoComplete="off"
              value={tagOverride}
              onChange={(e) => setTagOverride(e.target.value)}
            />
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {saveButton}
        <Button
          data-ref="validate-panel-run-button"
          variant="secondary"
          onClick={() => void validation.runValidation(draft)}
          disabled={!projectId || running}
        >
          {running ? 'Running…' : 'Run validation'}
        </Button>
        <Button
          data-ref="validate-panel-manifest-load-button"
          variant="secondary"
          onClick={() => void validation.loadManifest(draft)}
          disabled={!projectId || manifestLoading}
        >
          {manifestLoading ? 'Loading…' : 'Load manifest'}
        </Button>
      </div>
      {!projectId ? (
        <p data-ref="validate-panel-no-project-hint" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
          Select a project to run validation.
        </p>
      ) : null}
    </div>
  );
}

/** Validation + manifest output. Renders nothing until the first run. */
export function ValidationResults({ validation }: { validation: Validation }) {
  const { running, result, error, manifestLoading, manifest, manifestError } = validation;
  const resultLines = result?.lines ?? [];
  const manifestWarnings = manifest?.warnings ?? [];
  if (!running && !error && !result && !manifestLoading && !manifestError && !manifest) return null;

  return (
    <div data-ref="validate-panel-check-card">
      {running ? (
        <div data-ref="validate-panel-running" style={{ marginBottom: 16 }}>
          <Spinner label="Running validation…" />
        </div>
      ) : null}
      {error ? (
        <p data-ref="validate-panel-error" role="alert" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)' }}>
          Validation failed: {error}
        </p>
      ) : null}
      {result ? (
        <div data-ref="validate-panel-result" style={{ marginTop: 16, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {result.ok ? <Badge tone="accent">Valid</Badge> : <Badge>Failed</Badge>}
          {result.error ? (
            <p data-ref="validate-panel-result-error" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
              {result.error}
            </p>
          ) : null}
          {resultLines.length > 0 ? (
            <pre
              data-ref="validate-panel-result-pre"
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
      {manifestLoading ? (
        <div data-ref="validate-panel-manifest-loading" style={{ marginBottom: 16 }}>
          <Spinner label="Loading manifest…" />
        </div>
      ) : null}
      {manifestError ? (
        <p data-ref="validate-panel-manifest-error" role="alert" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)' }}>
          Could not load manifest: {manifestError}
        </p>
      ) : null}
      {manifest ? (
        <div data-ref="validate-panel-manifest-result" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h3 data-ref="validate-panel-manifest-heading" style={{ fontSize: 'var(--font-size-md)', margin: 0 }}>Manifest preview</h3>
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
            Secrets are redacted from the rendered manifest.
          </p>
          {manifestWarnings.length > 0 ? (
            <div data-ref="validate-panel-manifest-warnings">
              <h3 data-ref="validate-panel-manifest-warnings-heading" style={{ fontSize: 'var(--font-size-md)', marginBottom: 8 }}>Warnings</h3>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 'var(--font-size-md)' }}>
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
            <pre data-ref="validate-panel-manifest-pre" style={{ ...preStyle, border: 'none', backgroundColor: 'transparent' }}>{manifest.manifest}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
