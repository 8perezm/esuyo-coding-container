import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { formatDateTime, jobTone, shortId } from './job-helpers';
import {
  Badge,
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

interface JobSummary {
  id: string;
  op: string;
  projectId?: string | null;
  argv?: string[];
  status: string;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string | null;
  logTail?: string;
}

interface JobsResponse {
  jobs?: JobSummary[];
}

interface JobDetail extends JobSummary {
  logs?: string;
}

interface JobDetailResponse {
  job: JobDetail;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.get<JobsResponse | JobSummary[]>('/api/jobs');
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data.jobs ?? []);
        setJobs(list);
        setListError(null);
        setSelectedId((prev) => {
          if (prev && list.some((j) => j.id === prev)) return prev;
          return list.length > 0 ? list[0].id : null;
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setJobs([]);
        } else {
          setListError(errMsg(err));
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    async function loadDetail() {
      try {
        const data = await api.get<JobDetailResponse>(
          `/api/jobs/${encodeURIComponent(selectedId as string)}`,
        );
        if (!cancelled) {
          setDetail(data.job);
          setDetailError(null);
        }
      } catch (err) {
        if (!cancelled) setDetailError(errMsg(err));
      }
    }
    void loadDetail();
    const timer = window.setInterval(() => void loadDetail(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  const running = detail?.status === 'running';

  return (
    <div>
      <PageHeader title="Jobs" description="Background tasks and their status history." />

      {listError ? (
        <Card>
          <p role="alert" style={{ margin: 0, fontSize: 14 }}>
            Could not load jobs: {listError}
          </p>
        </Card>
      ) : jobs === null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Loading jobs">
          <div className="skeleton" style={{ height: 48 }} />
          <div className="skeleton" style={{ height: 48 }} />
          <div className="skeleton" style={{ height: 48 }} />
          <Spinner label="Loading jobs…" />
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No jobs yet"
          description="Operations like create, deploy, and system create run here so long CLI output never blocks the UI."
        />
      ) : (
        <TableContainer>
          <Table>
            <THead>
              <TR>
                <TH>ID</TH>
                <TH>Op</TH>
                <TH>Project</TH>
                <TH>Status</TH>
                <TH>Started</TH>
                <TH>Finished</TH>
              </TR>
            </THead>
            <TBody>
              {jobs.map((job) => (
                <TR key={job.id} style={job.id === selectedId ? { backgroundColor: 'var(--bg-card)' } : undefined}>
                  <TD>
                    <button
                      type="button"
                      onClick={() => setSelectedId(job.id)}
                      title={job.id}
                      aria-label={`Show job ${job.id}`}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        minHeight: 44,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 13,
                        color: 'var(--accent, #2563eb)',
                        textDecoration: 'underline',
                      }}
                    >
                      {shortId(job.id)}
                    </button>
                  </TD>
                  <TD>{job.op}</TD>
                  <TD style={{ fontSize: 13 }}>{job.projectId ? shortId(job.projectId) : '—'}</TD>
                  <TD>
                    <Badge tone={jobTone(job.status)}>{job.status}</Badge>
                  </TD>
                  <TD>{formatDateTime(job.startedAt)}</TD>
                  <TD>{formatDateTime(job.finishedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableContainer>
      )}

      {selectedId && (
        <Card style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>
            Job <code style={{ fontSize: 13 }}>{shortId(selectedId)}</code>
            {running && (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}> — running, refreshing…</span>
            )}
          </h2>
          {detailError ? (
            <p role="alert" style={{ margin: 0, fontSize: 14 }}>
              Could not load job detail: {detailError}
            </p>
          ) : !detail ? (
            <Spinner label="Loading job detail…" />
          ) : (
            <div>
              {detail.argv && detail.argv.length > 0 && (
                <p style={{ margin: '0 0 12px', fontSize: 13 }}>
                  <code
                    style={{
                      display: 'block',
                      overflowX: 'auto',
                      whiteSpace: 'pre',
                      padding: 8,
                      backgroundColor: 'var(--bg-surface)',
                      borderRadius: 4,
                    }}
                  >
                    $ node src/index.js {detail.argv.join(' ')}
                  </code>
                </p>
              )}
              <pre
                aria-label="Job logs"
                style={{
                  margin: 0,
                  maxHeight: 500,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  lineHeight: 1.5,
                  padding: 12,
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                }}
              >
                {(detail.logs ?? detail.logTail ?? '').trim() || '(no output yet)'}
              </pre>
              <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                Status: {detail.status}
                {detail.exitCode !== null && detail.exitCode !== undefined
                  ? ` (exit ${detail.exitCode})`
                  : ''}
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
