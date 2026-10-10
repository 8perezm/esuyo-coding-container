import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '48px 24px',
        border: '1px dashed var(--border-color)',
        borderRadius: 8,
        backgroundColor: 'var(--bg-card)',
      }}
    >
      <h3 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h3>
      {description && <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 14 }}>{description}</p>}
      {action}
    </div>
  );
}
