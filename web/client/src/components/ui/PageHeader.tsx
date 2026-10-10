import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div
      data-ref="page-header"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 24,
        flexWrap: 'wrap',
      }}
    >
      <div data-ref="page-header-text">
        <h1 style={{ fontSize: 'var(--font-size-4xl)', marginBottom: description ? 6 : 0 }} data-ref="page-header-title">{title}</h1>
        {description && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }} data-ref="page-header-description">{description}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8 }} data-ref="page-header-actions">{actions}</div>}
    </div>
  );
}
