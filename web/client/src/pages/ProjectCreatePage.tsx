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
  const { refresh } = useProjects();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Name is required.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post<CreateProjectResponse>('/api/projects', {
        name: trimmedName,
      });
      await refresh();
      navigate(`/projects/${encodeURIComponent(res.project.id)}/edit`);
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
        description="Give it a name — its config file will live in the system folder until you change it in Settings."
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
            <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="page-project-create-autopath-hint">
              No path needed — the config is stored for you. Add its content on the next page.
            </p>
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
