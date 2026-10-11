import { Link } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import type { Theme } from '../../theme/useTheme';

interface HeaderProps {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenSidebar: () => void;
}

export function Header({ theme, onToggleTheme, onOpenSidebar }: HeaderProps) {
  return (
    <header className="app-header" data-ref="app-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-ref="header-brand-group">
        <button
          type="button"
          className="icon-button hamburger"
          aria-label="Open navigation menu"
          aria-expanded="false"
          data-ref="header-nav-toggle"
          onClick={onOpenSidebar}
        >
          <Menu size={22} aria-hidden="true" />
        </button>
        <Link to="/" className="brand" data-ref="header-brand-link" style={{ fontSize: 'var(--font-size-4xl)' }}>
          Coding Containers
        </Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} data-ref="header-actions">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </header>
  );
}
