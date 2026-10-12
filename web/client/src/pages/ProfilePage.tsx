import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../lib/api';
import { Button, Card, Input, Label, PageHeader } from '../components/ui';

function errMsg(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Change failed';
}

// Formerly the profile modal: display name (stored locally in this browser)
// and sign-in password change (POST /api/change-password).
export function ProfilePage() {
  const { user, setDisplayUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [profileSaved, setProfileSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordWarning, setPasswordWarning] = useState<string | null>(null);
  const [passwordDone, setPasswordDone] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [authFile, setAuthFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ email: string; authFile: string | null }>('/api/auth-info')
      .then((info) => {
        if (!cancelled) setAuthFile(info.authFile);
      })
      .catch(() => {
        if (!cancelled) setAuthFile(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmitProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setDisplayUser({ ...user, displayName: displayName.trim() || undefined });
    setProfileSaved(true);
  };

  const onSubmitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordWarning(null);
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    setPasswordBusy(true);
    try {
      const result = await api.post<{ ok: boolean; warning?: string }>('/api/change-password', {
        currentPassword,
        newPassword,
      });
      setPasswordDone(true);
      if (result.warning) setPasswordWarning(result.warning);
    } catch (err) {
      setPasswordError(errMsg(err));
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div data-ref="page-profile">
      <PageHeader title="Profile" description="Display name and sign-in password." />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <section>
          <h2 data-ref="page-profile-heading-profile" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>
            Display name
          </h2>          <Card data-ref="page-profile-card">
            <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="page-profile-info">
              Signed in as <strong style={{ color: 'var(--text-primary)' }}>{user?.email}</strong>. The display name is
              stored locally in this browser only.
            </p>
            <form onSubmit={onSubmitProfile} data-ref="page-profile-form">
              <div style={{ marginBottom: 16 }} data-ref="page-profile-field">
                <Label htmlFor="profile-display-name">Display name</Label>
                <Input
                  id="profile-display-name"
                  value={displayName}
                  placeholder={user?.email}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setProfileSaved(false);
                  }}
                  autoComplete="nickname"
                  data-ref="page-profile-input"
                />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }} data-ref="page-profile-actions">
                <Button type="submit" data-ref="page-profile-save">Save</Button>
              </div>
            </form>
            {profileSaved && (
              <p role="status" style={{ margin: '12px 0 0', fontSize: 'var(--font-size-md)' }} data-ref="page-profile-saved">
                Display name saved.
              </p>
            )}
          </Card>
        </section>

        <section>
          <h2 data-ref="page-profile-password-heading" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>
            Change password
          </h2>
          <Card data-ref="page-profile-password-card">
            {passwordDone ? (
              <div data-ref="page-change-password-success">
                <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }} data-ref="page-change-password-success-text">
                  Your password was changed.
                </p>
                {passwordWarning && (
                  <p role="note" style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="page-change-password-warning">
                    {passwordWarning}
                  </p>
                )}
              </div>
            ) : (
              <form onSubmit={onSubmitPassword} data-ref="page-change-password-form">
                <div style={{ marginBottom: 12 }} data-ref="page-change-password-current-field">
                  <Label htmlFor="profile-current-password">Current password</Label>
                  <Input
                    id="profile-current-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    data-ref="page-change-password-current-input"
                  />
                </div>
                <div style={{ marginBottom: 12 }} data-ref="page-change-password-new-field">
                  <Label htmlFor="profile-new-password">New password</Label>
                  <Input
                    id="profile-new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    data-ref="page-change-password-new-input"
                  />
                </div>
                <div style={{ marginBottom: 16 }} data-ref="page-change-password-confirm-field">
                  <Label htmlFor="profile-confirm-password">Confirm new password</Label>
                  <Input
                    id="profile-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    data-ref="page-change-password-confirm-input"
                  />
                </div>
                {passwordError && (
                  <p role="alert" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)', color: '#b91c1c' }} data-ref="page-change-password-error">
                    {passwordError}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }} data-ref="page-change-password-actions">
                  <Button type="submit" disabled={passwordBusy} data-ref="page-change-password-save">
                    {passwordBusy ? 'Saving…' : 'Change password'}
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </section>

        <section>
          <h2 data-ref="page-profile-reset-heading" style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 12 }}>
            Reset sign-in
          </h2>
          <Card data-ref="page-profile-reset-card">
            <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="page-profile-reset-info">
              To start over, delete the credential file{authFile ? ` at ${authFile}` : ''} while the app is running.
              The pages will ask to create a new sign-in. Creating a sign-in is only possible on the computer where
              the app is running.
            </p>
          </Card>
        </section>
      </div>
    </div>
  );
}
