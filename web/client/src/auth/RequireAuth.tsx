import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Input, Label } from '../components/ui';
import { WindowControls } from '../components/layout/WindowControls';
import { isDesktopApp } from '../lib/desktop';

export function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} data-ref="auth-loading">
        <p style={{ color: 'var(--text-muted)' }} data-ref="auth-loading-text">Loading session…</p>
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
  const { login, register, authStatus } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ registered: boolean; canRegister: boolean } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  // Desktop-only: the frameless Electron window has no native title bar, so
  // the sign-in view needs the same minimize / maximize / close buttons as
  // the main header (the preload script exposes window.desktop).
  const [showWindowControls, setShowWindowControls] = useState(false);

  useEffect(() => {
    const desktop = isDesktopApp();
    setShowWindowControls(desktop);
    if (desktop) document.documentElement.classList.add('electron');
  }, []);

  useEffect(() => {
    let cancelled = false;
    authStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const unregistered = status && !status.registered;
      if (unregistered && status.canRegister) {
        await register(email.trim(), password);
        // New account: continue to the setup page in the same window.
        navigate('/setup', { replace: true });
      } else {
        await login(email.trim(), password);
        const params = new URLSearchParams(window.location.search);
        navigate(params.get('next') || '/', { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const unregistered = status && !status.registered;
  const showRegister = Boolean(unregistered && status.canRegister);
  const showBlocked = Boolean(unregistered && !status.canRegister);

  const title = showRegister ? 'Create your sign-in' : showBlocked ? 'Setup required' : 'Sign in';
  const subtitle = showRegister
    ? 'No sign-in exists yet — create one on this computer.'
    : showBlocked
      ? 'Registration over the network is not allowed.'
      : 'Administration console — internal use only.';
  const submitLabel = statusLoading ? 'Loading…' : showRegister ? 'Create sign-in' : busy ? 'Signing in…' : 'Sign in';

  return (
    <div
      data-ref="login-page"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        paddingTop: showWindowControls ? 76 : 16,
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      {showWindowControls ? (
        <div className="login-titlebar" data-ref="login-titlebar">
          <WindowControls />
        </div>
      ) : null}
      <Card style={{ width: '100%', maxWidth: 400 }} data-ref="login-card">
        <p className="brand" style={{ marginBottom: 4 }} data-ref="login-brand">
          Coding Containers
        </p>
        <h1 style={{ fontSize: 'var(--font-size-3xl)', marginBottom: 4 }} data-ref="login-title">{title}</h1>
        <p style={{ margin: '0 0 20px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="login-subtitle">
          {subtitle}
        </p>
        {showBlocked ? (
          <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)' }} data-ref="register-blocked">
            No sign-in exists yet. Open the app on the computer where it is running to create it — registration is
            not allowed over the network.
          </p>
        ) : (
        <form onSubmit={onSubmit} noValidate={false} data-ref="login-form">
          <div style={{ marginBottom: 12 }} data-ref="login-email-field">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              data-ref="login-email-input"
            />
          </div>
          <div style={{ marginBottom: 16 }} data-ref="login-password-field">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete={showRegister ? 'new-password' : 'current-password'}
              required
              minLength={showRegister ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              data-ref="login-password-input"
            />
          </div>
          {error && (
            <p role="alert" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)', color: '#b91c1c' }} data-ref="login-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || statusLoading} style={{ width: '100%' }} data-ref="login-submit">
            {submitLabel}
          </Button>
        </form>
        )}
      </Card>
    </div>
  );
}

export function RegisterPage() {
  return <LoginPage />;
}
