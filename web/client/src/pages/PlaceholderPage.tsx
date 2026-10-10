import { PageHeader } from '../components/ui';

interface PlaceholderProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderProps) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <div
        style={{
          border: '1px dashed var(--border-color)',
          borderRadius: 8,
          backgroundColor: 'var(--bg-card)',
          padding: 32,
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 14,
        }}
      >
        Full {title.toLowerCase()} management arrives in a later milestone — this route shell is ready for it.
      </div>
    </div>
  );
}

export const PLACEHOLDERS: Record<string, { title: string; description: string }> = {
  '/projects': { title: 'Projects', description: 'Per-project containers, workspaces, and lifecycle actions.' },
  '/deploy': { title: 'Deploy', description: 'Build, publish, and roll out container images.' },
  '/images': { title: 'Images', description: 'Shared team image versions, publishing, and rollback.' },
  '/system': { title: 'System', description: 'Cluster health, versions, and global configuration.' },
  '/ssh-keys': { title: 'SSH & Keys', description: 'SSH access, key rotation, and VS Code Remote-SSH setup.' },
  '/validate': { title: 'Validate', description: 'Configuration checks before create and deploy.' },
  '/gc': { title: 'GC', description: 'Garbage-collect unused images and stale resources.' },
  '/setup': { title: 'Setup', description: 'One-time environment setup: config, keys, registry.' },
  '/jobs': { title: 'Jobs', description: 'Background tasks and their status history.' },
};
