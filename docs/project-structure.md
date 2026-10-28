# Project Structure

Directory layout of `esuyo-coding-container` and the role of each file.

```
esuyo-coding-container/
├── package.json            # ESM package, bin entry "coding-container" pointing at src/index.js
├── package-lock.json
├── config.yaml             # Project specific config, project name and nodePort, layers over the global config
├── Dockerfile              # Packaged starting point. Setup copies it to ~/.config/<leaf>/. The build uses that personal copy
├── opencode/               # Image defaults copied into the build context on setup: opencode.json, cli.json, custom provider, agent/*.md team agents
├── .env                    # gitignored checkout identity with CODING_* plus app server settings. Copy .env.example
├── .env.example            # template for .env with instance plus sign in plus PORT
├── LICENSE                 # MIT
├── AGENTS.md               # agent guidelines with app copy rules and Windows command discipline
├── .gitignore              # Ignores .opencode, node_modules, keys, pem files, .env, test fixtures, electron dist
├── .github/workflows/publish.yml  # On push to main or master: npm test, semver bump from commit message, tag, npm publish, GitHub release, plus desktop installers per OS in the same run
├── .github/workflows/desktop.yml  # Manual and tag builds: v* and desktop-v* tags, release published, manual dispatch with tag input. Builds web GUI plus Electron installers per OS, upload artifacts
├── docs/                   # User and contributor guides, plus build design history kept as history
├── spec/                   # Pre implementation discussion notes, pondering not shipped
├── test/                   # node:test suite run with `npm test`, hermetic with no cluster, registry or network needed
├── src/
│   ├── index.js            # background engine entry, command wiring, shared flags for config path, project ref, name and tag
│   ├── config.js           # config file resolution, layered merge of defaults plus global plus project plus run time, path resolution, validation
│   ├── commands/
│   │   ├── setup.js        # one time shared setup: copies Dockerfile plus opencode defaults plus dockerignore, captures registry and NFS, tags namespace, config template, key pair
│   │   ├── build.js        # raw docker build plus guarded build, custom mode plus tag, global mode uses shared publish
│   │   ├── push.js         # raw docker push with login hint plus guarded push with same guards
│   │   ├── deploy.js       # tag float plus SSH key plus namespace plus NodePort preflight plus pull secret plus manifest apply plus rollout wait plus SSH alias in ~/.ssh/config
│   │   ├── create.js       # deploy pipeline: global mode floats on the shared image, custom mode builds plus pushes the project image first
│   │   ├── ssh.js          # port forward with auto port fallback or direct node, null device known hosts for fresh pod keys
│   │   ├── list.js         # read the managed ~/.ssh/config aliases, repoint aliases at a Ready node plus live service nodePort
│   │   ├── delete.js       # remove deployment, service, ingress plus <project>-ssh ConfigMap plus <project>-env Secret, removes SSH alias
│   │   ├── validate.js     # load plus validate the config, print a summary or the rendered manifests
│   │   ├── gc.js           # imageTag, planGc retention plan, shared pruner, project custom repo cleanup in custom mode only
│   │   ├── projects.js     # projects list view of the shared registry
│   │   └── system.js       # shared image group: init, get, list, create, rollback and gc of the ConfigMap coding-system
│   └── utils/
│       ├── exec.js         # spawn helpers: exec with capture, run with streaming, runWithInput, start plus dockerExec with DOCKER_BIN override
│       ├── envsubst.js     # ${VAR} expansion from local shell into k8s.env and secretEnv, missing values fail fast
│       ├── instance.js     # checkout identity: one shot .env loader plus CODING_CONFIG_LEAF, SSH_PREFIX and NAMESPACE
│       ├── keys.js         # ed25519 key pair creation with ssh-keygen, public key reader
│       ├── manifest.js     # ConfigMap, Deployment, Service and Ingress plus <project>-env Secret renderers plus web.ports normalization plus sidecars pass through with env map conversion and nodePort stripping plus nfs.volumes mounts plus multi doc YAML
│       ├── namespaces.js   # coding areas: labeled namespaces, setup annotations, stored values plus live workload fallback
│       ├── node-ip.js      # SSH target IP: pod hostIP when its node is Ready, else first Ready node, json output, Windows safe
│       ├── project.js      # project bootstrap: name from folder, free NodePort, minimal config.yaml, NodePort ownership lookup for deploy preflight
│       ├── projects.js     # shared registry: paths, slugs, ref matching, managed config helpers
│       ├── registry.js     # pull secret resolution with config option, docker creds and existing secrets
│       ├── registry-api.js # Docker Registry V2 client for cleanup: list and delete tags, Bearer and Basic auth, Link paging
│       ├── semver.js       # strict vX.Y.Z validation, numeric compare, semver and all tag sorting, patch auto bump
│       ├── system-config.js# the coding-system ConfigMap: read with getSystemConfig, write with patchSystemConfig, validation, resolveDeployTag float, kubectlExec with KUBECTL_BIN override
│       └── ssh-config.js   # managed block in ~/.ssh/config: add, remove and list Host aliases, null device known hosts, legacy known hosts cleanup
├── web/
│   ├── dev.js              # GUI dev launcher: backend API plus Vite frontend together with `node web/dev.js`
│   ├── kill-dev.js         # stops orphaned dev servers still holding the dev ports
│   ├── projects.json       # legacy dev registry, migrated once into the shared store, do not rely on it
│   ├── server/
│   │   ├── server.js       # app backend: env, auth and registry, reads, job runner with persisted jobs, cluster summary cache, static pages, see architecture section 7
│   │   ├── ssh-terminal.js # browser terminal WebSocket transport with kubectl port forward plus ssh2 pty bridge
│   │   ├── server.test.mjs # backend tests for auth, registry, validate and manifest drafts, jobs, cluster endpoints
│   │   └── ssh-terminal.test.mjs  # terminal transport tests for routing, frame codec and upgrade flow
│   └── client/             # React 18 plus TS plus Vite plus Tailwind pages served from web/client/dist by the backend
│       ├── package.json    # separate install and lockfile. Install with web client install. Scripts are dev, build and preview
│       ├── vite.config.ts  # dev on :3400 plus /api proxy including websockets at VITE_API_TARGET default 127.0.0.1:3401
│       └── src/
│           ├── App.tsx     # routes for login, register, dashboard, projects with new, import and edit, images, system, ssh keys, setup, jobs, profile and theme
│           ├── auth/       # AuthContext plus RequireAuth and LoginPage with session cookie flow
│           ├── lib/        # api.ts with same origin fetch client, projects.tsx, systemJobs.ts, usageThresholds.ts
│           ├── components/ # layout with Sidebar, Header, WindowControls, Layout, ProfileBlock and ThemeToggle and DesktopUpdateNotice, UI kit, JobOutput, ValidatePanel, YamlEditor, ProjectDeployTab, RefreshControl, FontControls
│           ├── pages/      # Dashboard, Projects with new, import and edit, Images, System, SSH keys, Setup, Jobs, Profile, Theme, SSH terminal, placeholders, job-helpers.ts
│           └── theme/      # useTheme with dark and light, fonts with per browser font plus size settings
└── electron/               # installable desktop shell around the same web pages and background work
    ├── package.json        # private package, version synced to release by CI, dev, pack and dist scripts
    ├── electron-builder.yml# packaging with no asar so backend keeps real files for background runs and Dockerfile and config lookup, bundles main, preload, launcher plus src plus web server plus client dist plus config, Dockerfile, opencode and prod node_modules
    ├── main.js             # main process: encrypted sign in, loopback server, frameless window, tool checks, health check, auto update
    ├── preload.js          # sandboxed bridge for auth sync with sign in, password change and sign out plus desktop header and window controls
    ├── server-launcher.mjs # helper process launcher for the bundled app server
    └── README.md           # desktop run and build notes with dev, installers and signing placeholders
```

