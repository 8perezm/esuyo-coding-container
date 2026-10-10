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
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  refresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

const STORAGE_KEY = 'activeProjectId';

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — active project just won't persist */
  }
}

function pickActive(list: Project[], preferred: string | null): string | null {
  if (preferred && list.some((p) => p.id === preferred)) return preferred;
  const stored = readStoredId();
  if (stored && list.some((p) => p.id === stored)) return stored;
  return list.length > 0 ? list[0].id : null;
}

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(() => readStoredId());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<ProjectsResponse>('/api/projects');
      const list = data.projects ?? [];
      setProjects(list);
      setActiveIdState((prev) => {
        const next = pickActive(list, prev);
        persistId(next);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setActiveId = useCallback((id: string | null) => {
    persistId(id);
    setActiveIdState(id);
  }, []);

  const value = useMemo<ProjectsContextValue>(
    () => ({ projects, activeId, setActiveId, refresh, loading, error }),
    [projects, activeId, setActiveId, refresh, loading, error],
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
}

export function ProjectPicker({ id = 'project-picker', label = 'Project' }: ProjectPickerProps) {
  const { projects, activeId, setActiveId, loading, error } = useProjects();

  if (loading) return <Spinner label="Loading projects…" />;
  if (error) {
    return (
      <p role="alert" style={{ margin: 0, fontSize: 14 }}>
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
        value={activeId ?? ''}
        onChange={(e) => setActiveId(e.target.value || null)}
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
