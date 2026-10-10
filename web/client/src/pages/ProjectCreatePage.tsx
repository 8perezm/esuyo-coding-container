import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import type { Project } from '../lib/projects';
import { Button, Card, Input, Label, PageHeader } from '../components/ui';

interface CreateProjectResponse {
  project: Project;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function ProjectCreatePage() {
  const { setActiveId, refresh } = useProjects();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmedName = name.trim();
    const trimmedPath = configPath.trim();
    if (!trimmedName || !trimmedPath) {
      setFormError('Name and config path are both required.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post<CreateProjectResponse>('/api/projects', {
        name: trimmedName,
        configPath: trimmedPath,
      });
      setActiveId(res.project.id);
      await refresh();
      navigate('/projects');
    } catch (err) {
      setFormError(errMsg(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div data-ref="page-project-create">
      <PageHeader
        title="Add project"
        description="Point it at a config file that already exists on the server."
        actions={
          <Link to="/projects" className="btn btn-secondary" data-ref="page-project-create-back">
            Back to projects
          </Link>
        }
      />

      <Card style={{ maxWidth: 640 }} data-ref="page-project-create-form-card">
        {formError && (
          <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)', marginTop: 0 }} data-ref="page-project-create-error">
            {formError}
          </p>
        )}
        <form onSubmit={(e) => void onCreate(e)} style={{ display: 'grid', gap: 12, maxWidth: 520 }} data-ref="page-project-create-form">
          <div>
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoComplete="off"
              data-ref="page-project-create-input-name"
            />
          </div>
          <div>
            <Label htmlFor="project-config-path">Config path</Label>
            <Input
              id="project-config-path"
              value={configPath}
              onChange={(e) => setConfigPath(e.target.value)}
              placeholder="/data/projects/my-project/config.yaml"
              autoComplete="off"
              spellCheck={false}
              data-ref="page-project-create-input-config-path"
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }} data-ref="page-project-create-actions">
            <Button type="submit" disabled={creating} data-ref="page-project-create-submit">
              <Plus size={16} aria-hidden="true" /> {creating ? 'Adding…' : 'Add project'}
            </Button>
            <Link to="/projects" className="btn btn-secondary" data-ref="page-project-create-cancel">
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
