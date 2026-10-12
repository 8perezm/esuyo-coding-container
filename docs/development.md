# Development Guide

Setup and contribution guide for working on the `coding-container` CLI itself.

## Prerequisites

- Node.js >= 18 (ESM, `structuredClone`)
- Docker, `kubectl` (pointed at your Kubernetes cluster), and an OpenSSH toolchain (`ssh`, `ssh-keygen`) on `PATH`
- Access to the container registry and the NFS server for end-to-end runs
- For the web GUI: the client has its own install (`web/client/package.json`, React + Vite + Tailwind)

## Run from source

```sh
npm install
node src/index.js --help
```

Or install it as a global command so `coding-container` resolves anywhere:

```sh
npm link
coding-container --help
```

(`npm unlink -g coding-container` to remove the global link.)

Config resolution (`resolveDefaultConfigPath()` in `src/config.js`): an explicit `-c/--config` wins, then `./config.yaml` in the current working directory, then `config.yaml` at the repo root. The `-p/--project` flag instead selects a registered project from the shared registry (`<globalDir>/projects.json`, same store the GUI uses; see `src/utils/projects.js`). The project config is layered over the global config at `~/.config/<leaf>/config.yaml` (leaf default `coding-container`, per-checkout via `CODING_CONFIG_LEAF` in the repo-root `.env`). Relative config paths resolve against each config file's own directory, so you can run commands from any folder.

## Run the web GUI from source

The GUI is two processes in dev, one in production:

```sh
npm --prefix web/client install   # first time only (separate lockfile)
node web/dev.js                   # backend API + Vite frontend together
node web/kill-dev.js              # kill orphaned dev servers holding the dev ports
```

Dev URLs: the frontend on `:3000`, the API on the `.env` `PORT` (default `3001`); Vite proxies `/api` (including terminal websockets) at the API. Production: `npm --prefix web/client run build` emits `web/client/dist/`, and `node web/server/server.js` (same `.env`) serves the API + the built SPA on one port. Copy `.env.example` to `.env` and set `ADMIN_EMAIL` + `ADMIN_PASSWORD` first, or sign-in always fails. The dev launcher warns when `.env` is missing and refuses to start when `web/client/node_modules` is absent.

## Run the desktop app from source

```sh
npm --prefix web/client run build   # refresh the bundled GUI (repo root)
npm --prefix electron install       # first time only
npm --prefix electron run dev
```

Dev uses the repo-root GUI build and keeps its sign-in under Electron's `userData` folder, so it never touches the repo `.env`. Installers (`dist:win`, `dist:mac`, `dist:linux`, portable) and signing placeholders are covered in [Desktop](./desktop.md) and `electron/README.md`.

## Configuration layering

Understanding the merge order is essential when adding config:

1. `DEFAULTS` in `src/config.js`: every key must exist here. Environment-specific keys (`image.registry`, `nfs.server`, `nfs.basePath`) are intentionally blank: they must come from the global config (created by `setup`) and `validate()` fails with a "run setup" message if they're missing. The base-layer default namespace comes from `defaultNamespace()` (`CODING_NAMESPACE`, default `coding`).
2. The **global config** `~/.config/<leaf>/config.yaml` (honors `XDG_CONFIG_HOME`; leaf from `CODING_CONFIG_LEAF` in the checkout `.env`), if present, holds shared environment settings.
3. The **project config** passed via `-c` (defaults to `<repo>/config.yaml`) holds project-specific values.
4. CLI flags: currently only `project` and `image.tag`, assembled in `cfgFrom()` in `src/index.js`.

`deepMerge()` merges plain objects recursively and replaces arrays/scalars wholesale. Relative path fields (`image.dockerfile`, `image.context`, `ssh.keyDir`) are resolved to absolute paths **per layer** by `withPaths()` before merging, so a value in the global layer resolves against the global config's directory, not the project's. When no layer sets `ssh.keyDir`, the key dir defaults to `keys/` inside the global config directory (one shared key pair for all projects). Add new validation rules in `validate()`.

## Adding a new command

