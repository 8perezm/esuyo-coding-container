import { Check } from 'lucide-react';
import type { Theme } from '../../theme/useTheme';
import { Button, Modal } from '../ui';

interface PreferencesModalProps {
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
  onClose: () => void;
}

const OPTIONS: Array<{ id: Theme; label: string; hint: string }> = [
  { id: 'light', label: 'Light', hint: 'Default bright theme' },
  { id: 'dark', label: 'Dark', hint: 'Low-light theme' },
];

export function PreferencesModal({ theme, onSelectTheme, onClose }: PreferencesModalProps) {
  return (
    <Modal title="Preferences" onClose={onClose}>
      <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text-muted)' }}>
        Theme preference is saved in this browser.
      </p>
      <div role="radiogroup" aria-label="Color theme" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {OPTIONS.map((opt) => {
          const selected = theme === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelectTheme(opt.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                minHeight: 44,
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-color)'}`,
                backgroundColor: selected ? 'var(--accent-soft)' : 'transparent',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
                textAlign: 'left',
              }}
            >
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{opt.label}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{opt.hint}</span>
              </span>
              {selected && <Check size={18} aria-hidden="true" style={{ color: 'var(--accent)' }} />}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
