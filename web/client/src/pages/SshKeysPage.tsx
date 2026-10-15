import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import { JobOutput } from '../components/JobOutput';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
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

interface SshEntry {
  alias: string;
  host: string | null;
  port: number | null;
  user: string | null;
  identityFile: string | null;
}

interface SshListResponse {
  entries?: SshEntry[];
}

interface KeyInfo {
  private: string;
  public: string;
  image: string;
  publicKey: string;
  preview: string;
  fingerprint: string;
}

interface JobInfo {
  id: string;
  op?: string;
  status?: string;
  startedAt?: string;
}

const monoStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

const fieldLabelStyle = {
  margin: '0 0 4px',
  fontSize: 'var(--font-size-sm)',
  color: 'var(--text-muted)',
  fontWeight: 600,
} as const;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

function monoCell(value: string | number | null | undefined): ReactNode {
  return <span style={monoStyle}>{value ?? '—'}</span>;
}

export function SshKeysPage() {
  const { projects } = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default to the first project once loaded; follow deletions.
  useEffect(() => {
    if (projects.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !projects.some((p) => p.id === selectedId)) {
      setSelectedId(projects[0].id);
    }
  }, [projects, selectedId]);

  const [entries, setEntries] = useState<SshEntry[] | null>(null);
  const [aliasesLoading, setAliasesLoading] = useState(false);
  const [aliasesError, setAliasesError] = useState<string | null>(null);

  const [dryRun, setDryRun] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshJob, setRefreshJob] = useState<JobInfo | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [key, setKey] = useState<KeyInfo | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const [rotating, setRotating] = useState(false);
  const [rotateJob, setRotateJob] = useState<JobInfo | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);

  const loadAliases = useCallback(async () => {
    setAliasesLoading(true);
    setAliasesError(null);
    try {
      const data = await api.get<SshListResponse>('/api/ssh-list');
      setEntries(data.entries ?? []);
    } catch (err) {
      setEntries(null);
      setAliasesError(errMessage(err));
    } finally {
      setAliasesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAliases();
  }, [loadAliases]);

  useEffect(() => {
    let cancelled = false;
    setRotateJob(null);
    setRotateError(null);
    if (!selectedId) {
      setKey(null);
      setKeyError(null);
      setKeyLoading(false);
      return;
    }
    setKeyLoading(true);
    setKeyError(null);
    api
      .get<KeyInfo>(`/api/key?projectId=${encodeURIComponent(selectedId)}`)
      .then((data) => {
        if (!cancelled) setKey(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setKey(null);
          setKeyError(errMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setKeyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshJob(null);
    try {
      const job = await api.post<JobInfo>('/api/jobs', {
        op: 'list-update',
        args: { dryRun },
      });
      setRefreshJob(job);
    } catch (err) {
      setRefreshError(errMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRotate() {
    if (!selectedId) return;
    setRotating(true);
    setRotateError(null);
    setRotateJob(null);
    try {
      const job = await api.post<JobInfo>('/api/jobs', {
        op: 'key-rotate',
        projectId: selectedId,
        args: { force: true },
      });
      setRotateJob(job);
    } catch (err) {
      setRotateError(errMessage(err));
    } finally {
      setRotating(false);
      setShowRotateConfirm(false);
    }
  }

  return (
    <div data-ref="page-ssh-keys">
      <PageHeader
        title="SSH & Keys"
        description="SSH aliases, project keys, and key rotation."
        actions={
          <Button data-ref="page-ssh-keys-refresh-aliases" variant="secondary" onClick={() => void loadAliases()} disabled={aliasesLoading}>
            {aliasesLoading ? 'Refreshing…' : 'Refresh aliases'}
          </Button>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Card data-ref="page-ssh-keys-aliases-card">
          <h2 data-ref="page-ssh-keys-heading-aliases" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 16 }}>SSH aliases</h2>
          {aliasesError ? (
            <p data-ref="page-ssh-keys-alert-aliases" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
              Could not load SSH aliases: {aliasesError}
            </p>
          ) : aliasesLoading && entries === null ? (
            <Spinner label="Loading SSH aliases…" />
          ) : entries !== null && entries.length === 0 ? (
            <EmptyState title="No SSH aliases" description="Deploy a project to register one." />
          ) : entries ? (
            <TableContainer data-ref="page-ssh-keys-table-container-aliases">
              <Table data-ref="page-ssh-keys-table-aliases">
                <THead>
                  <TR>
                    <TH>Alias</TH>
                    <TH>Host</TH>
                    <TH>Port</TH>
                    <TH>User</TH>
                    <TH>IdentityFile</TH>
                  </TR>
                </THead>
                <TBody>
                  {entries.map((entry) => (
                    <TR key={entry.alias}>
                      <TD>{entry.alias}</TD>
                      <TD>{monoCell(entry.host)}</TD>
                      <TD>{monoCell(entry.port)}</TD>
                      <TD>{monoCell(entry.user)}</TD>
                      <TD>{monoCell(entry.identityFile)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableContainer>
          ) : null}
        </Card>

        <Card data-ref="page-ssh-keys-refresh-card">
          <h2 data-ref="page-ssh-keys-heading-refresh" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 8 }}>Refresh aliases</h2>
          <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
            Node addresses can go stale after cluster node changes. Refresh the SSH alias list to pick up the
            current IPs.
          </p>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-md)', marginBottom: 16, cursor: 'pointer' }}
          >
            <input
              data-ref="page-ssh-keys-dryrun-field"
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
            Dry run (preview changes without applying them)
          </label>
          <Button data-ref="page-ssh-keys-submit-refresh" onClick={() => void handleRefresh()} disabled={refreshing}>
            {refreshing ? 'Starting…' : 'Update alias list'}
          </Button>
          {refreshJob ? (
            <JobOutput key={refreshJob.id} job={{ id: refreshJob.id, op: 'list-update', status: refreshJob.status ?? 'running' }} dataRef="page-ssh-keys-refresh-job" />
          ) : null}
          {refreshError ? (
            <p data-ref="page-ssh-keys-alert-refresh" role="alert" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)' }}>
              Could not start the alias refresh: {refreshError}
            </p>
          ) : null}
          {refreshJob ? (
            <p data-ref="page-ssh-keys-status-refresh" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
              Reload the aliases table above once the job finishes. Full history on the{' '}
              <Link data-ref="page-ssh-keys-link-jobs-refresh" to="/jobs">jobs page</Link>.
            </p>
          ) : null}
        </Card>

        <Card data-ref="page-ssh-keys-project-card">
          <h2 data-ref="page-ssh-keys-heading-project" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 16 }}>Project key</h2>
          <div style={{ marginBottom: 16 }}>
            <ProjectPicker value={selectedId} onChange={setSelectedId} />
          </div>
          {!selectedId ? (
            <p style={{ margin: 0, fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
              Select a project to view its SSH key.
            </p>
          ) : keyLoading ? (
            <Spinner label="Loading key…" />
          ) : keyError ? (
            <p data-ref="page-ssh-keys-alert-key" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
              Could not load key: {keyError}
            </p>
          ) : key ? (
            <div data-ref="page-ssh-keys-key-details" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <p style={fieldLabelStyle}>Private key path</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 'var(--font-size-md)', overflowWrap: 'anywhere' }}>{key.private}</p>
                </div>
                <div>
                  <p style={fieldLabelStyle}>Public key path</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 'var(--font-size-md)', overflowWrap: 'anywhere' }}>{key.public}</p>
                </div>
                <div>
                  <p style={fieldLabelStyle}>Resolved image</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 'var(--font-size-md)', overflowWrap: 'anywhere' }}>{key.image}</p>
                </div>
                <div>
                  <p style={fieldLabelStyle}>Fingerprint</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 'var(--font-size-md)' }}>{key.fingerprint}</p>
                </div>
              </div>
              <div>
                <p style={fieldLabelStyle}>Public key</p>
                <pre
                  data-ref="page-ssh-keys-publickey-block"
                  style={{
                    ...monoStyle,
                    margin: 0,
                    padding: 12,
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-surface)',
                    fontSize: 'var(--font-size-sm)',
                    whiteSpace: 'pre',
                    overflow: 'auto',
                    maxHeight: 240,
                  }}
                >
                  {key.publicKey}
                </pre>
              </div>
              <div>
                <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}>
                  Warning: rotating the key invalidates existing access. Redeploy the project afterwards so the new
                  key is distributed.
                </p>
                <Button data-ref="page-ssh-keys-submit-rotate" variant="secondary" onClick={() => setShowRotateConfirm(true)} disabled={rotating}>
                  {rotating ? 'Starting…' : 'Rotate key'}
                </Button>
                {rotateJob ? (
                  <JobOutput key={rotateJob.id} job={{ id: rotateJob.id, op: 'key-rotate', status: rotateJob.status ?? 'running' }} dataRef="page-ssh-keys-rotate-job" />
                ) : null}
                {rotateError ? (
                  <p data-ref="page-ssh-keys-alert-rotate" role="alert" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)' }}>
                    Could not start key rotation: {rotateError}
                  </p>
                ) : null}
                {rotateJob ? (
                  <p data-ref="page-ssh-keys-status-rotate" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
                    The key details above may be stale until the job finishes; redeploy once it completes. Full history on the{' '}
                    <Link data-ref="page-ssh-keys-link-jobs-rotate" to="/jobs">jobs page</Link>.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      {showRotateConfirm && (
        <ConfirmDialog
          title="Rotate SSH key?"
          confirmLabel="Rotate key"
          onCancel={() => setShowRotateConfirm(false)}
          onConfirm={() => void handleRotate()}
          confirming={rotating}
        >
          <p style={{ margin: 0 }}>
            Existing access will stop working until you redeploy with the new key. Redeploy the project
            afterwards so the new key is distributed.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
