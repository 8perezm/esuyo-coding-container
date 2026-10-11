import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { useTheme } from '../../theme/useTheme';
import { api } from '../../lib/api';

interface GlobalConfigStatus {
  exists: boolean;
}

export function Layout() {
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [configExists, setConfigExists] = useState<boolean | null>(null);

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
      />
      <main className="app-main" id="main-content" data-ref="app-main">
        <Outlet />
      </main>
    </div>
  );
}
