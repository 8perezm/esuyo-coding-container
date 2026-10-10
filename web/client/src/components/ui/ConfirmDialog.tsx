import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
  danger?: boolean;
}

/** Accessible replacement for window.confirm: Escape / scrim / Cancel closes, focus stays in the dialog. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  confirming = false,
  danger = true,
}: ConfirmDialogProps) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div style={{ fontSize: 'var(--font-size-md)', marginBottom: 24 }} data-ref="confirm-dialog-body">{children}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }} data-ref="confirm-dialog-actions">
        <Button variant="secondary" onClick={onCancel} disabled={confirming} autoFocus data-ref="confirm-dialog-cancel">
          Cancel
        </Button>
        <Button
          variant={danger ? 'primary' : 'secondary'}
          onClick={onConfirm}
          disabled={confirming}
          data-ref="confirm-dialog-confirm"
          style={danger ? { backgroundColor: 'var(--color-error, #b3261e)', borderColor: 'var(--color-error, #b3261e)' } : undefined}
        >
          {confirming ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