1. Create `src/commands/<name>.js` exporting an `async function <name>(cfg, options)` that receives the fully-merged config.
2. Import it in `src/index.js` and add a `program.command(...)` block; build options with `.option(...)` and call `cfgFrom()` inside the action (see the `create` or `deploy` blocks for the pattern).
3. Use `run()` for visible subcommands (docker/kubectl/ssh) and `exec()` when you need the stdout; pipe stdin with `runWithInput()`.
4. Throw `Error` with a human-readable message on failure. The top-level `catch` in `src/index.js` handles exit codes.

## Adding a Kubernetes resource

1. Add a renderer function next to the existing ones in `src/utils/manifest.js` (each returns a plain object; label with both `app: <project>` (used by the service selector and per-project lookups) and `coding-container: "true"`, which is what the `-l coding-container=true` list commands filter on).
2. Include it in the `docs` array of `fullManifest()` so it is applied by `deploy`.
3. Add a matching `kubectl delete <kind>` line in `src/commands/delete.js` so teardown stays complete.

## Modifying the image

The repo's `Dockerfile` is the packaged **starting point**: `coding-container setup` copies it into the global config folder (`~/.config/coding-container/Dockerfile`) on first run, and that **personal copy** is what the build uses. Tweak your copy to change the image. It's yours alone and never gets committed to a project. To improve the starting point that every developer receives, edit the repo's `Dockerfile`. To expose a new knob:

1. Add `ARG NAME=default` near the top.
2. Use it in a `RUN`.
3. Add `NAME: default` to `image.buildArgs` in the global config (`~/.config/coding-container/config.yaml`) **and** to `DEFAULTS.image.buildArgs` in `src/config.js` (they keep in sync manually).

The build installs are intended to fail fast: opencode, pi, herdr, and turbo are installed with version checks (`herdr --version`, corepack `pnpm/yarn --version`) so a broken installer fails the build instead of silently producing a container missing the tools. Note `curl ... | bash/sh` pipes rely on the receiver's exit code. Wrap future installs the same way (download-then-run or explicit version check) rather than assuming `pipefail`.

One knob exists in the Dockerfile but not in the shipped config templates: `INSTALL_PLAYWRIGHT` (default `true`). Add `INSTALL_PLAYWRIGHT: "false"` to `image.buildArgs` in a config to skip the Playwright + Chromium install (faster builds, smaller image, no browser in the container).

Packaging gotchas the current Dockerfile already works around: Ubuntu 26.04 ships `fd` as `/usr/bin/fdfind` (the symlink handles that and `/usr/bin/fd-find` for other base images), and opencode installs into `/root/.opencode/bin`, which is added to `PATH` via `ENV` and `/etc/profile.d` so non-interactive shells see it. If you change `BASE_IMAGE`, re-check both.

## Debugging tips

- **Validate the config and the rendered manifest without touching the cluster:**
  ```sh
  coding-container validate            # summary of the merged config
  coding-container validate --manifest | kubectl apply --dry-run=client -f -
  ```
  (Add `--validate=false` to the kubectl call only when the API server is unreachable; OpenAPI download is otherwise required for validation.)
- **GUI misbehaving:** the dev launcher tags each line (`[api]` / `[web]`). The API is the same CLI you already know — reproduce any failing job by copying its `$ node src/index.js ...` line from the job log and running it in a terminal. `GET /api/health` tells you whether the backend is up; a `{"message":"GUI not built"}` response on `/` means `web/client/dist` was never built.
- **Check the live state:**
  ```sh
  kubectl -n coding get deploy,svc,cm,pod -l coding-container=true
  kubectl -n coding logs deploy/<project> --tail=50
  kubectl -n coding describe pod -l app=<project>
  ```
- **Pod stuck in `ContainerCreating`:** usually NFS: the node can't reach the NAS, or `nfs.basePath` doesn't exist on it (the per-project `subPath` folder is created by the kubelet, but the base export must exist). `kubectl -n coding describe pod` shows the mount error.
- **`ImagePullBackOff`:** the pod has no usable pull secret. Resolution order on `deploy` (`ensurePullSecret()` in `src/utils/registry.js`): `k8s.imagePullSecret` from config → managed secret `coding-<registry-host>` → a new secret from local docker credentials (inline `~/.docker/config.json` auths, then the OS credential helper such as `docker-credential-desktop`) → an existing `dockerconfigjson` secret in the namespace matching the registry host. To force a refresh, delete the managed secret and redeploy:
  ```sh
  kubectl -n coding delete secret coding-registry-example-com
  coding-container deploy
  ```
