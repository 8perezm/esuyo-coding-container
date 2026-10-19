/**
 * Per-browser font + font-size settings (Headers, Default, Terminal).
 *
 * Same model as the theme toggle (`cc-admin-theme`) and dashboard alert
 * thresholds: stored in `localStorage`, applied as CSS custom properties on
 * `documentElement`, no server change needed. The terminal page reads the
 * stored terminal values for xterm and updates live sessions on change.
 */

export type FontRole = 'headers' | 'default' | 'terminal';

export type FontCategory = 'sans-serif' | 'serif' | 'monospace';

export interface FontDef {
  family: string;
  category: FontCategory;
  weights: number[];
  fallback: string;
}

/** Fired on `window` after any font setting changes (same-tab sync). */
/* Cross-tab sync uses the native `storage` event. */
export const FONT_SETTINGS_EVENT = 'cc-font-settings-changed';

const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS_FALLBACK = 'ui-sans-serif, system-ui, sans-serif';
const SERIF_FALLBACK = 'Georgia, serif';

/** 36 Google Fonts catalog (all SIL Open Font License 1.1). */
export const FONT_CATALOG: FontDef[] = [
  { family: 'Inter', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Roboto', category: 'sans-serif', weights: [400, 500, 700], fallback: SANS_FALLBACK },
  { family: 'Open Sans', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Montserrat', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Poppins', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Lato', category: 'sans-serif', weights: [400, 700, 900], fallback: SANS_FALLBACK },
  { family: 'Manrope', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'DM Sans', category: 'sans-serif', weights: [400, 500, 700], fallback: SANS_FALLBACK },
  { family: 'Source Sans 3', category: 'sans-serif', weights: [400, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Nunito', category: 'sans-serif', weights: [400, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Rubik', category: 'sans-serif', weights: [400, 500, 700], fallback: SANS_FALLBACK },
  { family: 'Work Sans', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Plus Jakarta Sans', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'IBM Plex Sans', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Space Grotesk', category: 'sans-serif', weights: [500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Oswald', category: 'sans-serif', weights: [400, 500, 600, 700], fallback: SANS_FALLBACK },
  { family: 'Merriweather', category: 'serif', weights: [400, 700], fallback: SERIF_FALLBACK },
  { family: 'Playfair Display', category: 'serif', weights: [400, 600, 700], fallback: SERIF_FALLBACK },
  { family: 'Lora', category: 'serif', weights: [400, 500, 600, 700], fallback: SERIF_FALLBACK },
  { family: 'Source Serif 4', category: 'serif', weights: [400, 600, 700], fallback: SERIF_FALLBACK },
  { family: 'EB Garamond', category: 'serif', weights: [400, 500, 600, 700], fallback: SERIF_FALLBACK },
  { family: 'Libre Baskerville', category: 'serif', weights: [400, 700], fallback: SERIF_FALLBACK },
  { family: 'Noto Serif', category: 'serif', weights: [400, 500, 600, 700], fallback: SERIF_FALLBACK },
  { family: 'PT Serif', category: 'serif', weights: [400, 700], fallback: SERIF_FALLBACK },
  { family: 'Cormorant Garamond', category: 'serif', weights: [400, 500, 600, 700], fallback: SERIF_FALLBACK },
  { family: 'Crimson Pro', category: 'serif', weights: [400, 500, 600, 700], fallback: SERIF_FALLBACK },
  { family: 'Roboto Mono', category: 'monospace', weights: [400, 500, 700], fallback: MONO_FALLBACK },
  { family: 'JetBrains Mono', category: 'monospace', weights: [400, 500, 700], fallback: MONO_FALLBACK },
  { family: 'Source Code Pro', category: 'monospace', weights: [400, 500, 600, 700], fallback: MONO_FALLBACK },
  { family: 'IBM Plex Mono', category: 'monospace', weights: [400, 500, 600, 700], fallback: MONO_FALLBACK },
  { family: 'Inconsolata', category: 'monospace', weights: [400, 500, 600, 700], fallback: MONO_FALLBACK },
  { family: 'Fira Code', category: 'monospace', weights: [400, 500, 600, 700], fallback: MONO_FALLBACK },
  { family: 'Space Mono', category: 'monospace', weights: [400, 700], fallback: MONO_FALLBACK },
  { family: 'Ubuntu Mono', category: 'monospace', weights: [400, 700], fallback: MONO_FALLBACK },
  { family: 'DM Mono', category: 'monospace', weights: [400, 500], fallback: MONO_FALLBACK },
  { family: 'Cousine', category: 'monospace', weights: [400, 700], fallback: MONO_FALLBACK },
];

export const FONT_FAMILY_DEFAULTS: Record<FontRole, string> = {
  headers: 'Space Grotesk',
  default: 'Manrope',
  terminal: 'Roboto Mono',
};

export const FONT_SIZE_DEFAULTS: Record<FontRole, number> = {
  headers: 16,
  default: 13,
  terminal: 14,
};

export const FONT_SIZE_RANGES: Record<FontRole, { min: number; max: number }> = {
  headers: { min: 14, max: 24 },
  default: { min: 10, max: 18 },
  terminal: { min: 10, max: 20 },
};

const FAMILY_KEYS: Record<FontRole, string> = {
  headers: 'cc-font-heading',
  default: 'cc-font-body',
  terminal: 'cc-font-terminal',
};

const SIZE_KEYS: Record<FontRole, string> = {
  headers: 'cc-font-size-heading',
  default: 'cc-font-size-body',
  terminal: 'cc-font-size-terminal',
};

/** Heading sizes stay proportional: 2xl tracks the base exactly. */
const HEADING_RATIOS: Record<string, number> = {
  xl: 15 / 16,
  '2xl': 1,
  '3xl': 18 / 16,
  '4xl': 20 / 16,
  '5xl': 24 / 16,
};

const memoryStore = new Map<string, string>();

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryStore.has(key) ? memoryStore.get(key)! : null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memoryStore.set(key, value);
  }
}

function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    memoryStore.delete(key);
  }
}

export function fontDef(family: string): FontDef | undefined {
  return FONT_CATALOG.find((d) => d.family === family);
}

/** `'Family', fallback stack` — safe to assign to `font-family`. */
export function fontCss(family: string): string {
  const def = fontDef(family) ?? fontDef(FONT_FAMILY_DEFAULTS.default);
  const fallback = def!.category === 'monospace' ? MONO_FALLBACK : def!.category === 'serif' ? SERIF_FALLBACK : SANS_FALLBACK;
  const resolved = fontDef(family)?.family ?? FONT_FAMILY_DEFAULTS.default;
  return `'${resolved}', ${fallback}`;
}

/** Unknown stored values (e.g. catalog changed) fall back to the default. */
export function resolveFontFamily(role: FontRole, raw: unknown): string {
  if (typeof raw === 'string' && fontDef(raw)) return raw;
  return FONT_FAMILY_DEFAULTS[role];
}

export function readFontFamily(role: FontRole): string {
  return resolveFontFamily(role, readStored(FAMILY_KEYS[role]));
}

/** Non-numeric or out-of-range values clamp to range / default. */
export function clampFontSize(role: FontRole, value: unknown): number {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULTS[role];
  const { min, max } = FONT_SIZE_RANGES[role];
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function readFontSize(role: FontRole): number {
  const raw = readStored(SIZE_KEYS[role]);
  if (raw == null) return FONT_SIZE_DEFAULTS[role];
  return clampFontSize(role, raw);
}

/** Proportional heading scale (`--font-size-*`) for a headers base size. */
export function scaledHeadingSizes(basePx: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [token, ratio] of Object.entries(HEADING_RATIOS)) {
    out[token] = Math.round(basePx * ratio);
  }
  return out;
}

/** Google Fonts `css2` URL for the given families (catalog weights each). */
export function buildGoogleFontsUrl(families: string[]): string {
  const parts = families.map((family) => {
    const def = fontDef(family);
    const weights = def ? [...def.weights].sort((a, b) => a - b).join(';') : '400';
    return `family=${family.replace(/ /g, '+')}:wght@${weights}`;
  });
  return `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap`;
}

function ensureStylesheet(id: string, href: string): void {
  if (typeof document === 'undefined') return;
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

/** Full catalog stylesheet so every picker option renders in its own font. */
export function ensureCatalogStylesheet(): void {
  ensureStylesheet('cc-font-catalog', buildGoogleFontsUrl(FONT_CATALOG.map((d) => d.family)));
}

/** Only the three selected families — the steady-state runtime cost. */
export function ensureSelectedFontsStylesheet(): void {
  const selected = Array.from(
    new Set([readFontFamily('headers'), readFontFamily('default'), readFontFamily('terminal')]),
  );
  ensureStylesheet('cc-user-fonts', buildGoogleFontsUrl(selected));
}

export function notifyFontSettingsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(FONT_SETTINGS_EVENT));
}

