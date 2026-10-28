# Development Guide

Setup and contribution guide for working on the app itself.

You will run the web pages and the desktop shell from source, and you will touch the background engine in `src` when you change deploy behavior. Most day to day checks happen in the browser with validation, preview, and the Jobs log.

## Prerequisites

* Node.js 18 or newer with ESM and `structuredClone`
* Docker, `kubectl` pointed at your Kubernetes cluster, and OpenSSH tools with `ssh` and `ssh-keygen` on PATH
* Access to the container registry and the NFS server for full runs
* For the web pages: the client has its own install in `web/client/package.json` with React plus Vite plus Tailwind

## Run from source

```sh
npm install
```

The background engine lives in `src`. You rarely need to run it directly because the app runs it for you as jobs. For the shell form of every task, see [Terminal use](./cli-reference.md).

Config resolution in `resolveDefaultConfigPath()` in `src/config.js`: an explicit path wins, then `./config.yaml` in the current working directory, then `config.yaml` at the repo root. The app picker selects a registered project from the shared registry at `<globalDir>/projects.json`, the same store the pages use, see `src/utils/projects.js`. The project config layers over the global config at `~/.config/<leaf>/config.yaml`, leaf default `coding-container` and per checkout with `CODING_CONFIG_LEAF` in the repo root `.env`. Relative config paths resolve against each config file own folder, so runs work from any folder.

## Run the web GUI from source

The GUI is two processes in dev, one in production:

```sh
npm --prefix web/client install
node web/dev.js
node web/kill-dev.js
```

The first line is first time only with its own lockfile. The second runs backend API plus Vite frontend together. The third stops orphaned dev servers holding the dev ports.

Dev addresses: the frontend on `:3400`, the API on the `.env` `PORT` default `3401`. Vite proxies `/api` including terminal websockets at the API. Production: `npm --prefix web/client run build` emits `web/client/dist/`, and `node web/server/server.js` with the same `.env` serves the API plus the built pages on one port. Copy `.env.example` to `.env` first. The first launch migrates a legacy `ADMIN_EMAIL` plus `ADMIN_PASSWORD` into the hashed credential file. After that the Sign in page asks to create the account on the local machine when none exists. The dev launcher warns when `.env` is missing and refuses to start when `web/client/node_modules` is absent.

## Run the desktop app from source

```sh
npm --prefix web/client run build
npm --prefix electron install
npm --prefix electron run dev
```

The first line refreshes the bundled pages from the repo root. The second is first time only. The third opens the shell.

Dev keeps its sign in under Electron `userData`, so it never touches the repo `.env`. Installers for win, mac and linux plus signing placeholders are covered in [Desktop](./desktop.md) and `electron/README.md`.

## Configuration layering

Understanding the merge order is essential when adding config:

1. `DEFAULTS` in `src/config.js`. Every key must exist here. Environment specific keys such as `image.registry`, `nfs.server` and `nfs.basePath` stay empty on purpose. They must come from the global config created on the Setup page, and validation reports a friendly missing value message when they are absent. The base layer default namespace comes from `defaultNamespace()` with `CODING_NAMESPACE` default `coding`.
2. The **global config** at `~/.config/<leaf>/config.yaml`, honors `XDG_CONFIG_HOME` with leaf from `CODING_CONFIG_LEAF` in the checkout `.env` when present, holds shared environment settings.
3. The **project config** passed in by path, defaults to `<repo>/config.yaml`, holds project specific values.
4. Run time choices from the app, currently project and `image.tag`, assembled in `cfgFrom()` in `src/index.js`.

`deepMerge()` merges plain objects recursively and replaces arrays and scalars wholesale. Relative path fields such as `image.dockerfile`, `image.context` and `ssh.keyDir` resolve to absolute paths per layer with `withPaths()` before merging, so a value in the global layer resolves against the global config folder, not the project. When no layer sets `ssh.keyDir`, the key folder defaults to `keys` inside the global config folder, one shared pair for all projects. Add new validation rules in `validate()`.

## Add a new background task

Background work lives in `src/commands/<name>.js`. The app exposes it as a job. The shell exposes it as a command and is documented in [Terminal use](./cli-reference.md).

