import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { jobTone } from '../pages/job-helpers';
import { Badge } from './ui';

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
 * Compact live job status rendered directly underneath the button that
 * started it. Shows the started line plus a live status badge (polled every
 * 2s) and a deep-link to /jobs for full logs — no inline log output, so the
 * trigger area never expands with a log box.
 *
 * Polls GET /api/jobs/:id every 2s and renders status + exit code inline.
 * The `compact` prop is accepted for backwards compatibility and ignored:
 * output is always compact.
 */
export function JobOutput({
  job,
  onFinished,
  dataRef,
  compact = true,
}: {
  job: InlineJob;
  onFinished?: () => void;
  dataRef?: string;
  compact?: boolean;
}) {
  void compact;
  const { detail } = useJobDetail(job.id);
  const [notified, setNotified] = useState(false);

  const live = detail ?? job;
  const running = live.status === 'running';
  const liveExit = (live as Partial<JobDetail>).exitCode;
  const prefix = dataRef ?? 'job-output';
  const jobsTo = `/jobs?job=${encodeURIComponent(job.id)}`;

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
        <Link data-ref={`${prefix}-jobs-link`} to={jobsTo}>View jobs</Link>
      </p>
      <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)' }}>
        <Badge tone={jobTone(live.status ?? '')}>{live.status}</Badge>
        {running ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>running, refreshing…</span>
        ) : liveExit !== null && liveExit !== undefined ? (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>exit {liveExit}</span>
        ) : null}
      </p>
    </div>
  );
}
