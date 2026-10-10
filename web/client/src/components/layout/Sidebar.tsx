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
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const location = useLocation();
  const isActiveEntry = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(`${to}/`);
  return (
    <>
      {open && <div className="drawer-scrim" aria-hidden="true" onClick={onClose} data-ref="sidebar-scrim" />}
      <aside className={`app-sidebar ${open ? 'app-sidebar-open' : ''}`} aria-label="Primary" data-ref="app-sidebar">
        <nav className="nav-list" aria-label="Admin sections" data-ref="sidebar-nav">
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
                data-ref={`sidebar-nav-item-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            );
          })}
        </nav>
        <ProfileBlock />
      </aside>
    </>
  );
}
