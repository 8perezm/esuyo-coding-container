import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { jobTone } from '../pages/job-helpers';
import { Badge, Spinner } from './ui';

export interface InlineJob {
  id: string;
  op?: string;
  status?: string;
  startedAt?: string;
}

interface JobDetail extends InlineJob {
  exitCode?: number | null;
  argv?: string[];
  logs?: string;
  logTail?: string;
  finishedAt?: string | null;
}

interface JobDetailResponse {
  job: JobDetail;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function useJobDetail(jobId: string | null) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const data = await api.get<JobDetailResponse>(
          `/api/jobs/${encodeURIComponent(jobId as string)}`,
        );
        if (!cancelled) {
          setDetail(data.job);
          setDetailError(null);
        }
      } catch (err) {
        if (!cancelled) setDetailError(errMsg(err));
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId]);

  return { detail, detailError };
}

/**
 * Live job output rendered directly underneath the button that started it,
 * so users never have to visit /jobs to see what happened.
 *
 * Polls GET /api/jobs/:id every 2s and renders status + argv + logs inline.
 * With `compact`, only the started line + status badge render (no logs,
 * footer, or exit code) — for rows where inline output is unwanted.
 */
export function JobOutput({
  job,
  onFinished,
  dataRef,
  compact = false,
}: {
  job: InlineJob;
  onFinished?: () => void;
  dataRef?: string;
  compact?: boolean;
}) {
  const { detail, detailError } = useJobDetail(job.id);
  const [notified, setNotified] = useState(false);

  const live = detail ?? job;
  const running = live.status === 'running';
  const logs = (detail?.logs ?? detail?.logTail ?? '').trim();
  const liveExit = (live as Partial<JobDetail>).exitCode;
  const prefix = dataRef ?? 'job-output';

  useEffect(() => {
    if (detail && detail.status !== 'running' && !notified) {
      setNotified(true);
      onFinished?.();
    }
  }, [detail, notified, onFinished]);

  return (
    <div data-ref={prefix} style={{ marginTop: 12 }}>
      <p data-ref={`${prefix}-status`} style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }}>
        {job.op ? `${job.op} started: ` : 'Job started: '}
        <code data-ref={`${prefix}-id`}>{job.id}</code> ({job.status}) —{' '}
        <Link data-ref={`${prefix}-jobs-link`} to="/jobs">View jobs</Link>
      </p>
      <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)' }}>
        <Badge tone={jobTone(live.status ?? '')}>{live.status}</Badge>
        {!compact && running ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>running, refreshing…</span>
        ) : !compact && liveExit !== null && liveExit !== undefined ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>exit {liveExit}</span>
        ) : null}
      </p>
      {compact ? null : (
        <>
          {detailError ? (
            <p data-ref={`${prefix}-error`} role="alert" style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }}>
              Could not load job output: {detailError}
            </p>
          ) : !detail ? (
            <Spinner label="Loading job output…" />
          ) : (
            <pre
              data-ref={`${prefix}-logs`}
              aria-label="Job logs"
              style={{
                margin: 0,
                maxHeight: 400,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 'var(--font-size-sm)',
                lineHeight: 1.5,
                padding: 12,
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
              }}
            >
              {logs || '(no output yet)'}
            </pre>
          )}
          <p data-ref={`${prefix}-footer`} style={{ margin: '8px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
            Status: {live.status}
          </p>
        </>
      )}
    </div>
  );
}
