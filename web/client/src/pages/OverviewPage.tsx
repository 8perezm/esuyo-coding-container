import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { Badge, Card, EmptyState, PageHeader, Spinner, Table, TableContainer, TBody, TD, TH, THead, TR } from '../components/ui';

interface Project {
  id: string;
  name?: string;
  configPath?: string;
}

interface ProjectsResponse {
  projects?: Project[];
}

interface SystemStateResponse {
  ok: boolean;
  state?: {
    current?: string;
    previous?: string | null;
    maxEver?: number;
    keep?: number;
  };
  image?: string;
  error?: string;
}

interface SshListResponse {
  entries?: Array<{ alias: string }>;
}

interface Job {
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
  jobs?: Job[];
}

function jobTone(status: string): 'default' | 'accent' | 'violet' {
  if (status === 'running') return 'accent';
  if (status === 'error') return 'violet';
  return 'default';
}

function formatStartedAt(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function OverviewPage() {
  const [loaded, setLoaded] = useState(false);
  const [projectsCount, setProjectsCount] = useState<number | null>(null);
  const [systemVersion, setSystemVersion] = useState<string | null>(null);
  const [sshCount, setSshCount] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [projectsRes, sshRes, jobsRes] = await Promise.allSettled([
        api.get<ProjectsResponse | Project[]>('/api/projects'),
        api.get<SshListResponse>('/api/ssh-list'),
        api.get<JobsResponse | Job[]>('/api/jobs'),
      ]);
      if (cancelled) return;

      let firstProjectId: string | null = null;
      if (projectsRes.status === 'fulfilled') {
        const data = projectsRes.value;
        const projects = Array.isArray(data) ? data : (data.projects ?? []);
        setProjectsCount(projects.length);
        firstProjectId = projects[0]?.id ?? null;
      }

      if (sshRes.status === 'fulfilled') {
        setSshCount(sshRes.value.entries?.length ?? 0);
      }

      if (jobsRes.status === 'fulfilled') {
        const data = jobsRes.value;
        setJobs(Array.isArray(data) ? data : (data.jobs ?? []));
      } else {
        const err = jobsRes.reason;
        if (err instanceof ApiError && err.status === 404) {
          setJobs([]);
        } else {
          setJobs([]);
          setJobsError(err instanceof Error ? err.message : 'Failed to load jobs');
        }
      }

      if (firstProjectId) {
        try {
          const sys = await api.get<SystemStateResponse>(
            `/api/system/state?projectId=${encodeURIComponent(firstProjectId)}`,
          );
          if (!cancelled) setSystemVersion(sys.ok && sys.state?.current ? String(sys.state.current) : null);
        } catch {
          if (!cancelled) setSystemVersion(null);
        }
      }

      if (!cancelled) setLoaded(true);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const runningJobs = jobs?.filter((job) => job.status === 'running').length ?? null;

  const stats = [
    {
      label: 'Projects',
      to: '/projects',
      hint: 'Managed containers',
      value: !loaded ? '…' : projectsCount === null ? '—' : String(projectsCount),
    },
    {
      label: 'System version',
      to: '/system',
      hint: 'Current image tag',
      value: !loaded ? '…' : (systemVersion ?? '—'),
    },
    {
      label: 'SSH aliases',
      to: '/ssh-keys',
      hint: 'Configured hosts',
      value: !loaded ? '…' : sshCount === null ? '—' : String(sshCount),
    },
    {
      label: 'Jobs',
      to: '/jobs',
      hint: 'Running / total',
      value: !loaded || jobs === null || runningJobs === null ? '…' : `${runningJobs} / ${jobs.length}`,
    },
  ];

  return (
    <div>
      <PageHeader title="Overview" description="Cluster coding environments at a glance." />
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        {stats.map((s) => (
          <Card key={s.label}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>{s.label}</p>
            <p style={{ margin: '4px 0', fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700 }}>
              <Link to={s.to}>{s.value}</Link>
            </p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>{s.hint}</p>
          </Card>
        ))}
      </div>

      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Recent jobs</h2>
      {!loaded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Loading jobs">
          <div className="skeleton" style={{ height: 48 }} />
          <div className="skeleton" style={{ height: 48 }} />
          <div className="skeleton" style={{ height: 48 }} />
          <Spinner label="Loading jobs…" />
        </div>
      ) : jobsError ? (
        <Card>
          <p role="alert" style={{ margin: 0, fontSize: 14 }}>
            Could not load jobs: {jobsError}
          </p>
        </Card>
      ) : jobs === null || jobs.length === 0 ? (
        <EmptyState
          title="No jobs yet"
          description="Background jobs will appear here once they start running."
          action={<Link to="/jobs">View jobs</Link>}
        />
      ) : (
        <TableContainer>
          <Table>
            <THead>
              <TR>
                <TH>ID</TH>
                <TH>Op</TH>
                <TH>Status</TH>
                <TH>Started</TH>
              </TR>
            </THead>
            <TBody>
              {jobs.slice(0, 8).map((job) => (
                <TR key={job.id}>
                  <TD>
                    <Link
                      to="/jobs"
                      title={job.id}
                      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    >
                      {job.id.slice(0, 8)}
                    </Link>
                  </TD>
                  <TD>{job.op}</TD>
                  <TD>
                    <Badge tone={jobTone(job.status)}>{job.status}</Badge>
                  </TD>
                  <TD>{formatStartedAt(job.startedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
