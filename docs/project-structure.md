# Project Structure

Directory layout of `esuyo-coding-container` and the role of each file.

```
esuyo-coding-container/
├── package.json            # ESM package, bin entry "coding-container" -> src/index.js
├── package-lock.json
├── config.yaml             # Project-specific config (project name, nodePort); layers over the global config
├── Dockerfile              # Packaged starting point: `setup` copies it to ~/.config/<leaf>/; the build uses that personal copy
├── .env                    # gitignored checkout identity (CODING_* + GUI server settings); copy .env.example
├── .env.example            # template for .env (instance + ADMIN_EMAIL/ADMIN_PASSWORD/PORT)
├── LICENSE                 # MIT
├── AGENTS.md               # agent guidelines (GUI copy rules, Windows command discipline)
├── .gitignore              # Ignores .opencode/, node_modules/, keys/, *.pem, .env, test/fixtures.local.mjs, electron/dist/
├── .github/workflows/publish.yml  # On push to main/master: npm test, semver bump from the commit message, tag, npm publish, GitHub release
├── .github/workflows/desktop.yml  # On desktop-v* tags / manual: build web GUI + Electron installers per OS, upload artifacts
├── docs/                   # Developer documentation (+ build/ design history, kept as history)
├── spec/                   # Pre-implementation discussion notes (e.g. docker-local-mode.md; pondering, not shipped)
├── test/                   # node:test suite (run with `npm test`); hermetic, no cluster/registry/network needed
├── src/
│   ├── index.js            # CLI entrypoint: commander program, command wiring, global flags (-c/-p/--project-name/--tag)
│   ├── config.js           # Config file resolution (cwd -> repo), layered merge (defaults -> global -> project -> CLI), path resolution, validation
│   ├── commands/
│   │   ├── setup.js        # one-time global setup: copies Dockerfile + .dockerignore, captures registry/NFS (flags > TTY prompt > placeholder), config template, key pair
│   │   ├── build.js        # buildImage() (raw docker build) + build (guarded: custom mode + tag; global mode: use 'system create')
│   │   ├── push.js         # pushImage() (raw docker push, login hint on failure) + push (same guards)
│   │   ├── deploy.js       # tag float (resolveDeployTag) + SSH key + namespace + NodePort preflight + pull secret + manifest apply + rollout wait + SSH alias in ~/.ssh/config
│   │   ├── create.js       # deploy pipeline: global mode floats on the shared image, custom mode builds + pushes the project image first
│   │   ├── ssh.js          # port-forward (default, auto port fallback) or direct node; null-device UserKnownHostsFile (ephemeral host keys)
│   │   ├── list.js         # list (read the managed ~/.ssh/config aliases), list update (re-point aliases at a Ready node + live service nodePort)
│   │   ├── delete.js       # delete deployment/service/ingress + <project>-ssh ConfigMap + <project>-env Secret (--keep-secrets) + remove SSH alias
│   │   ├── validate.js     # load + validate the config, print a summary or the rendered k8s manifests (--manifest)
│   │   ├── gc.js           # imageTag(), planGc() retention plan, gcTags() shared pruner, gc (project's custom repo, custom mode only)
│   │   ├── projects.js     # projects list (tabular/--json view of the shared registry)
│   │   └── system.js       # the 'system' group: init/get/list/create/rollback/gc of the shared global image (ConfigMap 'coding-system')
│   └── utils/
│       ├── exec.js         # spawn helpers: exec (captured), run (streamed), runWithInput, start + dockerExec() (DOCKER_BIN override)
│       ├── envsubst.js     # ${VAR} expansion (local shell -> config) for k8s.env / k8s.secretEnv; missing vars fail fast
│       ├── instance.js     # checkout identity: one-shot .env loader + CODING_CONFIG_LEAF/_SSH_PREFIX/_NAMESPACE
│       ├── keys.js         # ed25519 key pair generation via ssh-keygen, public key reader
│       ├── manifest.js     # ConfigMap/Deployment/Service/Ingress + <project>-env Secret renderers + web.ports normalization + k8s.sidecars pass-through (env-map conversion, nodePort stripping) + nfs.volumes mounts + multi-doc YAML
│       ├── node-ip.js      # SSH target IP: pod hostIP when its node is Ready, else first Ready node (json output, Windows-safe)
│       ├── project.js      # project bootstrap: name from folder, free NodePort, minimal config.yaml, NodePort ownership lookup (deploy preflight)
│       ├── projects.js     # shared CLI↔GUI registry: paths, slugs, ref matching, managed-config helpers
│       ├── registry.js     # pull-secret resolution (config option, docker creds, existing secrets)
│       ├── registry-api.js # Docker Registry V2 client for gc: list/delete tags, Bearer/Basic auth, Link pagination
│       ├── semver.js       # strict vX.Y.Z validation, numeric compare, semver/all-tag sorting, patch auto-bump
│       ├── system-config.js# the coding-system ConfigMap: read (getSystemConfig), write (patchSystemConfig), validation, resolveDeployTag (the float), kubectlExec (KUBECTL_BIN override)
│       └── ssh-config.js   # managed block in ~/.ssh/config: add/remove/list Host aliases, null-device UserKnownHostsFile, legacy known_hosts cleanup
├── web/
│   ├── dev.js              # GUI dev launcher: backend API + Vite frontend together (node web/dev.js)
│   ├── kill-dev.js         # kill orphaned dev servers still holding the dev ports
│   ├── projects.json       # legacy dev registry (migrated once into the shared store; do not rely on it)
│   ├── server/
│   │   ├── server.js       # GUI backend: .env/auth/registry/reads/job runner/static SPA (see architecture §7)
│   │   ├── ssh-terminal.js # browser terminal WebSocket transport (kubectl port-forward + ssh2 pty bridge)
│   │   ├── server.test.mjs # backend tests (auth, registry, validate/manifest, jobs, cluster endpoints)
│   │   └── ssh-terminal.test.mjs  # terminal transport tests (routing, frame codec, upgrade flow)
│   └── client/             # React 18 + TS + Vite + Tailwind SPA (served from web/client/dist by the backend)
│       ├── package.json    # separate install/lockfile (npm --prefix web/client install); scripts: dev/build/preview
│       ├── vite.config.ts  # dev :3400 + /api proxy (incl. websockets) at VITE_API_TARGET (default 127.0.0.1:3401)
│       └── src/
│           ├── App.tsx     # routes (/login, /register, /, /projects..., /images, /system, /ssh-keys, /setup, /jobs, /profile, /theme)
│           ├── auth/       # AuthContext + RequireAuth/LoginPage (session-cookie flow)
│           ├── lib/        # api.ts (same-origin fetch client), projects.tsx, systemJobs.ts
│           ├── components/ # layout (Sidebar/Header/Layout/ProfileBlock/ThemeToggle), ui kit, JobOutput, ValidatePanel, YamlEditor, ProjectDeployTab
│           ├── pages/      # Dashboard, Projects (+ new/import/edit), Images, System, SSH keys, Setup, Jobs, Profile, Theme, SSH terminal, placeholders
│           └── theme/      # useTheme (dark/light), fonts (per-browser font + size settings)
└── electron/               # installable desktop shell around the unchanged web GUI + CLI
    ├── package.json        # private package; version kept in sync with the root one; dev/pack/dist scripts
    ├── electron-builder.yml# packaging (no asar; bundles main/preload/launcher + src + web/server + client dist + config/Dockerfile + prod node_modules)
    ├── main.js             # main process: encrypted sign-in, loopback server, window, tool checks, auto-update
    ├── preload.js          # sandboxed bridge (auth sync: sign-in / password change / sign-out)
    ├── server-launcher.mjs # utility-process launcher for the bundled GUI server
    └── README.md           # desktop run/build notes (dev, installers, signing placeholders)
```

