import { NavLink, useLocation } from 'react-router-dom';
import {
  Container,
  FileCheck2,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  ListOrdered,
  Rocket,
  ServerCog,
  Trash2,
  Wrench,
} from 'lucide-react';
import { ProfileBlock } from './ProfileBlock';
import type { Theme } from '../../theme/useTheme';

export interface NavEntry {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
}

export const NAV_ENTRIES: NavEntry[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/deploy', label: 'Deploy', icon: Rocket },
  { to: '/images', label: 'Images', icon: Container },
  { to: '/system', label: 'System', icon: ServerCog },
  { to: '/ssh-keys', label: 'SSH & Keys', icon: KeyRound },
  { to: '/validate', label: 'Validate', icon: FileCheck2 },
  { to: '/gc', label: 'GC', icon: Trash2 },
  { to: '/setup', label: 'Setup', icon: Wrench },
  { to: '/jobs', label: 'Jobs', icon: ListOrdered },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
}

export function Sidebar({ open, onClose, theme, onSelectTheme }: SidebarProps) {
  const location = useLocation();
  const isActiveEntry = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(`${to}/`);
  return (
    <>
      {open && <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />}
      <aside className={`app-sidebar ${open ? 'app-sidebar-open' : ''}`} aria-label="Primary">
        <nav className="nav-list" aria-label="Admin sections">
          {NAV_ENTRIES.map(({ to, label, icon: Icon }) => {
            const active = isActiveEntry(to);
            return (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                onClick={onClose}
                className={() => `nav-item${active ? ' nav-item-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            );
          })}
        </nav>
        <ProfileBlock theme={theme} onSelectTheme={onSelectTheme} />
      </aside>
    </>
  );
}
