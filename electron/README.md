# Desktop app (Electron)

Installable Windows / macOS / Linux shell around the unchanged web GUI
(`web/`) and CLI (`src/`). The main process launches the bundled GUI server
on a loopback port and shows it in a window.

## Run in dev

```sh
npm --prefix web/client run build   # refresh the bundled GUI (repo root)
npm --prefix electron install       # first time only
npm --prefix electron run dev
```

Dev uses the repo-root GUI build and stores its sign-in under the Electron
`userData` folder, so it never touches the repo `.env`.

## Build installers

```sh
npm --prefix electron run dist:win    # NSIS (.exe) + MSIX (.msix) + portable (.exe)
npm --prefix electron run dist:win-portable  # portable exe only (no install needed)
npm --prefix electron run dist:mac    # DMG + ZIP
npm --prefix electron run dist:linux  # AppImage + deb
```

Output lands in `electron/dist/`. Unsigned local builds:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix electron run dist:win
```

## Notes

- Keep `electron/package.json` `version` in sync with the root `package.json`.
- The `msix` block in `electron-builder.yml` uses placeholder identity values;
  replace them with the Partner Center values before a Microsoft Store
  submission. Store installs update via the Store; the NSIS build auto-updates
  from GitHub releases via `electron-updater`.
- `electron-builder` is pinned to `27.0.0-alpha.10` (first line with the `msix`
  target). Move to stable v27 when it lands.
