import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ProjectPicker, useProjects } from '../lib/projects';
import {
  Badge,
  Button,
  Card,
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
  fontSize: 13,
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
  const { activeId: activeProjectId } = useProjects();

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
    if (!activeProjectId) {
      setKey(null);
      setKeyError(null);
      setKeyLoading(false);
      return;
    }
    setKeyLoading(true);
    setKeyError(null);
    api
      .get<KeyInfo>(`/api/key?projectId=${encodeURIComponent(activeProjectId)}`)
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
  }, [activeProjectId]);

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
    if (!activeProjectId) return;
    const confirmed = window.confirm(
      'Rotate the SSH key for this project? Existing access will stop working until you redeploy with the new key.',
    );
    if (!confirmed) return;
    setRotating(true);
    setRotateError(null);
    setRotateJob(null);
    try {
      const job = await api.post<JobInfo>('/api/jobs', {
        op: 'key-rotate',
        projectId: activeProjectId,
        args: { force: true },
      });
      setRotateJob(job);
    } catch (err) {
      setRotateError(errMessage(err));
    } finally {
      setRotating(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="SSH & Keys"
        description="SSH aliases, project keys, and key rotation."
        actions={
          <Button variant="secondary" onClick={() => void loadAliases()} disabled={aliasesLoading}>
            {aliasesLoading ? 'Refreshing…' : 'Refresh aliases'}
          </Button>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Card>
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>SSH aliases</h2>
          {aliasesError ? (
            <p role="alert" style={{ margin: 0, fontSize: 14 }}>
              Could not load SSH aliases: {aliasesError}
            </p>
          ) : aliasesLoading && entries === null ? (
            <Spinner label="Loading SSH aliases…" />
          ) : entries !== null && entries.length === 0 ? (
            <EmptyState title="No SSH aliases" description="Deploy a project to register one." />
          ) : entries ? (
            <TableContainer>
              <Table>
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

        <Card>
          <h2 style={{ fontSize: 18, marginBottom: 8 }}>Refresh aliases</h2>
          <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
            Node addresses can go stale after cluster node changes. Refresh the SSH alias list to pick up the
            current IPs.
          </p>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 16, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
            Dry run (preview changes without applying them)
          </label>
          <Button onClick={() => void handleRefresh()} disabled={refreshing}>
            {refreshing ? 'Starting…' : 'Update alias list'}
          </Button>
          {refreshError ? (
            <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
              Could not start the alias refresh: {refreshError}
            </p>
          ) : null}
          {refreshJob ? (
            <p style={{ margin: '12px 0 0', fontSize: 14 }}>
              Update job started: <span style={monoStyle}>{refreshJob.id}</span>{' '}
              <Badge tone="accent">{refreshJob.status ?? 'running'}</Badge> — follow its progress on the{' '}
              <Link to="/jobs">jobs page</Link>, then reload the aliases table above once it finishes.
            </p>
          ) : null}
        </Card>

        <Card>
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Project key</h2>
          <div style={{ marginBottom: 16 }}>
            <ProjectPicker />
          </div>
          {!activeProjectId ? (
            <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
              Select a project to view its SSH key.
            </p>
          ) : keyLoading ? (
            <Spinner label="Loading key…" />
          ) : keyError ? (
            <p role="alert" style={{ margin: 0, fontSize: 14 }}>
              Could not load key: {keyError}
            </p>
          ) : key ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <p style={fieldLabelStyle}>Private key path</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 14, overflowWrap: 'anywhere' }}>{key.private}</p>
                </div>
                <div>
                  <p style={fieldLabelStyle}>Public key path</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 14, overflowWrap: 'anywhere' }}>{key.public}</p>
                </div>
                <div>
                  <p style={fieldLabelStyle}>Resolved image</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 14, overflowWrap: 'anywhere' }}>{key.image}</p>
                </div>
                <div>
                  <p style={fieldLabelStyle}>Fingerprint</p>
                  <p style={{ ...monoStyle, margin: 0, fontSize: 14 }}>{key.fingerprint}</p>
                </div>
              </div>
              <div>
                <p style={fieldLabelStyle}>Public key</p>
                <pre
                  style={{
                    ...monoStyle,
                    margin: 0,
                    padding: 12,
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--bg-surface)',
                    fontSize: 13,
                    whiteSpace: 'pre',
                    overflow: 'auto',
                    maxHeight: 240,
                  }}
                >
                  {key.publicKey}
                </pre>
              </div>
              <div>
                <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text-muted)' }}>
                  Warning: rotating the key invalidates existing access. Redeploy the project afterwards so the new
                  key is distributed.
                </p>
                <Button variant="secondary" onClick={() => void handleRotate()} disabled={rotating}>
                  {rotating ? 'Starting…' : 'Rotate key'}
                </Button>
                {rotateError ? (
                  <p role="alert" style={{ margin: '12px 0 0', fontSize: 14 }}>
                    Could not start key rotation: {rotateError}
                  </p>
                ) : null}
                {rotateJob ? (
                  <p style={{ margin: '12px 0 0', fontSize: 14 }}>
                    Rotation job started: <span style={monoStyle}>{rotateJob.id}</span>{' '}
                    <Badge tone="accent">{rotateJob.status ?? 'running'}</Badge> — follow its progress on the{' '}
                    <Link to="/jobs">jobs page</Link>. The key details above may be stale until the job finishes;
                    redeploy once it completes.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
