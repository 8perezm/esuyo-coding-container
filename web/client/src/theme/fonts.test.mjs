import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FONT_CATALOG,
  FONT_FAMILY_DEFAULTS,
  FONT_SIZE_DEFAULTS,
  buildGoogleFontsUrl,
  clampFontSize,
  fontCss,
  readFontFamily,
  readFontSize,
  resetFontSettings,
  resolveFontFamily,
  scaledHeadingSizes,
  writeFontFamily,
  writeFontSize,
} from './fonts.ts';

test('catalog holds 36 families: 10 monospace, 10 serif', () => {
  assert.equal(FONT_CATALOG.length, 36);
  assert.equal(FONT_CATALOG.filter((d) => d.category === 'monospace').length, 10);
  assert.equal(FONT_CATALOG.filter((d) => d.category === 'serif').length, 10);
});

test('resolveFontFamily: known family wins, unknown falls back per role', () => {
  assert.equal(resolveFontFamily('terminal', 'Fira Code'), 'Fira Code');
  assert.equal(resolveFontFamily('terminal', 'Not A Font'), FONT_FAMILY_DEFAULTS.terminal);
  assert.equal(resolveFontFamily('headers', undefined), FONT_FAMILY_DEFAULTS.headers);
});

test('readers return defaults when nothing is stored', () => {
  resetFontSettings();
  assert.equal(readFontFamily('headers'), 'Space Grotesk');
  assert.equal(readFontFamily('default'), 'Manrope');
  assert.equal(readFontFamily('terminal'), 'Roboto Mono');
  assert.equal(readFontSize('headers'), 16);
  assert.equal(readFontSize('default'), 13);
  assert.equal(readFontSize('terminal'), 14);
});

test('clampFontSize: clamps to range, rounds, rejects junk', () => {
  assert.equal(clampFontSize('headers', 99), 24);
  assert.equal(clampFontSize('headers', 1), 14);
  assert.equal(clampFontSize('default', 1), 10);
  assert.equal(clampFontSize('terminal', 1), 10);
  assert.equal(clampFontSize('default', 'abc'), FONT_SIZE_DEFAULTS.default);
  assert.equal(clampFontSize('default', Number.NaN), FONT_SIZE_DEFAULTS.default);
  assert.equal(clampFontSize('default', '15'), 15);
  assert.equal(clampFontSize('terminal', 15.6), 16);
});

test('write/read roundtrip persists clamped values', () => {
  resetFontSettings();
  writeFontFamily('terminal', 'Fira Code');
  assert.equal(readFontFamily('terminal'), 'Fira Code');
  writeFontFamily('terminal', 'Not A Font');
  assert.equal(readFontFamily('terminal'), FONT_FAMILY_DEFAULTS.terminal);
  writeFontSize('headers', 99);
  assert.equal(readFontSize('headers'), 24);
  writeFontSize('default', 'abc');
  assert.equal(readFontSize('default'), FONT_SIZE_DEFAULTS.default);
  resetFontSettings();
  assert.equal(readFontFamily('terminal'), FONT_FAMILY_DEFAULTS.terminal);
  assert.equal(readFontSize('headers'), FONT_SIZE_DEFAULTS.headers);
});

test('scaledHeadingSizes: 2xl tracks the base, hierarchy stays proportional', () => {
  assert.deepEqual(scaledHeadingSizes(16), { xl: 15, '2xl': 16, '3xl': 18, '4xl': 20, '5xl': 24 });
  const scaled = scaledHeadingSizes(20);
  assert.equal(scaled['2xl'], 20);
  assert.equal(scaled['4xl'], 25);
  assert.ok(scaled['5xl'] > scaled['4xl'] && scaled['xl'] < scaled['2xl']);
});

test('fontCss: resolves family with fallback stack, unknown uses default', () => {
  assert.equal(fontCss('Inter'), `'Inter', ui-sans-serif, system-ui, sans-serif`);
  assert.equal(fontCss('JetBrains Mono'), `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`);
  assert.equal(fontCss('Nope'), fontCss('Manrope'));
});

test('buildGoogleFontsUrl: encodes families with catalog weights', () => {
  const url = buildGoogleFontsUrl(['Space Grotesk', 'DM Mono']);
  assert.ok(url.startsWith('https://fonts.googleapis.com/css2?'));
  assert.ok(url.includes('family=Space+Grotesk:wght@500;600;700'));
  assert.ok(url.includes('family=DM+Mono:wght@400;500'));
  assert.ok(url.endsWith('&display=swap'));
});
