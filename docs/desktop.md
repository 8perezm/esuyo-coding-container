# Desktop app

What the installable Electron wrapper adds around the unchanged web GUI and CLI.

The desktop app (`electron/`) is a thin shell: the web GUI and the terminal workflow run exactly as they do under plain Node. The main process starts the bundled GUI server on a loopback port and shows it in a window, adding only what an installed app needs.

## What it adds

- **First-run sign-in in the main window**: when no account exists yet, the app opens the main window on the sign-in page, which offers registration (validated: real email shape, password ≥ 8 characters). The new account continues to the setup page in the same window.
- **Encrypted sign-in storage:** the account is kept with the OS keychain (`safeStorage`, `credentials.enc` under Electron `userData`). Launch signs in automatically and lands on the dashboard; an explicit sign-out forgets the account so the next launch asks again. Password changes in the Profile page stay in sync with the encrypted copy. When no keychain is available the app offers to continue without staying signed in (Linux without a keyring gets a reduced-protection warning).
- **Missing-tool warnings:** on startup it checks for Docker, Kubernetes access (`kubectl`), and the SSH key generator and names what each is needed for before the dashboard opens.
- **Single instance + auto-update:** a second launch focuses the open window; packaged builds (except Store packages) update from GitHub releases via `electron-updater`. When a newer release is found, a line at the bottom of the navigation shows it — selecting it installs the downloaded update, or opens the download location when it still has to be fetched.
- **Log file:** GUI output persists to `<userData>/logs/gui-server.log`, since desktop apps have no visible console. An unexpected server stop shows the log path in an error dialog.

Dev runs never touch the repo `.env`: the main process passes the stored account as the server's sign-in via the environment, on a free loopback port.

## Run and build

```sh
npm --prefix web/client run build   # refresh the bundled GUI (repo root)
npm --prefix electron install       # first time only
npm --prefix electron run dev       # run the shell
```

Installers (output in `electron/dist/`, unsigned local builds need `CSC_IDENTITY_AUTO_DISCOVERY=false`):

```sh
npm --prefix electron run dist:win             # NSIS (.exe) + MSIX (.msix) + portable (.exe)
npm --prefix electron run dist:win-portable    # portable exe only (no install needed)
npm --prefix electron run dist:mac             # DMG + ZIP
npm --prefix electron run dist:linux           # AppImage + deb
```

Tagged `desktop-v*` pushes (or manual dispatch) build all three OS installers in CI (`.github/workflows/desktop.yml`) and upload them as artifacts.

## Packaging notes

- `electron-builder.yml` bundles with `asar: false` (the backend spawns processes with the bundle root as working directory and resolves the Dockerfile/config next to it, so it needs real files): the main/preload/launcher files, `src/`, `web/server/`, the built `web/client/dist/`, root `config.yaml` + `Dockerfile`, and an allowlisted production `node_modules` closure (mirrors `electron/package.json` dependencies; drift breaks the packaged app and the boot test catches it). The root `package.json` is deliberately not bundled — the desktop manifest at the bundle root carries the synced version.
- Keep `electron/package.json` `version` in sync with the root `package.json`.
- The `msix` block uses placeholder identity values; replace them with the Partner Center values before a Microsoft Store submission. Store installs update via the Store; the NSIS build auto-updates from GitHub releases.
- `electron-builder` is pinned to `27.0.0-alpha.10` (first line with the `msix` target); move to stable v27 when it lands.
- Full run/build reference lives in `electron/README.md`.

## See also

- [Web GUI](./gui.md): the pages running inside the window
- [Architecture](./architecture.md): main-process internals (§10)
- [Build & Deployment](./build-and-deployment.md): CI installers and releases