## Notes

* **Config is layered.** The project `config.yaml` that a repo commits overrides the global config at `~/.config/<leaf>/config.yaml`, leaf default `coding-container` and per checkout with `CODING_CONFIG_LEAF` in `.env`, which overrides built in defaults. Choices you make at run time in the app, such as the picked project and tag, win over all of it. Every relative path in a layer such as `dockerfile`, `context` and `keyDir` resolves against that layer own folder, so the app works from any working folder. `CODING_NAMESPACE` sets the default namespace underneath all of it, config files still override it.
* **SSH material lives outside the repo, not in it.** `~/.config/<leaf>/keys/` holds the shared ed25519 key pair. The first Deploy, Terminal, or key view creates the pair. The Rotate key button on the SSH and Keys page rotates it, then all deployed projects need a Deploy. A project can use its own key with `ssh.keyDir` in its config. Pod host keys are short lived and never stored. Aliases and sessions point `UserKnownHostsFile` at the OS null device, and legacy per project `<project>-known_hosts` files are deleted on the next terminal or deploy or remove run. Alias names carry the checkout prefix with `CODING_SSH_PREFIX` default `coding-`.
* **The build Dockerfile lives outside the repo too.** Setup copies the repo `Dockerfile` into `~/.config/coding-container/` plus a `.dockerignore`, and the global config points there, so the build context is the global folder, never the repo, and the private keys stay out of it. Setup also copies `opencode/` defaults for the image build, per file, never overwriting your edits.
* **`src/utils/exec.js` is the only place that starts docker, kubectl and ssh processes.** Tasks and utils stay thin on top of `exec`, `run`, `runWithInput` and `start`. The deliberate exception is `src/utils/registry.js`, which calls `spawnSync` directly for docker credential helpers in `queryCredentialHelper()`, injectable for tests.
* **`src/utils/manifest.js` owns all Kubernetes object shapes.** To add a Kubernetes resource such as a PodDisruptionBudget, add a renderer there and include it in `fullManifest()`.
* **App visible copy never mentions the shell path.** The web pages and desktop windows serve app users, not shell users. Describe actions and results in interface terms such as pages, buttons and jobs. See `AGENTS.md`.
* **Tests run with `npm test` using Node built in `node:test` with no extra dependencies.** Pure unit tests: `gc.test.js` for retention `planGc` and `imageTag`, `semver.test.js`, `system-config.test.js` for ConfigMap parsing plus `resolveDeployTag`, `secrets.test.mjs` for `${VAR}` expansion plus Secret and hash rendering, `registry.test.mjs` for local and credential helper auth, `nodeport-owner.test.mjs`, `node-ip.test.js` for node and pod JSON parsing plus Ready node picking, `instance-env.test.mjs` for checkout `.env` plus `CODING_*` validation, `volumes.test.mjs`, `web-nodeports.test.mjs`, `sidecar-nodeports.test.mjs` and `dockerfile-lazy.test.mjs` for validation plus manifest rendering, and that `loadConfig` works with no Dockerfile while `buildImage` fails fast. Hermetic integration tests: `registry-api.test.mjs`, `cli-gc.test.mjs` and `cli-system.test.mjs` start an in process mock Docker Registry and stub `kubectl` with a `.js` script through `KUBECTL_BIN` and `docker` with a `.js` script through `DOCKER_BIN`, so no cluster, real registry, real docker build or network is needed. `test/personal.mjs` loads optional personal values from the gitignored `test/fixtures.local.mjs`, copy `test/fixtures.local.example.mjs`, so the same tests can assert against your real registry and NFS.
* **GUI tests live next to the code they cover.** Backend: `web/server/server.test.mjs` for auth, registry create read update delete, validate and manifest drafts, jobs args, cluster endpoints, and `web/server/ssh-terminal.test.mjs` for routing, frame codec and upgrade flow with a stubbed shell. Frontend: `web/client/src/**/*.test.mjs` for job helpers and page logic, plus root level `test/web-client-*.test.mjs` for ops, pages, projects and deploy flows, images and system, and system jobs. The same `npm test` glob runs them all.
* **`spec/` is pondering, not shipped.** `spec/docker-local-mode.md` records an agreed non breaking shape for a possible Docker local provider with bind mount workspaces and the same pages branching internally. Nothing in it is implemented, and Kubernetes behavior is unchanged.
