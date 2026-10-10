import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Button, Input, Label, Modal } from '../ui';

interface EditProfileModalProps {
  onClose: () => void;
}

// Edits the local display name only (no backend endpoint yet).
export function EditProfileModal({ onClose }: EditProfileModalProps) {
  const { user, setDisplayUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setDisplayUser({ ...user, displayName: displayName.trim() || undefined });
    onClose();
  };

  return (
    <Modal title="Edit profile" onClose={onClose}>
      <p style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--text-muted)' }}>
        Signed in as <strong style={{ color: 'var(--text-primary)' }}>{user?.email}</strong>. The display name is
        stored locally in this browser only.
      </p>
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: 16 }}>
          <Label htmlFor="edit-display-name">Display name</Label>
          <Input
            id="edit-display-name"
            value={displayName}
            placeholder={user?.email}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="nickname"
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
