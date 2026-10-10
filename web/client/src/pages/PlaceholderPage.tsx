import { PageHeader } from '../components/ui';

interface PlaceholderProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderProps) {
  return (
    <div data-ref="page-placeholder">
      <PageHeader title={title} description={description} />
      <div
        data-ref="page-placeholder-box"
        style={{
          border: '1px dashed var(--border-color)',
          borderRadius: 8,
          backgroundColor: 'var(--bg-card)',
          padding: 32,
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 'var(--font-size-md)',
        }}
      >
        Full {title.toLowerCase()} management arrives in a later milestone — this route shell is ready for it.
      </div>
    </div>
  );
}

export const PLACEHOLDERS: Record<string, { title: string; description: string }> = {
  '/projects': { title: 'Projects', description: 'Per-project containers, workspaces, and lifecycle actions.' },
  '/images': { title: 'Images', description: 'Shared team image versions, publishing, and rollback.' },
  '/system': { title: 'System', description: 'Cluster health, versions, and global configuration.' },
  '/ssh-keys': { title: 'SSH & Keys', description: 'SSH access, key rotation, and VS Code Remote-SSH setup.' },
  '/setup': { title: 'Setup', description: 'One-time environment setup: config, keys, registry.' },
  '/jobs': { title: 'Jobs', description: 'Background tasks and their status history.' },
};