## Notes

- **Config is layered.** The project `config.yaml` (what a repo commits) overrides the global config at `~/.config/<leaf>/config.yaml` (leaf default `coding-container`, per-checkout via `CODING_CONFIG_LEAF` in `.env`), which overrides built-in defaults; CLI flags win over all of it. Every relative path in a layer (`dockerfile`, `context`, `keyDir`) resolves against that layer's own directory, so the CLI works from any working directory. `CODING_NAMESPACE` sets the default namespace underneath all of it (config files still override it).
- **SSH material lives globally, not in the repo.** `~/.config/<leaf>/keys/` holds the shared ed25519 key pair; the first `deploy`/`create`/`ssh`/`key` invocation generates the pair. `coding-container key --force` rotates it (all deployed projects then need a `deploy`). A project can opt into its own key with `ssh.keyDir` in its config. Pod host keys are ephemeral and never stored: aliases and sessions point `UserKnownHostsFile` at the OS null device, and legacy per-project `<project>-known_hosts` files are deleted on the next `ssh`/`deploy`/`delete`. Alias names carry the instance prefix (`CODING_SSH_PREFIX`, default `coding-`).
- **The build's Dockerfile lives globally too.** `setup` copies the repo's `Dockerfile` into `~/.config/coding-container/` (plus a `.dockerignore`), and the global config points there, so the build context is the global folder, never the repo, and the private keys stay out of it.
- **`src/utils/exec.js` is the only place that spawns docker/kubectl/ssh processes.** Commands and utilities stay thin on top of `exec`/`run`/`runWithInput`/`start`; the deliberate exception is `src/utils/registry.js`, which calls `spawnSync` directly for docker credential helpers (`queryCredentialHelper()`, injectable for tests).
- **`src/utils/manifest.js` owns all Kubernetes object shapes.** If you add a k8s resource (e.g. a PodDisruptionBudget), add a renderer there and include it in `fullManifest()`.
- **GUI-visible copy never mentions the CLI.** The web pages and desktop windows serve GUI users, not terminal users: describe actions and results in interface terms (pages, buttons, jobs), never commands or flags. See `AGENTS.md`.
- **Tests run with `npm test` (Node's built-in `node:test`, no extra dependencies).** Pure unit tests: `gc.test.js` (retention `planGc`/`imageTag`), `semver.test.js`, `system-config.test.js` (ConfigMap parsing + `resolveDeployTag`), `secrets.test.mjs` (`${VAR}` expansion + Secret/hash rendering), `registry.test.mjs` (local/credential-helper auth), `nodeport-owner.test.mjs`, `node-ip.test.js` (node/pod JSON parsing + Ready-node picking), `instance-env.test.mjs` (checkout `.env` + `CODING_*` validation), `volumes.test.mjs`, `web-nodeports.test.mjs`, `sidecar-nodeports.test.mjs` and `dockerfile-lazy.test.mjs` (validation + manifest rendering, and that `loadConfig` works without a Dockerfile while `buildImage` fails fast). Hermetic integration tests: `registry-api.test.mjs`, `cli-gc.test.mjs` and `cli-system.test.mjs` start an in-process mock Docker Registry and stub `kubectl` (a `.js` script via `KUBECTL_BIN`) and `docker` (a `.js` script via `DOCKER_BIN`), so no cluster, real registry, real docker build or network is needed. `test/personal.mjs` loads optional personal values from the gitignored `test/fixtures.local.mjs` (copy `test/fixtures.local.example.mjs`) so the same tests can assert against your real registry/NFS.
- **GUI tests live next to the code they cover.** Backend: `web/server/server.test.mjs` (auth, registry CRUD, validate/manifest drafts, jobs argv, cluster endpoints) and `web/server/ssh-terminal.test.mjs` (routing, frame codec, upgrade flow with a stubbed shell). Frontend: `web/client/src/**/*.test.mjs` (job helpers, page logic) plus `test/web-client-*.test.mjs` at the root (ops, pages, projects/deploy flows, images/system, system jobs). Same `npm test` glob runs them all.
- **`spec/` is pondering, not shipped.** `spec/docker-local-mode.md` records an agreed non-breaking shape for a possible Docker-local provider (bind-mount workspaces, same commands branching internally); nothing in it is implemented, and K8s behaviour is unchanged.