1. Create `src/commands/<name>.js` exporting an `async function <name>(cfg, options)` that receives the merged config.
2. Import it in `src/index.js` and add a `program.command()` block. Build options with `.option()` and call `cfgFrom()` inside the action. See the create or deploy blocks for the pattern.
3. Add the op to the app job list in `web/server/server.js` with `ALLOWED_OPS` and `buildJobArgv()`, plus a button or form on the matching page, and a test.
4. Use `run()` for visible subcommands such as docker, kubectl and ssh and `exec()` when you need the output. Pipe stdin with `runWithInput()`.
5. Throw `Error` with a human readable message on failure. The top level `catch` in `src/index.js` handles exit codes, and the Jobs page shows the message with the log.

## Add a Kubernetes resource

1. Add a renderer function next to the existing ones in `src/utils/manifest.js`. Each returns a plain object. Label with both `app: <project>` used by the service selector and per project lookups and `coding-container: "true"`, which is what the `-l coding-container=true` list filter uses.
2. Include it in the `docs` array of `fullManifest()` so it is applied by deploy.
3. Add a matching `kubectl delete <kind>` line in `src/commands/delete.js` so removal stays complete. The app Remove action calls the same path.

## Change the image

The repo `Dockerfile` is the packaged starting point. The Setup page copies it into the global config folder at `~/.config/coding-container/Dockerfile` on first run, plus the `opencode/` defaults for the image build, and that personal copy is what the build uses. Tweak your copy to change the image. It is yours alone and never gets committed to a project. To improve the starting point that every developer receives, edit the repo `Dockerfile` or files under `opencode/`. To expose a new knob:

1. Add `ARG NAME=default` near the top.
2. Use it in a `RUN`.
3. Add `NAME: default` to `image.buildArgs` in the global config at `~/.config/coding-container/config.yaml` and to `DEFAULTS.image.buildArgs` in `src/config.js`. They keep in sync manually.

The build installs fail fast on purpose. Opencode, pi, herdr and turbo install with version checks such as `opencode --version` and `herdr --version` plus corepack `pnpm --version` and `yarn --version`, so a broken installer fails the build instead of silently producing a container missing the tools. Note that `curl ... | bash` pipes rely on the receiver exit code. Wrap future installs the same way with download then run or an explicit version check rather than assuming pipefail.

One knob exists in the Dockerfile but not in the shipped config templates: `INSTALL_PLAYWRIGHT` default true. Add `INSTALL_PLAYWRIGHT: "false"` to `image.buildArgs` in a config to skip the Playwright plus Chromium install for faster builds, a smaller image and no browser in the container.

Packaging notes the current Dockerfile already handles: Ubuntu 26.04 ships `fd` as `/usr/bin/fdfind` and the symlink covers that plus `/usr/bin/fd-find` for other base images, opencode installs into `/root/.opencode/bin`, which is added to `PATH` with `ENV` and `/etc/profile.d` so non interactive shells see it, plus pi agent dirs and opencode defaults from `opencode/`. When you change `BASE_IMAGE`, recheck both.

## Debugging tips

* **Check the config and the rendered manifests with no cluster changes:** open the project page, use Validate and Manifest preview, and read the warnings about NodePorts that are taken or claimed. `GET /api/health` tells you whether the backend is up. A `{"message":"GUI not built"}` response on `/` means `web/client/dist` was never built.
* **App acting up:** the dev launcher tags each line with `api` or `web`. Reproduce a failing job by reading its log on the Jobs page and checking the inputs on the matching page. Jobs keep the trailing logs and exit status.
* **Check the live state:**

  ```sh
  kubectl -n coding get deploy,svc,cm,pod -l coding-container=true
  kubectl -n coding logs deploy/<project> --tail=50
  kubectl -n coding describe pod -l app=<project>
  ```

* **Pod stuck in `ContainerCreating`:** usually NFS. The node cannot reach the NAS, or `nfs.basePath` does not exist on it. The project `subPath` folder is created by the kubelet, but the base export must exist. `kubectl -n coding describe pod` shows the mount error.
* **`ImagePullBackOff`:** the pod has no usable pull secret. Resolution order on deploy in `ensurePullSecret()` in `src/utils/registry.js`: `k8s.imagePullSecret` from config, then managed secret `coding-<registry-host>`, then a new secret from local docker credentials with inline `~/.docker/config.json` auths then the OS credential helper such as `docker-credential-desktop`, then an existing `dockerconfigjson` secret in the namespace matching the registry host. To force a refresh, delete the managed secret and press Deploy again:

  ```sh
  kubectl -n coding delete secret coding-registry-example-com
  ```

  Then press Deploy again on the project page.
