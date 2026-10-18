import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';

export interface RefreshIntervalOption {
  seconds: number;
  label: string;
}

export const REFRESH_INTERVAL_OPTIONS: RefreshIntervalOption[] = [
  { seconds: 0, label: 'Off' },
  { seconds: 5, label: '5s' },
  { seconds: 10, label: '10s' },
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '1m' },
];

export function formatRefreshInterval(seconds: number): string {
  return REFRESH_INTERVAL_OPTIONS.find((o) => o.seconds === seconds)?.label ?? `${seconds}s`;
}

interface RefreshControlProps {
  refreshing: boolean;
  onRefresh: () => void;
  /** Auto-refresh cadence in seconds; 0 means off (manual refresh only). */
  intervalSeconds: number;
  onIntervalChange: (seconds: number) => void;
}

/**
 * Joined manual-refresh + auto-refresh-interval control:
 * [Refresh | 10s ▾]. The picker only changes the polling cadence;
 * "Off" stops background refreshes entirely.
 */
export function RefreshControl({ refreshing, onRefresh, intervalSeconds, onIntervalChange }: RefreshControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const intervalButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        intervalButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  const label = formatRefreshInterval(intervalSeconds);

  return (
    <span
      ref={rootRef}
      data-ref="page-overview-refresh-control"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'stretch',
        background: 'var(--border-color)',
        borderRadius: 8,
      }}
    >
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh dashboard"
        data-ref="page-overview-refresh"
        className="refresh-control-segment"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          border: 0,
          borderRadius: '8px 0 0 8px',
          background: 'transparent',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          cursor: 'pointer',
          opacity: refreshing ? 0.55 : 1,
        }}
      >
        <RefreshCw size={16} aria-hidden="true" />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      <button
        ref={intervalButtonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Auto-refresh interval, currently ${label === 'Off' ? 'off' : label}`}
        data-ref="page-overview-refresh-interval"
        className="refresh-control-segment"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 10px 6px 12px',
          border: 0,
          borderLeft: '1px solid rgba(0, 0, 0, 0.18)',
          borderRadius: '0 8px 8px 0',
          background: 'transparent',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {label}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <span
          role="menu"
          aria-label="Auto-refresh interval"
          data-ref="page-overview-refresh-menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 140,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-dropdown)',
            padding: 4,
            zIndex: 50,
          }}
        >
          {REFRESH_INTERVAL_OPTIONS.map((o) => {
            const checked = o.seconds === intervalSeconds;
            return (
              <button
                key={o.seconds}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                data-ref="page-overview-refresh-interval-option"
                data-seconds={o.seconds}
                onClick={() => {
                  onIntervalChange(o.seconds);
                  setOpen(false);
                  intervalButtonRef.current?.focus();
                }}
                className="refresh-control-option"
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 10px',
                  border: 0,
                  borderRadius: 6,
                  background: checked ? 'var(--bg-row-hover)' : 'transparent',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 'var(--font-size-md)',
                  fontWeight: checked ? 700 : 500,
                  cursor: 'pointer',
                }}
              >
                {o.label}
                <span aria-hidden="true" style={{ visibility: checked ? 'visible' : 'hidden' }}>
                  ✓
                </span>
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}
