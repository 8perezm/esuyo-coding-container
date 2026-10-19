import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { LoginPage, RegisterPage, RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/layout/Layout';
import { Spinner } from './components/ui';
import { ProjectsProvider } from './lib/projects';
import { OverviewPage } from './pages/OverviewPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectCreatePage } from './pages/ProjectCreatePage';
import { ProjectImportPage } from './pages/ProjectImportPage';
import { ProjectEditPage } from './pages/ProjectEditPage';
import { ImagesPage } from './pages/ImagesPage';
import { ProfilePage } from './pages/ProfilePage';
import { ThemePage } from './pages/ThemePage';
import { SystemPage } from './pages/SystemPage';
import { SshKeysPage } from './pages/SshKeysPage';
import { SetupPage } from './pages/SetupPage';
import { JobsPage } from './pages/JobsPage';

// The terminal (xterm) only loads when visiting a project's terminal page,
// keeping the main bundle lean.
const SshTerminalPage = lazy(() =>
  import('./pages/SshTerminalPage').then((m) => ({ default: m.SshTerminalPage })),
);

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <ProjectsProvider>
                  <Layout />
                </ProjectsProvider>
              </RequireAuth>
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/new" element={<ProjectCreatePage />} />
            <Route path="projects/import" element={<ProjectImportPage />} />
            <Route path="projects/:id/edit" element={<ProjectEditPage />} />
            <Route
              path="projects/:id/ssh"
              element={
                <Suspense fallback={<Spinner label="Loading terminal…" />}>
                  <SshTerminalPage />
                </Suspense>
              }
            />
            <Route path="images" element={<ImagesPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="theme" element={<ThemePage />} />
            <Route path="system" element={<SystemPage />} />
            <Route path="ssh-keys" element={<SshKeysPage />} />
            <Route path="setup" element={<SetupPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="*" element={<PlaceholderPage title="Not found" description="This page does not exist." />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
