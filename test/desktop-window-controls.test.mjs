import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Electron window is frameless, so the sign-in view needs the same
// minimize / maximize / close buttons as the main header.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const authPath = path.join(root, 'web', 'client', 'src', 'auth', 'RequireAuth.tsx');
const headerPath = path.join(root, 'web', 'client', 'src', 'components', 'layout', 'Header.tsx');
const controlsPath = path.join(root, 'web', 'client', 'src', 'components', 'layout', 'WindowControls.tsx');
const cssPath = path.join(root, 'web', 'client', 'src', 'index.css');

const auth = await readFile(authPath, 'utf8');
const header = await readFile(headerPath, 'utf8');
const controls = await readFile(controlsPath, 'utf8');
const css = await readFile(cssPath, 'utf8');

describe('desktop window controls on the login screen', () => {
  it('reuses the shared WindowControls (minimize / maximize / close)', () => {
    assert.ok(auth.includes('WindowControls'), 'login view must render WindowControls');
    assert.ok(
      auth.includes("from '../components/layout/WindowControls'"),
      'login view must reuse the shared header controls',
    );
    for (const ref of ['window-minimize', 'window-toggle-maximize', 'window-close']) {
      assert.ok(controls.includes(ref), `shared controls must include ${ref}`);
    }
  });

  it('shows the controls only inside the desktop app', () => {
    assert.ok(auth.includes('isDesktopApp'), 'login view must gate controls on isDesktopApp()');
    assert.ok(header.includes('isDesktopApp'), 'header must keep its desktop gate');
    assert.ok(auth.includes('login-titlebar'), 'login controls must live in a title bar container');
    assert.ok(auth.includes('showWindowControls'), 'login title bar must render conditionally');
  });

  it('makes the login title bar draggable like the main header', () => {
    assert.ok(css.includes('.login-titlebar'), 'missing .login-titlebar style');
    const titlebarIdx = css.indexOf('.login-titlebar');
    assert.ok(titlebarIdx !== -1);
    assert.ok(css.includes('.electron .login-titlebar'), 'login title bar must define an .electron drag region');
    const electronBlock = css.slice(css.indexOf('.electron .login-titlebar'), css.indexOf('.electron .login-titlebar') + 300);
    assert.ok(electronBlock.includes('-webkit-app-region: drag'), 'login title bar must be draggable');
    assert.ok(css.includes('.window-controls'), 'shared window controls style must remain');
  });

  it('tags the login view as an Electron surface for frameless styling', () => {
    assert.ok(
      auth.includes("document.documentElement.classList.add('electron')"),
      'login view must add the electron class in desktop mode',
    );
  });
});
