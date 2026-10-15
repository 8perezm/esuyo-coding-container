import { useCallback, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Container,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  ListOrdered,
  ServerCog,
  Wrench,
} from 'lucide-react';
import { ProfileBlock } from './ProfileBlock';

export interface NavEntry {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
}

export const NAV_ENTRIES: NavEntry[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/images', label: 'Images', icon: Container },
  { to: '/system', label: 'System', icon: ServerCog },
  { to: '/ssh-keys', label: 'SSH & Keys', icon: KeyRound },
  { to: '/setup', label: 'Setup', icon: Wrench },
  { to: '/jobs', label: 'Jobs', icon: ListOrdered },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  showSetup?: boolean;
  width?: number;
  onWidthChange?: (width: number) => void;
}

export function Sidebar({ open, onClose, showSetup = false, width = 260, onWidthChange }: SidebarProps) {
  const location = useLocation();
  const [resizing, setResizing] = useState(false);
  const isActiveEntry = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(`${to}/`);
  const visibleEntries = NAV_ENTRIES.filter((entry) => entry.to !== '/setup' || showSetup);

  const startResize = useCallback((e: React.PointerEvent) => {
    if (!onWidthChange) return;
    // Only primary button / touch contact starts a resize.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    try {
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    } catch {
      /* ignore */
    }
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(480, Math.max(180, Math.round(startW + (ev.clientX - startX))));
      onWidthChange(next);
    };
    const onUp = () => {
      setResizing(false);
      try {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [width, onWidthChange]);

  const resetWidth = useCallback(() => {
    if (!onWidthChange) return;
    onWidthChange(260);
  }, [onWidthChange]);

  const onHandleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!onWidthChange) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -8 : 8;
      const next = Math.min(480, Math.max(180, width + delta));
      onWidthChange(next);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onWidthChange(180);
    } else if (e.key === 'End') {
      e.preventDefault();
      onWidthChange(480);
    }
  }, [width, onWidthChange]);

  return (
    <>
      {open && <div className="drawer-scrim" aria-hidden="true" onClick={onClose} data-ref="sidebar-scrim" />}
      <aside className={`app-sidebar ${open ? 'app-sidebar-open' : ''}`} aria-label="Primary" data-ref="app-sidebar">
        <nav className="nav-list" aria-label="Admin sections" data-ref="sidebar-nav">
          {visibleEntries.map(({ to, label, icon: Icon }) => {
            const active = isActiveEntry(to);
            return (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                onClick={onClose}
                className={() => `nav-item${active ? ' nav-item-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                data-ref={`sidebar-nav-item-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            );
          })}
        </nav>
        <ProfileBlock />
        {onWidthChange && (
          <div
            className={`sidebar-resize-handle${resizing ? ' sidebar-resize-handle-resizing' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to resize navigation"
            aria-valuenow={Math.round(width)}
            aria-valuemin={180}
            aria-valuemax={480}
            title="Drag to resize navigation (double-click to reset)"
            data-ref="sidebar-resize-handle"
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={resetWidth}
            onKeyDown={onHandleKeyDown}
            style={{ cursor: 'ew-resize' }}
          />
        )}
      </aside>
    </>
  );
}
