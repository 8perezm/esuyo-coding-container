import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Input, Label } from '../components/ui';

export function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading session…</p>
      </div>
    );
  }

  if (!user) {
    window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return null;
  }

  return children;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      const params = new URLSearchParams(window.location.search);
      navigate(params.get('next') || '/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      <Card style={{ width: '100%', maxWidth: 400 }}>
        <p className="brand" style={{ marginBottom: 4 }}>
          Coding Containers
        </p>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Sign in</h1>
        <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--text-muted)' }}>
          Administration console — internal use only.
        </p>
        <form onSubmit={onSubmit} noValidate={false}>
          <div style={{ marginBottom: 12 }}>
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          {error && (
            <p role="alert" style={{ margin: '0 0 12px', fontSize: 14, color: '#b91c1c' }}>
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