- **One-shot SSH test without an interactive session** (reliable for automation; a command-less ssh session fed by a pipe can hang):
  ```sh
   ssh -i ~/.config/coding-container/keys/id_ed25519 -p <nodePort> -o StrictHostKeyChecking=no root@<nodeIP> 'bash -lc "pwd; node --version"'
  ```
  `bash -lc` mimics the login shell of a real interactive session, including the `cd /workspace`.
- **Stale images:** the pod spec uses `imagePullPolicy: Always`, so every new pod re-checks the registry (a pull is a cheap manifest check when the digest is unchanged). There is no unpinned/`latest` path: custom-mode images are always built + pushed with an explicit tag, and global-mode deploys resolve to a semver version from the `coding-system` ConfigMap (the float) or a project pin; with Always, a plain `deploy` never serves a stale cached image.

## Tests

The suite is hermetic (no cluster, registry, docker build or network) and runs with Node's built-in test runner:

```sh
npm test
node --test test/gc.test.js     # a single file
```

- Pure unit tests cover `planGc`/`imageTag` (`test/gc.test.js`), semver (`test/semver.test.js`), the `coding-system` ConfigMap and the tag float (`test/system-config.test.js`), `${VAR}` expansion + Secret rendering (`test/secrets.test.mjs`), docker-credential resolution (`test/registry.test.mjs`), NodePort ownership (`test/nodeport-owner.test.mjs`), node/pod JSON parsing + Ready-node picking (`test/node-ip.test.js`), checkout `.env` + `CODING_*` validation (`test/instance-env.test.mjs`), and the `nfs.volumes` / `web.ports` / `sidecars` validators + manifest renderers (`test/volumes.test.mjs`, `test/web-nodeports.test.mjs`, `test/sidecar-nodeports.test.mjs`).
- `test/dockerfile-lazy.test.mjs` pins the lazy-Dockerfile contract: `loadConfig` succeeds with no Dockerfile anywhere on disk, while `buildImage` fails fast on a missing Dockerfile/context.
- Integration tests (`test/registry-api.test.mjs`, `test/cli-gc.test.mjs`, `test/cli-system.test.mjs`) start an in-process mock Docker Registry and stub the cluster/toolchain by pointing `KUBECTL_BIN` at a `.js` script and `DOCKER_BIN` at a `.js` script, so the real CLI runs end-to-end without a cluster.
- GUI tests run in the same `npm test` glob: backend `web/server/server.test.mjs` (auth, registry, validate/manifest drafts, job argv, cluster endpoints) and `web/server/ssh-terminal.test.mjs` (routing, frame codec, upgrade flow), frontend `web/client/src/**/*.test.mjs` (job helpers), and root-level `test/web-client-*.test.mjs` (ops, pages, projects/deploy flows, images/system, system jobs).
- Optional personal values: copy `test/fixtures.local.example.mjs` to the gitignored `test/fixtures.local.mjs`; `test/personal.mjs` then feeds your real registry/NFS into the same assertions. Leave it absent in CI.

When adding a command or manifest renderer, add a hermetic test next to the existing ones; never hit a real cluster or registry from `npm test`.

## Conventions

- ES modules only (`import`/`export`), Node built-ins via `node:` prefix.
- Keep `src/utils` free of command knowledge; commands orchestrate, utils implement.
- No new runtime dependencies without good reason. The CLI deliberately shells out to docker/kubectl/ssh instead of embedding SDKs. The GUI backend adds only `js-yaml` + `ssh2` (already CLI dependencies); the terminal WebSocket is hand-rolled on builtins, not the `ws` package.
- GUI-visible copy never mentions the CLI: no commands, flags, or `node src/index.js` renderings in pages, buttons, or desktop windows (`AGENTS.md`). Docs under `./docs` may show commands; the shipped UI must not.
- On Windows, never `Start-Process npm` (fails with `%1 is not a valid Win32 application`); run the underlying script directly (`node web/dev.js`). Bound every potentially-hanging call (`--test-timeout` for `node --test`, `Wait-Process -Timeout` for detached launches) and treat ~60 s of silence as hung.
