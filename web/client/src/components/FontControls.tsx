import { useEffect, useId, useRef, useState } from 'react';
import { FONT_CATALOG, fontCss, type FontDef, type FontRole } from '../theme/fonts';
import { Input, Label } from './ui';

interface FontPickerProps {
  role: FontRole;
  label: string;
  value: string;
  onChange: (family: string) => void;
  dataRef: string;
}

type Row = { kind: 'group'; label: string } | { kind: 'option'; def: FontDef };

function buildRows(role: FontRole, query: string): Row[] {
  const q = query.trim().toLowerCase();
  const matches = FONT_CATALOG.filter((d) => !q || d.family.toLowerCase().includes(q));
  if (role !== 'terminal') return matches.map((def) => ({ kind: 'option' as const, def }));
  const mono = matches.filter((d) => d.category === 'monospace');
  const rest = matches.filter((d) => d.category !== 'monospace');
  const rows: Row[] = [];
  if (mono.length > 0) {
    rows.push({ kind: 'group', label: 'Monospace — recommended' });
    for (const def of mono) rows.push({ kind: 'option', def });
  }
  if (rest.length > 0) {
    rows.push({ kind: 'group', label: 'All families' });
    for (const def of rest) rows.push({ kind: 'option', def });
  }
  return rows;
}

/**
 * Font family picker: each option renders in its own typeface with a live
 * preview line, plus search and (for Terminal) monospace-first grouping.
 */
export function FontPicker({ role, label, value, onChange, dataRef }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focusIndex, setFocusIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const listId = useId();

  const rows = buildRows(role, query);
  const optionFamilies = rows.filter((r) => r.kind === 'option').map((r) => (r as { def: FontDef }).def.family);

  // Click-outside closes the list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open ]);

  // Opening resets the search and focuses it.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFocusIndex(0);
    searchRef.current?.focus();
  }, [open ]);

  // Keep the highlighted option visible while arrowing.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[focusIndex]?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex, open ]);

  const current = FONT_CATALOG.find((d) => d.family === value);
  const showMonoWarn = role === 'terminal' && current?.category !== 'monospace';

  const select = (family: string) => {
    onChange(family);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => Math.min(optionFamilies.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      const family = optionFamilies[focusIndex];
      if (family) {
        e.preventDefault();
        select(family);
      }
    }
  };

  return (
    <div ref={containerRef} data-ref={dataRef}>
      <Label htmlFor={`${listId}-button`}>{label}</Label>
      <div className="font-picker">
        <button
          ref={buttonRef}
          id={`${listId}-button`}
          type="button"
          className="font-picker-btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onButtonKeyDown}
          data-ref={`${dataRef}-button`}
        >
          <span className="font-picker-current" style={{ fontFamily: current ? fontCss(current.family) : undefined }}>
            {value}
          </span>
          {current && <span className="font-picker-badge">{current.category}</span>}
        </button>
        {open && (
          <div
            className="font-picker-list"
            role="listbox"
            aria-label={label}
            data-ref={`${dataRef}-list`}
            onKeyDown={onListKeyDown}
          >
            <input
              ref={searchRef}
              type="search"
              className="font-picker-search"
              placeholder="Search fonts…"
              aria-label="Search fonts"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFocusIndex(0);
              }}
              data-ref={`${dataRef}-search`}
            />
            <div className="font-picker-opts">
              {rows.map((row) => {
                if (row.kind === 'group') {
                  return (
                    <div key={`g-${row.label}`} className="font-picker-group">
                      {row.label}
                    </div>
                  );
                }
                const optIndex = optionFamilies.indexOf(row.def.family);
                const active = optIndex === focusIndex;
                return (
                  <div
                    key={row.def.family}
                    ref={(el) => {
                      optionRefs.current[optIndex] = el;
                    }}
                    role="option"
                    id={`${listId}-opt-${optIndex}`}
                    aria-selected={value === row.def.family}
                    className={`font-picker-opt${active ? ' font-picker-opt-active' : ''}`}
                    onClick={() => select(row.def.family)}
                    onMouseEnter={() => setFocusIndex(optIndex)}
                    data-ref={`${dataRef}-option-${row.def.family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                  >
                    <div className="font-picker-opt-name" style={{ fontFamily: fontCss(row.def.family) }}>
                      {row.def.family} <span className="font-picker-opt-cat">{row.def.category}</span>
                    </div>
                    <div className="font-picker-opt-prev" style={{ fontFamily: fontCss(row.def.family) }}>
                      The quick brown fox jumps over 0123456789
                    </div>
                  </div>
                );
              })}
              {rows.length === 0 && <div className="font-picker-opt">No matches.</div>}
            </div>
          </div>
        )}
      </div>
      {showMonoWarn && (
        <div role="note" className="font-mono-warn" data-ref={`${dataRef}-mono-warn`}>
          Proportional font — terminal columns may misalign. A monospace face is recommended.
        </div>
      )}
    </div>
  );
}

interface FontSizeControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (size: number | string) => void;
  dataRef: string;
}

/** Slider + exact pixel field. The number field commits on blur / Enter. */
export function FontSizeControl({ label, value, min, max, onChange, dataRef }: FontSizeControlProps) {
  const rangeId = useId();
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    setDraft(null);
    onChange(raw);
  };

  return (
    <div data-ref={dataRef}>
      <Label htmlFor={rangeId}>{label}</Label>
      <input
        id={rangeId}
        type="range"
        className="theme-size-range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        data-ref={`${dataRef}-slider`}
      />
      <div className="theme-size-line">
        <Input
          type="number"
          min={min}
          max={max}
          step={1}
          value={draft ?? value}
          aria-label={`${label} in pixels`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          data-ref={`${dataRef}-number`}
        />
        <span aria-hidden="true">px</span>
      </div>
    </div>
  );
}
