import { Suspense, lazy, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent, KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import type { Project } from '../lib/projects';
import { Button, Card, Input, Label, PageHeader, Spinner } from '../components/ui';

const YamlEditor = lazy(() =>
  import('../components/YamlEditor').then((m) => ({ default: m.YamlEditor })),
);

interface CreateProjectResponse {
  project: Project;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

const MAX_FILE_BYTES = 512 * 1024;

export function ProjectImportPage() {
  const { refresh } = useProjects();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const readChosenFile = async (file: File | null) => {
    setFileError(null);
    if (!file) {
      setFileName(null);
      setFileText(null);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileName(null);
      setFileText(null);
      setFileError(`File is too large (${Math.round(file.size / 1024)} KB) — limit is 512 KB.`);
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        setFileName(null);
        setFileText(null);
        setFileError('File is empty — choose a config file with content.');
        return;
      }
      setFileName(file.name);
      setFileText(text);
    } catch (err) {
      setFileName(null);
      setFileText(null);
      setFileError(`Could not read file: ${errMsg(err)}`);
    }
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    void readChosenFile(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void readChosenFile(e.dataTransfer.files?.[0] ?? null);
  };

  const onDropzoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const onClearFile = () => {
    setFileName(null);
    setFileText(null);
    setFileError(null);
  };

  const onImport = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setCreatedProject(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Name is required.');
      return;
    }
    if (!fileText) {
      setFormError('Choose a config file to upload.');
      return;
    }
    setImporting(true);
    try {
      const res = await api.post<CreateProjectResponse>('/api/projects', {
        name: trimmedName,
      });
      try {
        await api.put<{ ok: boolean }>('/api/config', {
          projectId: res.project.id,
          yaml: fileText,
        });
      } catch (err) {
        // Entry exists but the uploaded content was rejected — keep the
        // project so the content can be fixed on the edit page.
        setCreatedProject(res.project);
        await refresh();
        setFormError(errMsg(err));
        return;
      }
      await refresh();
      navigate(`/projects/${encodeURIComponent(res.project.id)}/edit`);
    } catch (err) {
      setFormError(errMsg(err));
    } finally {
      setImporting(false);
    }
  };

  const totalLines = fileText ? fileText.split('\n').length : 0;

  return (
    <div data-ref="page-project-import">
      <PageHeader
        title="Import project"
        description="Name the project and upload its config file — the content is stored for you."
        actions={
          <Link to="/projects" className="btn btn-secondary" data-ref="page-project-import-back">
            Back to projects
          </Link>
        }
      />

      <Card style={{ width: '100%' }} data-ref="page-project-import-form-card">
        {formError && (
          <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)', marginTop: 0 }} data-ref="page-project-import-error">
            {formError}
          </p>
        )}
        {createdProject && (
          <p style={{ fontSize: 'var(--font-size-md)', marginTop: 0 }} data-ref="page-project-import-created-hint">
            The project entry was kept — fix the content on the{' '}
            <Link to={`/projects/${encodeURIComponent(createdProject.id)}/edit`} data-ref="page-project-import-created-edit-link">
              edit page
            </Link>
            .
          </p>
        )}
        <form onSubmit={(e) => void onImport(e)} style={{ display: 'grid', gap: 12 }} data-ref="page-project-import-form">
          <div>
            <Label htmlFor="import-project-name">Name</Label>
            <Input
              id="import-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoComplete="off"
              data-ref="page-project-import-input-name"
            />
          </div>
          {!fileText && (
          <div>
            <Label htmlFor="import-project-file">Config file</Label>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a config file"
              data-ref="page-project-import-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={onDropzoneKeyDown}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              style={{
                border: '1px dashed var(--border-color)',
                borderRadius: 8,
                padding: 20,
                textAlign: 'center',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: dragging ? 'var(--bg-surface)' : 'transparent',
                outline: dragging ? '2px solid var(--color-accent, #0969da)' : 'none',
                outlineOffset: 2,
              }}
            >
              <Upload size={20} aria-hidden="true" style={{ display: 'block' }} />
              <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-md)' }} data-ref="page-project-import-dropzone-hint">
                Drag and drop a config file here, or click to browse
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }}>
                .yaml, .yml, .txt up to 512 KB
              </p>
            </div>
            <input
              ref={fileInputRef}
              id="import-project-file"
              type="file"
              accept=".yaml,.yml,.txt"
              onChange={onFileChange}
              data-ref="page-project-import-input-file"
              style={{ display: 'none' }}
            />
            {fileError && (
              <p role="alert" style={{ color: 'var(--color-error, #b3261e)', fontSize: 'var(--font-size-md)' }} data-ref="page-project-import-file-error">
                {fileError}
              </p>
            )}
          </div>
          )}
          {fileText && (
            <div data-ref="page-project-import-preview">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="page-project-import-file-info">
                  {fileName} — {totalLines} line{totalLines === 1 ? '' : 's'}
                </p>
                <Button variant="secondary" onClick={onClearFile} data-ref="page-project-import-replace-file">
                  Choose a different file
                </Button>
              </div>
              <Label htmlFor="import-project-yaml">Config (YAML)</Label>
              <Suspense fallback={<Spinner label="Loading editor…" />}>
                <YamlEditor id="import-project-yaml" value={fileText} onChange={setFileText} height="480px" />
              </Suspense>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }} data-ref="page-project-import-actions">
            <Button type="submit" disabled={importing} data-ref="page-project-import-submit">
              <Upload size={16} aria-hidden="true" /> {importing ? 'Importing…' : 'Import project'}
            </Button>
            <Link to="/projects" className="btn btn-secondary" data-ref="page-project-import-cancel">
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
