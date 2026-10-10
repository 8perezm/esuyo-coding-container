import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { useTheme } from '../../theme/useTheme';

export function Layout() {
  const { theme, setTheme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div>
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        theme={theme}
        onSelectTheme={setTheme}
      />
      <main className="app-main" id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
