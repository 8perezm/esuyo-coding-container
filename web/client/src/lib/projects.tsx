import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import { EmptyState, Label, Spinner } from '../components/ui';

export interface Project {
  id: string;
  name: string;
  configPath: string;
}

interface ProjectsResponse {
  projects: Project[];
}

interface ProjectsContextValue {
  projects: Project[];
  refresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<ProjectsResponse>('/api/projects');
      setProjects(data.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<ProjectsContextValue>(
    () => ({ projects, refresh, loading, error }),
    [projects, refresh, loading, error],
  );

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjects(): ProjectsContextValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error('useProjects must be used inside <ProjectsProvider>');
  return ctx;
}

interface ProjectPickerProps {
  id?: string;
  label?: string;
  value: string | null;
  onChange: (id: string | null) => void;
}

export function ProjectPicker({ id = 'project-picker', label = 'Project', value, onChange }: ProjectPickerProps) {
  const { projects, loading, error } = useProjects();

  if (loading) return <Spinner label="Loading projects…" />;
  if (error) {
    return (
      <p role="alert" style={{ margin: 0, fontSize: 'var(--font-size-md)' }}>
        Could not load projects: {error}
      </p>
    );
  }
  if (projects.length === 0) {
    return <EmptyState title="No projects yet" description="Add a project on the Projects page first." />;
  }

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="input"
        style={{ minHeight: 44, maxWidth: 480 }}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
