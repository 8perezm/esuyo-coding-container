import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { useTheme } from '../../theme/useTheme';
import { api } from '../../lib/api';

interface GlobalConfigStatus {
  exists: boolean;
}

export const SIDEBAR_WIDTH_KEY = 'sidebarWidth';
export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;

export function readStoredSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const v = Number.parseInt(raw ?? '', 10);
    if (Number.isInteger(v) && v >= SIDEBAR_WIDTH_MIN && v <= SIDEBAR_WIDTH_MAX) return v;
  } catch {
    /* ignore */
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

export function Layout() {
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [configExists, setConfigExists] = useState<boolean | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredSidebarWidth());

  useEffect(() => {
    let cancelled = false;
    api
      .get<GlobalConfigStatus>('/api/global-config')
      .then((data) => {
        if (!cancelled) setConfigExists(data.exists);
      })
      .catch(() => {
        if (!cancelled) setConfigExists(null);
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  useEffect(() => {
    if (configExists === false && location.pathname !== '/setup') {
      navigate('/setup', { replace: true });
    }
  }, [configExists, location.pathname, navigate]);

  useEffect(() => {
    try {
      document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    } catch {
      /* ignore */
    }
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      /* storage unavailable */
    }
  }, [sidebarWidth]);

  return (
    <div data-ref="app-layout">
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        showSetup={configExists === false}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
      />
      <main className="app-main" id="main-content" data-ref="app-main">
        <Outlet />
      </main>
    </div>
  );
}
