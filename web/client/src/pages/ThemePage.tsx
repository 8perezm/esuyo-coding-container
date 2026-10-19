import { useEffect, useState } from 'react';
import { Button, Card, PageHeader } from '../components/ui';
import { FontPicker, FontSizeControl } from '../components/FontControls';
import {
  FONT_SETTINGS_EVENT,
  FONT_SIZE_RANGES,
  ensureCatalogStylesheet,
  readFontFamily,
  readFontSize,
  resetFontSettings,
  writeFontFamily,
  writeFontSize,
  type FontRole,
} from '../theme/fonts';

const ROLES: Array<{ role: FontRole; fontLabel: string; sizeLabel: string }> = [
  { role: 'headers', fontLabel: 'Headers font', sizeLabel: 'Headers size' },
  { role: 'default', fontLabel: 'Default font', sizeLabel: 'Default size' },
  { role: 'terminal', fontLabel: 'Terminal font', sizeLabel: 'Terminal size' },
];

const ROLE_DATA_REF: Record<FontRole, string> = {
  headers: 'headers',
  default: 'default',
  terminal: 'terminal',
};

function readAllFamilies(): Record<FontRole, string> {
  return {
    headers: readFontFamily('headers'),
    default: readFontFamily('default'),
    terminal: readFontFamily('terminal'),
  };
}

function readAllSizes(): Record<FontRole, number> {
  return {
    headers: readFontSize('headers'),
    default: readFontSize('default'),
    terminal: readFontSize('terminal'),
  };
}

// Appearance settings: font family + size for headers, body text and the
// project terminal. Changes apply instantly and persist in this browser only.
export function ThemePage() {
  const [families, setFamilies] = useState<Record<FontRole, string>>(readAllFamilies);
  const [sizes, setSizes] = useState<Record<FontRole, number>>(readAllSizes);

  // Full catalog webfonts so every picker option renders in its own typeface.
  useEffect(() => {
    ensureCatalogStylesheet();
  }, []);

  // Writers dispatch an event (same tab) and `storage` fires cross-tab.
  useEffect(() => {
    const sync = () => {
      setFamilies(readAllFamilies());
      setSizes(readAllSizes());
    };
    sync();
    window.addEventListener(FONT_SETTINGS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(FONT_SETTINGS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return (
    <div data-ref="page-theme">
      <PageHeader
        title="Theme"
        description="Fonts and font sizes for headers, body text and the project terminal. Changes apply instantly and are stored in this browser only."
      />

      <Card data-ref="page-theme-card">
        {ROLES.map(({ role, fontLabel, sizeLabel }, i) => (
          <div key={role}>
            {i > 0 && <hr className="theme-divider" />}
            <div className="theme-role-grid" data-ref={`page-theme-role-${ROLE_DATA_REF[role]}`}>
              <FontPicker
                role={role}
                label={fontLabel}
                value={families[role]}
                onChange={(family) => writeFontFamily(role, family)}
                dataRef={`page-theme-font-${ROLE_DATA_REF[role]}`}
              />
              <FontSizeControl
                label={sizeLabel}
                value={sizes[role]}
                min={FONT_SIZE_RANGES[role].min}
                max={FONT_SIZE_RANGES[role].max}
                onChange={(size) => writeFontSize(role, size)}
                dataRef={`page-theme-size-${ROLE_DATA_REF[role]}`}
              />
            </div>
          </div>
        ))}

        <hr className="theme-divider" />

        <section aria-label="Preview" data-ref="page-theme-preview">
          <h2 style={{ fontSize: 'var(--font-size-2xl)', margin: '0 0 4px' }} data-ref="page-theme-preview-heading">
            Project overview
          </h2>
          <p
            style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: 'var(--font-size-md)' }}
            data-ref="page-theme-preview-sub"
          >
            Headers, body and terminal type at the sizes above.
          </p>
          <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-md)' }} data-ref="page-theme-preview-body">
            The quick brown fox jumps over the lazy dog. Body copy, buttons, inputs and tables all
            follow the Default font and size — 0123456789.
          </p>
          <p style={{ margin: '0 0 16px' }}>
            <Button type="button" data-ref="page-theme-preview-button">
              Button
            </Button>
          </p>
          <div className="theme-term-preview" data-ref="page-theme-preview-terminal">
            {`$ coding-container deploy --project demo\nNAME   STATUS     PORTS\ndemo   Running    22, 80, 443`}
          </div>
        </section>

        <div
          style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}
          data-ref="page-theme-actions"
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => resetFontSettings()}
            data-ref="page-theme-reset"
          >
            Reset to defaults
          </Button>
        </div>
      </Card>
    </div>
  );
}
