interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = 'Loading…' }: SpinnerProps) {
  return (
    <div role="status" aria-label={label} data-ref="spinner" style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
      <span className="spinner" aria-hidden="true" />
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}>{label}</span>
    </div>
  );
}
