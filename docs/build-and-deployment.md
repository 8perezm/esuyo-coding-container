# Build & Deployment

How the npm package, the web GUI bundle, and the desktop installers are built and released.

## npm package (`@esuyo/coding-container`)

Published publicly from `main`/`master` by `.github/workflows/publish.yml`:

1. Checkout, Node 22, `npm ci`, `npm test`.
2. Version bump from the commit message (`BREAKING CHANGE:`/`major:` → major, `feat:`/`feature:`/`minor:` → minor, else patch), committed back as `chore: bump version to X.Y.Z [skip ci]` (the `[skip ci]` avoids a publish loop), tagged `vX.Y.Z`.
3. `npm publish --access public`, then a GitHub release for the tag.

The published payload (`files` in `package.json`) is `src/`, `Dockerfile`, and `config.yaml`; the binary is `coding-container → src/index.js`. Keep `electron/package.json` `version` in sync with the root one (packaging check; automated releases only bump the root).

## Web GUI bundle

The client (`web/client/`, separate `package.json` + lockfile) builds independently of the root:

```sh
npm --prefix web/client install   # first time only
npm --prefix web/client run build # tsc + vite build → web/client/dist/
```

The backend serves `web/client/dist/` (SPA fallback to `index.html`); without it `/` answers `{"message":"GUI not built"}`. Dev needs no build: `node web/dev.js` runs the API plus Vite (`:3000`, proxying `/api` at the API target) together.

## Desktop installers

`.github/workflows/desktop.yml` builds unsigned installers per OS on `desktop-v*` tags (or manual dispatch): web GUI build → `npm --prefix electron ci` → `electron-builder` per matrix (`dist:win` → NSIS + MSIX + portable, `dist:mac` → DMG + ZIP, `dist:linux` → AppImage + deb), uploaded as `desktop-windows` / `desktop-macos` / `desktop-linux` artifacts. For signed/Store releases, add signing secrets and replace the MSIX placeholder identity in `electron/electron-builder.yml`. Local installer commands are in [Desktop](./desktop.md).

## Container image versions

The coding image itself versions through the `system` commands (`system init` once per cluster, `system create` per release — omitting `--tag` bumps `maxEver` patch automatically — `system rollback`, `system gc`), not through this pipeline. After a release, projects pick the new `current` up on their next deploy. Details: [Shared global image](./global-image.md).

## See also

- [Development Guide](./development.md): running everything from source
- [Desktop](./desktop.md): installer targets and packaging notes
- [Web GUI](./gui.md): running and configuring the GUI
