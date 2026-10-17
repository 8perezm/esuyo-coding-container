import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api } from '../lib/api';

export interface User {
  email: string;
  displayName?: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  authStatus: () => Promise<{ registered: boolean; canRegister: boolean }>;
  logout: () => Promise<void>;
  setDisplayUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await api.get<User>('/api/me');
      setUser(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load session');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Expired sessions surface as 401 from any authenticated endpoint (the
  // dashboard polls cluster status). Sign out locally so RequireAuth sends
  // the user back to sign-in instead of showing cluster errors.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('gui:unauthorized', onUnauthorized);
    return () => window.removeEventListener('gui:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const me = await api.post<User>('/api/login', { email, password });
    setUser(me);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const me = await api.post<User>('/api/register', { email, password });
    setUser(me);
  }, []);

  const authStatus = useCallback(async () => {
    return api.get<{ registered: boolean; canRegister: boolean }>('/api/auth-status');
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/logout');
    setUser(null);
  }, []);

  const setDisplayUser = useCallback((next: User | null) => {
    setUser(next);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, error, refresh, login, register, authStatus, logout, setDisplayUser }),
    [user, loading, error, refresh, login, register, authStatus, logout, setDisplayUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
