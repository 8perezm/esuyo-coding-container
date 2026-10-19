import { Fragment, useEffect, useState } from 'react';
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
          if (!prev) return prev;
          if (list.some((j) => j.id === prev)) return prev;
          return null;
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
      setDetailError(null);
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
    <div data-ref="page-jobs">
      <PageHeader title="Jobs" description="Background tasks and their status history." />

      {listError ? (
        <Card data-ref="page-jobs-list-error-card">
          <p data-ref="page-jobs-list-error" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
            Could not load jobs: {listError}
          </p>
        </Card>
      ) : jobs === null ? (
        <div data-ref="page-jobs-loading" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Loading jobs">
          <div data-ref="page-jobs-loading-skeleton-1" className="skeleton" style={{ height: 48 }} />
          <div data-ref="page-jobs-loading-skeleton-2" className="skeleton" style={{ height: 48 }} />
          <div data-ref="page-jobs-loading-skeleton-3" className="skeleton" style={{ height: 48 }} />
          <Spinner label="Loading jobs…" />
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          title="No jobs yet"
          description="Operations like create, deploy, and system create run here so long output never blocks the UI."
        />
      ) : (
        <TableContainer data-ref="page-jobs-table-container">
          <Table data-ref="page-jobs-table">
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
              {jobs.map((job) => {
                const expanded = job.id === selectedId;
                return (
                  <Fragment key={job.id}>
                    <TR style={expanded ? { backgroundColor: 'var(--bg-surface)' } : undefined}>
                      <TD>
                        <button
                          data-ref="page-jobs-select-button"
                          type="button"
                          onClick={() => setSelectedId((prev) => (prev === job.id ? null : job.id))}
                          title={job.id}
                          aria-label={`${expanded ? 'Hide' : 'Show'} job ${job.id}`}
                          aria-expanded={expanded}
                          aria-controls={`page-jobs-detail-${job.id}`}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            minHeight: 44,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: 'var(--font-size-sm)',
                            color: 'var(--accent, #2563eb)',
                            textDecoration: 'underline',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <span aria-hidden="true" style={{ display: 'inline-block', width: '1.2em' }}>
                            {expanded ? '▾' : '▸'}
                          </span>{' '}
                          {shortId(job.id)}
                        </button>
                      </TD>
                      <TD>{job.op}</TD>
                      <TD style={{ fontSize: 'var(--font-size-sm)' }}>{job.projectId ? shortId(job.projectId) : '—'}</TD>
                      <TD>
                        <Badge tone={jobTone(job.status)}>{job.status}</Badge>
                      </TD>
                      <TD>{formatDateTime(job.startedAt)}</TD>
                      <TD>{formatDateTime(job.finishedAt)}</TD>
                    </TR>
                    {expanded && (
                      <TR data-ref="page-jobs-detail-row" style={{ backgroundColor: 'var(--bg-surface)' }}>
                        <TD colSpan={6} style={{ padding: '16px' }}>
                          <div id={`page-jobs-detail-${job.id}`}>
                            <h2 data-ref="page-jobs-detail-heading" style={{ fontSize: 'var(--font-size-xl)', margin: '0 0 8px' }}>
                              Job <code style={{ fontSize: 'var(--font-size-sm)' }}>{shortId(selectedId as string)}</code>
                              {running && (
                                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}> — running, refreshing…</span>
                              )}
                            </h2>
                            {detailError ? (
                              <p data-ref="page-jobs-detail-error" role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
                                Could not load job detail: {detailError}
                              </p>
                            ) : !detail ? (
                              <Spinner label="Loading job detail…" />
                            ) : (
                              <div>
                                <pre
                                  data-ref="page-jobs-detail-logs"
                                  aria-label="Job logs"
                                  style={{
                                    margin: 0,
                                    maxHeight: 500,
                                    overflow: 'auto',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    fontSize: 'var(--font-size-sm)',
                                    lineHeight: 1.5,
                                    padding: 12,
                                    backgroundColor: 'var(--bg-card)',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: 8,
                                  }}
                                >
                                  {(detail.logs ?? detail.logTail ?? '').trim() || '(no output yet)'}
                                </pre>
                                <p data-ref="page-jobs-detail-status" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
                                  Status: {detail.status}
                                  {detail.exitCode !== null && detail.exitCode !== undefined
                                    ? ` (exit ${detail.exitCode})`
                                    : ''}
                                </p>
                              </div>
                            )}
                          </div>
                        </TD>
                      </TR>
                    )}
                  </Fragment>
                );
              })}
            </TBody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
