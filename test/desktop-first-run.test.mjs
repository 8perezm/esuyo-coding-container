import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// First-run sign-in happens inside the main window (same size, never
// closed/replaced): there is no separate setup window, and a fresh
// registration continues to the setup page in that same window.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mainPath = path.join(root, 'electron', 'main.js');
const preloadPath = path.join(root, 'electron', 'preload.js');
const builderPath = path.join(root, 'electron', 'electron-builder.yml');
const setupHtmlPath = path.join(root, 'electron', 'setup.html');
const authPath = path.join(root, 'web', 'client', 'src', 'auth', 'RequireAuth.tsx');

const main = await readFile(mainPath, 'utf8');
const preload = await readFile(preloadPath, 'utf8');
const builder = await readFile(builderPath, 'utf8');
const auth = await readFile(authPath, 'utf8');

describe('desktop first-run (main window)', () => {
  it('has no separate setup window', () => {
    assert.ok(!main.includes('showSetupWindow'), 'must not define a setup window helper');
    assert.ok(!main.includes('setupWindow'), 'must not track a second window');
    assert.ok(!main.includes('setup.html'), 'must not load a setup file');
    assert.ok(!main.includes('desktop:save-setup'), 'must not handle setup IPC');
  });

  it('starts the server without stored credentials and opens the main window on the register form', () => {
    assert.ok(main.includes('credentials?.email'), 'server must start with an empty fallback when unregistered');
    assert.match(main, /\/login\?next=/);
    assert.ok(main.includes('/setup'), 'fresh install must land on a next=/setup register form');
    assert.match(main, /function createMainWindow\(initialUrl\)/);
    assert.ok(main.includes('mainWindow.loadURL(initialUrl)'), 'single window must load the initial URL');
  });

  it('does not bundle a setup page or expose a setup bridge', async () => {
    assert.ok(!builder.includes('setup.html'), 'packaging must not bundle setup.html');
    assert.ok(!preload.includes('desktopSetup'), 'preload must not expose a setup bridge');
    assert.ok(!preload.includes('desktop:save-setup'), 'preload must not call setup IPC');
    await assert.rejects(() => readFile(setupHtmlPath, 'utf8'), 'setup.html must be removed');
  });
});

describe('new-user redirect to setup', () => {
  it('sends a fresh registration to /setup in the same window', () => {
    const registerIdx = auth.indexOf('await register(');
    assert.ok(registerIdx !== -1, 'must call register for new accounts');
    const setupIdx = auth.indexOf("navigate('/setup'", registerIdx);
    assert.ok(setupIdx !== -1 && setupIdx - registerIdx < 500, 'register must navigate to /setup');
  });

  it('keeps sign-in redirects on the next param', () => {
    const loginIdx = auth.indexOf('await login(');
    assert.ok(loginIdx !== -1, 'must call login for existing accounts');
    assert.ok(auth.includes("params.get('next') || '/'"), 'sign-in must still honor next');
  });
});