* **One shot SSH check with no interactive session**, reliable for automation. A command less shell session fed by a pipe can hang, so pass a command:

  ```sh
   ssh -i ~/.config/coding-container/keys/id_ed25519 -p <nodePort> -o StrictHostKeyChecking=no root@<nodeIP> 'bash -lc "pwd; node --version"'
  ```

  `bash -lc` mimics the login shell of a real interactive session, including the `cd /workspace`.
* **Stale images:** the pod spec sets `imagePullPolicy: Always`, so every new pod rechecks the registry. A pull is a cheap manifest check when the digest is unchanged. There is no unpinned or `latest` path. Custom mode images are always built plus pushed with an explicit tag, and shared mode deploys resolve to a semver version from the `coding-system` ConfigMap float or a project pin. With Always, a plain Deploy never serves a stale cached image.

## Tests

The suite is hermetic with no cluster, registry, docker build or network, and runs with the Node built in test runner:

```sh
npm test
node --test test/gc.test.js
```

The second line runs a single file.

* Pure unit tests cover `planGc` and `imageTag` in `test/gc.test.js`, semver in `test/semver.test.js`, the `coding-system` ConfigMap and the tag float in `test/system-config.test.js`, `${VAR}` expansion plus Secret rendering in `test/secrets.test.mjs`, docker credential resolution in `test/registry.test.mjs`, NodePort ownership in `test/nodeport-owner.test.mjs`, node and pod JSON parsing plus Ready node picking in `test/node-ip.test.js`, checkout `.env` plus `CODING_*` validation in `test/instance-env.test.mjs`, and the `nfs.volumes`, `web.ports` and `sidecar-nodeports` validators plus manifest renderers in `test/volumes.test.mjs`, `test/web-nodeports.test.mjs` and `test/sidecar-nodeports.test.mjs`.
* `test/dockerfile-lazy.test.mjs` pins the lazy Dockerfile contract. `loadConfig` succeeds with no Dockerfile anywhere on disk, while `buildImage` fails fast on a missing Dockerfile or context.
* Integration tests in `test/registry-api.test.mjs`, `test/cli-gc.test.mjs` and `test/cli-system.test.mjs` start an in process mock Docker Registry and stub the cluster and toolchain by pointing `KUBECTL_BIN` at a `.js` script and `DOCKER_BIN` at a `.js` script, so the real engine runs end to end with no cluster.
* GUI tests run in the same `npm test` glob. Backend `web/server/server.test.mjs` covers auth, registry, validate and manifest drafts, job args, cluster endpoints, and `web/server/ssh-terminal.test.mjs` covers routing, frame codec and upgrade flow. Frontend `web/client/src/**/*.test.mjs` covers job helpers, and root level `test/web-client-*.test.mjs` covers ops, pages, projects and deploy flows, images and system, and system jobs.
* Optional personal values: copy `test/fixtures.local.example.mjs` to the gitignored `test/fixtures.local.mjs`. `test/personal.mjs` then feeds your real registry and NFS into the same assertions. Leave it absent in CI.

When adding a task or manifest renderer, add a hermetic test next to the existing ones. Never hit a real cluster or registry from `npm test`.

## Conventions

* ES modules only with `import` and `export`, Node builtins with `node:` prefix.
* Keep `src/utils` free of task knowledge. Tasks orchestrate, utils implement.
* No new runtime dependencies without good reason. The engine shells out to docker, kubectl and ssh instead of embedding SDKs. The app backend adds only `js-yaml` plus `ssh2`, already engine dependencies. The terminal WebSocket is hand rolled on builtins, not the `ws` package.
* App visible copy never mentions the shell path. No commands, flags, or engine file renderings in pages, buttons, or desktop windows, see `AGENTS.md`. Docs under `./docs` may show commands where needed for contributors, but user guides stay on pages, buttons and jobs. The full shell command list lives only in [Terminal use](./cli-reference.md).
* On Windows, never `Start-Process npm`, it fails with `%1 is not a valid Win32 application`. Run the underlying script directly, for example `node web/dev.js`. Bound every call that may hang with `--test-timeout` for `node --test` and `Wait-Process -Timeout` for detached launches, and treat about 60 seconds of silence as hung.
