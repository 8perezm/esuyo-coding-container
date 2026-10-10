import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError, api } from '../../lib/api';
import { Button, Input, Label, Modal } from '../ui';

interface EditProfileModalProps {
  onClose: () => void;
}

// Edits the local display name (no backend endpoint yet) and the sign-in
// password (POST /api/change-password) in one place.
export function EditProfileModal({ onClose }: EditProfileModalProps) {
  const { user, setDisplayUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordWarning, setPasswordWarning] = useState<string | null>(null);
  const [passwordDone, setPasswordDone] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const onSubmitProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setDisplayUser({ ...user, displayName: displayName.trim() || undefined });
    onClose();
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
      setPasswordError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Change failed');
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <Modal title="Edit profile" onClose={onClose}>
      <div data-ref="modal-edit-profile">
      <p style={{ margin: '0 0 16px', fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }} data-ref="modal-edit-profile-info">
        Signed in as <strong style={{ color: 'var(--text-primary)' }}>{user?.email}</strong>. The display name is
        stored locally in this browser only.
      </p>
      <form onSubmit={onSubmitProfile} data-ref="modal-edit-profile-form">
        <div style={{ marginBottom: 16 }} data-ref="modal-edit-profile-field">
          <Label htmlFor="edit-display-name">Display name</Label>
          <Input
            id="edit-display-name"
            value={displayName}
            placeholder={user?.email}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="nickname"
            data-ref="modal-edit-profile-input"
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }} data-ref="modal-edit-profile-actions">
          <Button type="button" variant="secondary" onClick={onClose} data-ref="modal-edit-profile-cancel">
            Cancel
          </Button>
          <Button type="submit" data-ref="modal-edit-profile-save">Save</Button>
        </div>
      </form>

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid var(--border-color)' }} />

      <h3 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 12px' }} data-ref="modal-edit-profile-password-heading">
        Change password
      </h3>
      {passwordDone ? (
        <div data-ref="modal-change-password-success">
          <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-md)' }} data-ref="modal-change-password-success-text">Your password was changed.</p>
          {passwordWarning && (
            <p role="note" style={{ margin: '0 0 16px', fontSize: 'var(--font-size-sm)', color: 'var(--text-muted)' }} data-ref="modal-change-password-warning">
              {passwordWarning}
            </p>
          )}
        </div>
      ) : (
        <form onSubmit={onSubmitPassword} data-ref="modal-change-password-form">
          <div style={{ marginBottom: 12 }} data-ref="modal-change-password-current-field">
            <Label htmlFor="edit-current-password">Current password</Label>
            <Input
              id="edit-current-password"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              data-ref="modal-change-password-current-input"
            />
          </div>
          <div style={{ marginBottom: 12 }} data-ref="modal-change-password-new-field">
            <Label htmlFor="edit-new-password">New password</Label>
            <Input
              id="edit-new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              data-ref="modal-change-password-new-input"
            />
          </div>
          <div style={{ marginBottom: 16 }} data-ref="modal-change-password-confirm-field">
            <Label htmlFor="edit-confirm-password">Confirm new password</Label>
            <Input
              id="edit-confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              data-ref="modal-change-password-confirm-input"
            />
          </div>
          {passwordError && (
            <p role="alert" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)', color: '#b91c1c' }} data-ref="modal-change-password-error">
              {passwordError}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }} data-ref="modal-change-password-actions">
            <Button type="submit" disabled={passwordBusy} data-ref="modal-change-password-save">
              {passwordBusy ? 'Saving…' : 'Change password'}
            </Button>
          </div>
        </form>
      )}
      </div>
    </Modal>
  );
}
