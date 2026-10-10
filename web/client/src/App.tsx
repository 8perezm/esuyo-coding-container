import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { LoginPage, RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/layout/Layout';
import { ProjectsProvider } from './lib/projects';
import { OverviewPage } from './pages/OverviewPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectCreatePage } from './pages/ProjectCreatePage';
import { ProjectEditPage } from './pages/ProjectEditPage';
import { ImagesPage } from './pages/ImagesPage';
import { SystemPage } from './pages/SystemPage';
import { SshKeysPage } from './pages/SshKeysPage';
import { SetupPage } from './pages/SetupPage';
import { JobsPage } from './pages/JobsPage';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
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
            <Route path="projects/:id/edit" element={<ProjectEditPage />} />
            <Route path="images" element={<ImagesPage />} />
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
