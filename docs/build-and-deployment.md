# Build and Deployment

How the npm package, the web GUI bundle, and the desktop installers are built and released.

## npm package `@esuyo/coding-container`

Published publicly from `main` or `master` by `.github/workflows/publish.yml`:

1. Checkout, Node 22, `npm ci`, `npm test`.
2. Version bump from the commit message with `BREAKING CHANGE:` or `major:` as major, `feat:`, `feature:` or `minor:` as minor, else patch, committed back as `chore: bump version to X.Y.Z [skip ci]` with the skip flag to avoid a publish loop, tagged `vX.Y.Z`.
3. `npm publish --access public`, then a GitHub release for the tag.
4. Desktop job in the same run: build web GUI, sync electron version to the release, build NSIS plus MSIX plus portable and DMG plus ZIP and AppImage plus deb, upload artifacts, attach installers to the release.

The published payload in `files` in `package.json` is `src`, `Dockerfile`, `opencode/`, and `config.yaml`. The binary is `coding-container` pointing at `src/index.js`. CI syncs `electron/package.json` version to the release tag, so you do not bump it by hand for releases.

Most people never install this package directly. It powers the Deploy, Publish and similar buttons in the app. When you want the shell form, see [Terminal use](./cli-reference.md).

## Web GUI bundle

The client in `web/client` with its own `package.json` plus lockfile builds independently of the root:

```sh
npm --prefix web/client install
npm --prefix web/client run build
```

The first line is first time only. The second runs type check plus Vite build into `web/client/dist/`.

The backend serves `web/client/dist/` with SPA fallback to `index.html`. Without it, `/` answers `{"message":"GUI not built"}`. Dev needs no build. `node web/dev.js` runs the API plus Vite together, pages on `:3400` and proxying `/api` at the API target.

## Desktop installers

`.github/workflows/desktop.yml` covers manual and tag builds: `v*` and `desktop-v*` tags pushed by a person, `release published`, and manual dispatch with an optional tag input. It builds the web GUI, runs `npm --prefix electron ci`, syncs the electron version to the tag when present, then runs `electron-builder` per matrix with `dist:win` for NSIS plus MSIX plus portable, `dist:mac` for DMG plus ZIP, and `dist:linux` for AppImage plus deb, uploaded as `desktop-windows`, `desktop-macos` and `desktop-linux` artifacts. Per release builds run as the desktop job inside `publish.yml` instead, because tags made with `GITHUB_TOKEN` do not trigger other workflows. For signed or Store releases, add signing secrets and replace the MSIX placeholder identity in `electron/electron-builder.yml`. Local installer commands are in [Desktop](./desktop.md).

## Container image versions

The coding image itself versions through the Images and System pages, not through this pipeline. Open the System page once per cluster to init, then use the Images page to publish a new version. Omitting the tag bumps `maxEver` patch automatically. Roll back and cleanup live on the same pages. After a release, projects pick the new `current` up on their next Deploy. Details are in [Shared global image](./global-image.md). The shell equivalents live in [Terminal use](./cli-reference.md).

## See also

- [Development Guide](./development.md) for running everything from source
- [Desktop](./desktop.md) for installer targets and packaging notes
- [Web GUI](./gui.md) for running and configuring the GUI
