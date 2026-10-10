import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronUp, LogOut, Palette, PencilLine, UserRound } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import type { Theme } from '../../theme/useTheme';
import { EditProfileModal } from './EditProfileModal';
import { PreferencesModal } from './PreferencesModal';

type MenuId = 'edit' | 'preferences' | 'logout';

const MENU_ITEMS: Array<{ id: MenuId; label: string; hint: string }> = [
  { id: 'edit', label: 'Edit profile', hint: 'Change display name' },
  { id: 'preferences', label: 'Preferences', hint: 'Choose theme' },
  { id: 'logout', label: 'Log off', hint: 'End session' },
];

interface ProfileBlockProps {
  theme: Theme;
  onSelectTheme: (theme: Theme) => void;
}

export function ProfileBlock({ theme, onSelectTheme }: ProfileBlockProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<'edit' | 'preferences' | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Click-outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open ]);

  // When opened, focus the first item.
  useEffect(() => {
    if (open) {
      setFocusedIndex(0);
      itemRefs.current[0]?.focus();
    }
  }, [open ]);

  const runAction = async (id: MenuId) => {
    setOpen(false);
    if (id === 'edit') {
      setModal('edit');
    } else if (id === 'preferences') {
      setModal('preferences');
    } else {
      await logout();
      navigate('/login', { replace: true });
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = (focusedIndex + delta + MENU_ITEMS.length) % MENU_ITEMS.length;
      setFocusedIndex(next);
      itemRefs.current[next]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusedIndex(0);
      itemRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = MENU_ITEMS.length - 1;
      setFocusedIndex(last);
      itemRefs.current[last]?.focus();
    }
  };

  const email = user?.email ?? 'Signed in';
  const displayName = user?.displayName || email;

  return (
    <div className="profile-block" ref={containerRef}>
      {open && (
        <div
          className="profile-menu"
          role="menu"
          aria-label="Profile menu"
          onKeyDown={onMenuKeyDown}
        >
          {MENU_ITEMS.map((item, i) => (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              className="profile-menu-item"
              tabIndex={focusedIndex === i ? 0 : -1}
              onClick={() => void runAction(item.id)}
              onMouseEnter={() => setFocusedIndex(i)}
            >
              {item.id === 'edit' ? (
                <PencilLine size={16} aria-hidden="true" />
              ) : item.id === 'preferences' ? (
                <Palette size={16} aria-hidden="true" />
              ) : (
                <LogOut size={16} aria-hidden="true" />
              )}
              <span>
                <span style={{ display: 'block', fontWeight: 600 }}>{item.label}</span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)' }}>{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className="profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Profile menu for ${email}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: '50%',
            backgroundColor: 'var(--accent-soft)',
            color: 'var(--accent-active)',
            flexShrink: 0,
          }}
        >
          <UserRound size={18} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName}
          </span>
          {user?.displayName && (
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {email}
            </span>
          )}
        </span>
        <ChevronUp size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
      </button>

      {modal === 'edit' && <EditProfileModal onClose={() => setModal(null)} />}
      {modal === 'preferences' && (
        <PreferencesModal theme={theme} onSelectTheme={onSelectTheme} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
