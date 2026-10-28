# Desktop app

What the installable app adds around the web pages you already know.

The desktop app is a small shell. The pages inside the window are the same as the browser app, and your projects, images and jobs look and behave the same. The shell only adds what an installed app needs to feel at home on your computer.

If you are choosing between the browser and the desktop, pick the one you like. They stay in sync through the same shared registry on your machine.

## What it adds

* **First run sign in in the main window**: when no account exists yet, the app opens the sign in page in its window. It offers registration with a real email shape and a password of 8 characters or more. The new account continues to the setup page in the same window.
* **Stay signed in**: the app keeps your sign in with the OS keychain in an encrypted file under Electron `userData`. Launch signs you in automatically and lands on the dashboard. An explicit sign out forgets the account so the next launch asks again. Password changes on the Profile page stay in sync with the saved copy. When no keychain is available the app offers to continue without staying signed in. On Linux without a keyring you see a reduced protection note.
* **Missing tool notes**: on startup it checks for Docker, Kubernetes access through `kubectl`, and the SSH key generator, and it names what each one is needed for before the dashboard opens.
* **Single copy plus updates**: a second launch focuses the open window. Packaged builds except Store packages update from GitHub releases. Each npm release attaches fresh installers, and manual tag builds cover rebuilds. When a newer release is found, a line at the bottom of the navigation shows it. Choose it to install the downloaded update, or to open the download location when it still has to be fetched.
* **Log file**: app output persists at `<userData>/logs/gui-server.log`, since desktop apps have no visible console. An unexpected server stop shows the log path in a dialog.
* **Frameless window**: the native title bar is hidden. Minimize and maximize and close live in the web header and talk back over desktop channels. The window opens at 1280 by 860 with a 960 by 640 minimum.

Running the desktop for development never touches the repo `.env`. The main process passes the stored account to the server as its sign in through the environment, on a free loopback port.

## Get it and run it

The easiest path is to download an installer from the releases page and run it like any other app.

To run from source:

```sh
npm --prefix web/client run build
npm --prefix electron install
npm --prefix electron run dev
```

The first line refreshes the bundled pages from the repo root. The second is first time only. The third opens the shell.

Installers land in `electron/dist/`. Unsigned local builds need `CSC_IDENTITY_AUTO_DISCOVERY=false`:

```sh
npm --prefix electron run dist:win
npm --prefix electron run dist:win-portable
npm --prefix electron run dist:mac
npm --prefix electron run dist:linux
```

This gives you NSIS plus MSIX plus portable on Windows, DMG plus ZIP on macOS, and AppImage plus deb on Linux. Each npm release builds all three OS installers in CI and attaches them to the release. Manual `desktop-v*` tags, `v*` tags, and manual dispatch cover rebuilds and backfills.

## Packaging notes

* `electron-builder.yml` bundles with `asar: false` so the backend keeps real files for background tasks and for Dockerfile and config lookup. It packs the main, preload and launcher files, `src`, `web/server`, the built `web/client/dist`, root `config.yaml` plus `Dockerfile` and `opencode/`, and a curated production `node_modules` set. The root `package.json` is not bundled. The desktop manifest at the bundle root carries the version synced by CI.
* CI syncs `electron/package.json` version to the release tag, so you do not bump it by hand for releases.
* The `msix` block uses placeholder identity values. Replace them with your Partner Center values before a Microsoft Store submission. Store installs update through the Store. The NSIS build updates from GitHub releases.
* `electron-builder` is pinned to `27.0.0-alpha.10`, the first line with the `msix` target. Move to stable v27 when it lands.
* Full run and build notes live in `electron/README.md`.

## See also

- [Web GUI](./gui.md) for the pages inside the window
- [Architecture](./architecture.md) for how the main process, server and pages fit together
- [Build and Deployment](./build-and-deployment.md) for CI installers and releases
- [Terminal use](./cli-reference.md) for the optional shell path