/** Applies stored families + sizes to CSS variables. Safe to call on boot. */
export function applyFontSettings(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--font-heading', fontCss(readFontFamily('headers')));
  root.style.setProperty('--font-body', fontCss(readFontFamily('default')));
  root.style.setProperty('--font-terminal', fontCss(readFontFamily('terminal')));
  root.style.setProperty('--font-size-md', `${readFontSize('default')}px`);
  const heading = scaledHeadingSizes(readFontSize('headers'));
  for (const [token, px] of Object.entries(heading)) {
    root.style.setProperty(`--font-size-${token}`, `${px}px`);
  }
  root.style.setProperty('--font-terminal-size', `${readFontSize('terminal')}px`);
  ensureSelectedFontsStylesheet();
}

export function writeFontFamily(role: FontRole, family: string): void {
  writeStored(FAMILY_KEYS[role], resolveFontFamily(role, family));
  applyFontSettings();
  notifyFontSettingsChanged();
}

export function writeFontSize(role: FontRole, size: number | string): void {
  writeStored(SIZE_KEYS[role], String(clampFontSize(role, size)));
  applyFontSettings();
  notifyFontSettingsChanged();
}

export function resetFontSettings(): void {
  for (const role of Object.keys(FAMILY_KEYS) as FontRole[]) removeStored(FAMILY_KEYS[role]);
  for (const role of Object.keys(SIZE_KEYS) as FontRole[]) removeStored(SIZE_KEYS[role]);
  applyFontSettings();
  notifyFontSettingsChanged();
}
