# Architecture

How `coding-container` works: a Node.js CLI that turns one YAML config into a running, SSH-accessible coding pod on k3s, with the workspace persisted on NFS.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js >= 18, ES modules (`"type": "module"`) |
| CLI parsing | [commander.js](https://github.com/tj/commander.js) |
| Config parsing | [js-yaml](https://github.com/nodeca/js-yaml) (v4) |
| Container | Docker (ubuntu:24.04 base, sshd, Node 22, opencode, pi, Playwright) |
| Orchestration | k3s via `kubectl` (manifests rendered in-process, applied from stdin) |
| Storage | NFS volume per project (one subfolder per project) |

There are no other runtime dependencies. All interaction with Docker, kubectl, ssh and ssh-keygen happens by spawning the local binaries (`src/utils/exec.js`).

## High-level pipeline

```
config.yaml ──> loadConfig() ──> build ──> push ──> deploy ──> ssh
                  (merge +            (docker     (docker    (kubectl apply   (port-forward +
                   validate)           build)       push)     + rollout)       ssh -i key)
```

`loadConfig()` also derives `cfg.imageMode`: `"global"` when the *project* layer sets none of `image.dockerfile` / `image.buildArgs` / `image.name`, `"custom"` when it sets any (the project then builds + pushes its own image, `coding-<project>` unless `image.name` is set, and `image.tag` is required).

- **Global mode (the default)** — `create`/`deploy` skip build + push entirely and deploy the team-shared global image at the version the cluster currently points at (the float; `resolveDeployTag()`, `src/utils/system-config.js`). The shared image is versioned with human semver tags and published only by `system create` (`src/commands/system.js`); the pointer state lives in an in-cluster ConfigMap (`coding-system`), not on any laptop.
- **Custom mode** — `create` runs build → push → deploy in sequence (`src/commands/create.js`) against the project's own image.

Each step is also exposed as a standalone command; `build`/`push` refuse in global mode (they would tag/push the global repo), and `gc` refuses in global mode (the global repo is pruned by `system gc`).

**Project bootstrap** — when `create` runs in a folder with no `config.yaml` (and no explicit `-c`), `ensureProjectConfig()` (`src/utils/project.js`) scaffolds one first: the project name is derived from the folder name (lowercased, sanitized to a DNS-1123 label), and the NodePort is the first free one in 30000–32767, read from `kubectl get svc -A` (falls back to the default port if the cluster is unreachable). The rest of the run then proceeds as normal with the new config.

### 1. Configuration (`src/config.js`)

`loadConfig(configPath, overrides)` deep-merges four layers, lowest to highest priority:

1. Hardcoded `DEFAULTS` (generic; environment-specific values — registry, NFS server, NFS base path — are intentionally left unset and must come from the global config)
2. **Global config** — `~/.config/esuyo-coding-container/config.yaml` (honors `XDG_CONFIG_HOME`), if present. Holds the shared environment settings (registry, image build, k8s, NFS, SSH).
3. **Local project config** — `configPath`, resolved by `resolveDefaultConfigPath()`: explicit `-c` → `./config.yaml` in the current working directory → `config.yaml` next to the repo root. Project-specific values only.
4. CLI overrides (`-p/--project`, `--tag` — assembled in `cfgFrom()`, `src/index.js`)

Relative paths in either config layer (`dockerfile`, `context`, `keyDir`) are resolved against **that layer's own directory** (`withPaths()` in `src/config.js`), so the CLI can be invoked from anywhere and the global layer can point at a shared Dockerfile. When no layer sets `ssh.keyDir`, keys default to `keys/` inside the global config directory (one shared key pair for all projects, per-project known-hosts files alongside). `validate()` rejects invalid project names (must be a DNS-1123 label), a missing `image.registry`/`image.name`, a Dockerfile that does not exist on disk, a missing `nfs.server`/`nfs.basePath`, an `nfs.subPath` that is not a relative folder name (no leading `/`, no empty or `..` segments), unsupported service types, and malformed `web.ports` entries (each must be an object with an integer `port` in 1–65535 and a valid lowercase `host`; duplicate ports and duplicate hosts are rejected, an optional `name` must be a ≤15-char IANA service name, and an optional `nodePort` must be an integer in 30000–32767 that is not the SSH NodePort and unique across `web.ports` and sidecar nodePorts), `k8s.sidecars` entries (each must be an object with a valid ≤63-char container `name` — unique and not `coding` — and a non-empty `image`; `ports` entries need an integer `containerPort` in 1–65535 with an optional ≤15-char IANA `name` and `TCP`/`UDP` `protocol`; a sidecar port may not duplicate the SSH port, a `web.ports` port, or another sidecar's port; a sidecar port's optional `nodePort` must be an integer in 30000–32767, not the SSH NodePort, unique across `web.ports` and sidecars, and its resulting service port name (the port's `name`, else `nodeport-<containerPort>`) must not collide with `ssh`, a `web.ports` name, or another exposed sidecar port; and `k8s.replicas` must be 1 while sidecars are set, since replicas share the same NAS folder), and `nfs.volumes` entries (each must be an object with a relative unique `subPath` that is not the workspace folder, an absolute unique `mountPath` that is not `/workspace` (or under it), not the ssh keys path, and not nested with another entry's, plus an optional boolean `readOnly`). The environment-specific checks (registry, NFS) fail with a message pointing at `coding-container setup`, since the built-in `DEFAULTS` deliberately leave those unset.

First-run ergonomics: while the global config is missing, every command prints a one-line stderr tip pointing at `coding-container setup` (skipped for `setup` itself, `src/index.js` `cfgFrom()`). `setup` copies the `Dockerfile` from the repo into the global config folder (plus a `.dockerignore` keeping the keys out of the build context), writes the global config template pointing at that local `Dockerfile`, and creates the key pair — never overwriting existing files. This keeps the global config self-contained (no repo path) and gives the build a clean context.

**Capturing environment-specific values.** `setup` fills the three environment-specific values (registry, NFS server, NFS base path) in this order: an explicit flag (`--registry`, `--nfs-server`, `--nfs-base-path`) → an interactive prompt (built-in `node:readline/promises`, only when stdin/stdout are a real TTY) → a clearly-marked placeholder. The non-TTY fallback means `setup` never blocks when scripted or piped; the generated values are emitted as YAML double-quoted scalars so special characters are safe.

### 2. Build & push (`src/commands/build.js`, `src/commands/push.js`)

- `build` runs `docker build -t <registry>/<name>:<tag> -f <dockerfile> [--build-arg K=V ...] <context>` (raw `buildImage()`; the guarded `build` command requires custom mode + a tag)
- Every entry in `image.buildArgs` becomes a `--build-arg`. The Dockerfile consumes: `BASE_IMAGE`, `NODE_VERSION`, `EXTRA_APT_PACKAGES`, `EXTRA_NPM_PACKAGES`, `INSTALL_PLAYWRIGHT`.
- `push` runs `docker push <ref>` (raw `pushImage()`; the guarded `push` command requires custom mode + a tag) and wraps failures with a `docker login` hint.
- **Tag semantics** — there is no `latest` fallback: `imageRef()` throws when no tag is set. In custom mode the tag comes from `image.tag` or `--tag` (required). In global mode, `deploy`/`create` resolve the tag via `resolveDeployTag()`: the project pin (`image.tag`/`--tag`, must be semver) when set, else the ConfigMap's `current` (the float). `system create --tag` is the one place a global-mode tag is chosen for a build.
- Docker itself is spawned through `dockerExec()` (`src/utils/exec.js`): the `DOCKER_BIN` env var points at a specific binary/wrapper (tests use a stub); on Windows a script stub is spawned with a shell.

### 2b. Registry tag garbage collection (`src/commands/gc.js`, `src/utils/registry-api.js`)

Both image modes accumulate tags (global: one per published version; custom: one per build), and two commands prune them: bare `gc` (the project's custom repo, custom mode only) and `system gc` (the global repo, global mode only). Both call the shared `gcTags()`, which lists the repo's tags, determines what is in use, plans with `planGc()` and (unless `--dry-run`) deletes via the registry API.

`planGc({ tags, inUse, pinned, previous, keep })` computes the retention set: a tag is kept if it is **in use** (its tag appears in the image of any `coding-container=true` deployment in the namespace, discovered via `kubectl get deploy -l coding-container=true` — `inUseTags()`; the `KUBECTL_BIN` env var can point this at a specific kubectl binary/wrapper (used by the tests to stub the cluster); if that query fails, gc refuses to delete anything), or **the pin** (the project's tag for `gc`; the ConfigMap's `current` for `system gc`), or **`previous`** (the ConfigMap's last version; only passed by `system gc`), or one of the **newest `keep` semver versions behind the pin** (`--keep` for `gc`, default 5; the ConfigMap's `keep` for `system gc`). Everything else is deleted oldest-first (semver ascending, then non-semver tags lexicographically). Non-semver tags (e.g. `latest` or legacy timestamp tags) are never counted in the keep window — they are deletable unless in use (or literally the pin), and dry runs report them separately. `--dry-run` prints the plan without deleting.

**Semver** (`src/utils/semver.js`) — the global image's versions are strict `vMAJOR.MINOR.PATCH` strings: `isSemver()` validates, `compareSemver()` compares numerically (so `v1.10.0 > v1.9.9`), `semverSortAsc()`/`allTagsSortAsc()` sort. No pre-release or build metadata: versions are human-picked and immutable.

`src/utils/registry-api.js` is a small Docker Registry HTTP API V2 client: `listTags()` calls `GET /v2/<repo>/tags/list` (following the `Link: rel="next"` pagination header) and `deleteTag()` calls `DELETE /v2/<repo>/tags/<tag>`, where `<repo>` is the registry reference minus the host plus the image name (`registryRepoName()`). It performs the standard `WWW-Authenticate` dance — on a `401` it follows the `Bearer`/`Basic` challenge, exchanging the local docker credentials (reusing `localRegistryAuth()` / `credentialHelperAuth()` from `src/utils/registry.js`) for a bearer token (cached per realm/service/scope). Requests go through core `node:http`/`node:https` with `keepAlive` disabled (not the global `fetch`) so the sockets never outlive the command and the CLI exits promptly. Deleting a tag reclaims disk only once the registry runs its own GC (automatic on GitLab/Harbor); AWS ECR does not expose tag deletion via the V2 API, so `gc` reports a `405` hint rather than pruning ECR.

### 2c. The shared global image (`src/utils/system-config.js`, `src/commands/system.js`)

The team's shared image state lives **in the cluster**, not on laptops: one ConfigMap, `coding-system` (label `coding-container=true`), in the `coding` namespace. Its `data` block (all strings — ConfigMaps carry strings) holds the version pointer and policy:

| Key | Meaning |
|---|---|
| `current` | what global-mode deploys float on (semver) |
| `previous` | the version `current` had before its last change — the default rollback target (may be absent) |
| `maxEver` | highest version ever published; never moves backward, so a rolled-back (poisoned) version can never be republished |
| `keep` | gc window: how many versions behind `current` to keep (integer string) |

`src/utils/system-config.js` is the only place that reads or writes it: `getSystemConfig(ns)` reads + validates via `parseSystemData()` (throws `INIT_HINT` — the bootstrap message `coding-container system init --tag v1.0.0 --keep 10` — when the ConfigMap is missing, and a clear error on any invalid/corrupt value, e.g. `current` newer than `maxEver`), and `patchSystemConfig(ns, state)` writes the complete state via `kubectl apply -f -` (read-then-write is safe: the ConfigMap is tiny and the writers are human-driven). `systemConfigManifest()` renders the object; `resolveDeployTag(cfg)` implements the float (custom: the project pin, required; global: the pin/`--tag` when set, else `current`).

All kubectl calls go through `kubectlExec()` (same file): the `KUBECTL_BIN` env var points at a specific binary/wrapper. A node script stub (`.js`/`.cjs`/`.mjs`) is run **directly** (`node <stub>`), because piping stdin through `cmd.exe` is racy on Windows and the `apply -f -` manifest would be lost; a Windows script stub (`.cmd`/`.bat`) is spawned with a shell. Tests stub the cluster this way — no real cluster, registry, docker build or network is needed.

The `system` command group (`src/commands/system.js`; every command first calls `requireGlobalMode()`, so a custom-mode project gets a clear error instead of acting on the shared image) is the only interface to this state:

- **`system init --tag <semver> [--keep <n>]`** — creates the ConfigMap on a fresh cluster (fails if it already exists: there is exactly one per cluster). No image is built; the recorded version becomes the float target and `maxEver`.
- **`system get`** — prints current/previous/maxEver/keep and the resolved global image reference.
- **`system list`** — lists the global repo's registry tags, semver-sorted newest-first, marking `current`/`previous`/`maxEver`; non-semver tags are listed separately (read-only).
- **`system create --tag <semver>`** — the only writer of the global image. Validates the tag (semver, `> maxEver`, not already in the registry), builds + pushes via `buildImage()`/`pushImage()`, then repoints: `previous = current`, `current = tag`, `maxEver = tag`.
- **`system rollback [tag]`** — repoints `current` to an existing version (default: `previous`; the target must exist in the registry). Pure pointer change — no build, push or delete; `maxEver` never moves.
- **`system gc [--keep <n>] [--dry-run]`** — prunes the global repo with `gcTags()`: keeps `current` + `previous` + every in-use tag + the `keep`-many semver predecessors of `current`.

Because the pointer lives in the cluster, publishing or rolling back requires no config edits anywhere: every project picks the new `current` up on its next `deploy`/`create`.

### 3. Deploy (`src/commands/deploy.js`)

`deploy()` first resolves the image tag — `resolveDeployTag()`: custom mode uses the project pin (required), global mode uses the pin/`--tag` when set, else the `coding-system` ConfigMap's `current` (the float; a fresh cluster gets the `system init` hint). It then performs seven steps:

1. **SSH key** — `ensureKeyPair()` (`src/utils/keys.js`) generates an ed25519 key pair with `ssh-keygen` if one does not yet exist in the key dir (default: `keys/` next to the global config; override with `ssh.keyDir`) (no passphrase, 0600 on the private key). The public key is read back for the manifest.
2. **Namespace** — created if missing (`kubectl create namespace`).
3. **NodePort preflight** — with `serviceType: NodePort`, the SSH `nodePort`, every `web.ports` `nodePort`, and every sidecar `nodePort` are checked against `kubectl get svc -A` (`findNodePortOwner()`, `src/utils/project.js`). A port held by another service fails the deploy before anything is applied, because a conflicting apply leaves a partial state (deployment and ingress created, service invalid). The project's own service (redeploy with an unchanged port) is not a conflict.
4. **Pull secret** — `ensurePullSecret()` (`src/utils/registry.js`) resolves, in priority order: (a) `k8s.imagePullSecret` from the config if set, (b) a previously created managed secret named `coding-<registry-host-with-dashes>`, (c) a new managed secret built from local docker credentials (inline `~/.docker/config.json` auths, or the OS credential helper such as `docker-credential-desktop`), (d) an existing `kubernetes.io/dockerconfigjson` secret in the namespace whose dockerconfigjson matches the registry host. If none apply, deployment proceeds with a warning (the registry may be public or the cluster may have global access).
5. **Manifest apply** — `fullManifest()` (`src/utils/manifest.js`) renders up to five documents as YAML and pipes them to `kubectl apply -f -`:
    - **ConfigMap** `<project>-ssh` — holds `authorized_keys` (the local public key).
    - **Secret** `<project>-env` — rendered only when `k8s.secretEnv` is non-empty; holds the secret values via `stringData`, so the Deployment never carries them as plaintext. A short content hash is stamped onto the pod template (`coding-container-secrets-hash` annotation) so rotated values roll the pods on the next deploy.
    - **Deployment** `<project>` — the container with its volumes and resources; references the pull secret via `imagePullSecrets` when one exists. Declares one containerPort per `web.ports` entry alongside `ssh`. `k8s.sidecars` entries are rendered as extra containers after the coding one — near-raw pass-through of the k8s container spec, with `env` maps converted to a k8s env list (`sidecarContainers()`, `src/utils/manifest.js`).
    - **Service** `<project>` — `NodePort` (default, port `22` → `ssh.nodePort`) or `LoadBalancer`, plus a cluster port per `web.ports` entry (carrying a `nodePort` when the entry sets one), and a NodePort port per sidecar port carrying a `nodePort`.
   - **Ingress** `<project>` — rendered only when `web.ports` is non-empty. One rule per entry: the entry's `host` routes to that container port on the service, using `ingress.className` (default `traefik`). This is how browsers reach dev servers; entries with a `nodePort` are additionally reachable on every cluster node at `http://<node-ip>:<nodePort>/`.
6. **Rollout** — waits on `kubectl rollout status deployment/<project> --timeout=300s` (skippable with `deploy --no-wait`).
7. **SSH alias** — `addHostEntry()` (`src/utils/ssh-config.js`) writes/updates a `Host coding-<project>` block in the user's `~/.ssh/config`, in a marker-delimited managed section (everything outside the markers is never touched; a failure here only warns). The block points at the node's InternalIP + the project's NodePort, so `ssh coding-<project>` and VS Code Remote-SSH work without a port-forward. `delete` removes the block (`removeHostEntry()`).

### 4. The pod

The pod spec (rendered by `deploymentManifest()`, `src/utils/manifest.js:23`) declares two volumes:

- **`workspace`** — raw NFS volume: `nfs.server` at path `<nfs.basePath>` (which must exist on the NAS), mounted at `container.workdir` (`/workspace`) with `subPath: <nfs.subPath or project>` (`workspaceSubPath()`, `src/utils/manifest.js`). NFS servers reject mounts of paths that do not exist, so the pod mounts the base export and isolates projects via `subPath`; the kubelet creates the per-project folder on the share at first mount. This is what makes workspaces survive pod restarts and per-project isolated. `nfs.subPath` pins a specific folder (e.g. to reuse data across project renames); the pod/service/alias names always stay the project name.
- **Extra NFS volumes** — `nfs.volumes` entries add further `volumeMounts` on the **same** `workspace` NFS volume (`extraVolumeMounts()`, `src/utils/manifest.js`): each mounts a subfolder of `nfs.basePath` (`subPath`) at its own absolute `mountPath` in the coding container, with an optional `readOnly: true`. No extra pod `volumes` are created (a new NFS `Volume` per entry would fail on folders that do not exist yet); the kubelet creates each subfolder at first mount, exactly like the project folder.
- **`ssh-keys`** — the `<project>-ssh` ConfigMap, mounted with `subPath: authorized_keys` at `/root/.ssh/authorized_keys`. The image ships an empty placeholder file; the mount shadows it with the project-specific key.

**Sidecars** — `k8s.sidecars` entries run as additional containers in the same pod. They share the pod's network namespace (the coding container reaches them on `localhost`, no hostnames) and its volumes (they can persist state on the `workspace` NFS volume under their own `subPath`, e.g. `subPath: postgres` for a database's data dir). The service exposes `ssh`, the `web.ports` ports, and any sidecar port that carries a `nodePort` — each of those renders an extra NodePort service port shaped like the ssh one (`sidecarNodePorts()`, `src/utils/manifest.js`; the `nodePort` field is a service-level knob and is stripped from the rendered ContainerPort). A sidecar port becomes externally reachable either by listing it in `web.ports` (HTTP, via Traefik) or by giving it a `nodePort` (raw TCP on every cluster node — databases and queues that an HTTP Ingress can't route); the entry's numeric `targetPort` resolves to the sidecar's `containerPort`, which validation guarantees is unique in the pod.

Because the key lives in a ConfigMap and not in the image, regenerating a key only requires `key --force` followed by `deploy` — no image rebuild. The same applies to `k8s.secretEnv`: values live in the `<project>-env` Secret (created/pruned declaratively on each deploy, removed by `delete`), and `${VAR}` references in `k8s.env`/`k8s.secretEnv` are expanded from the local shell at load time (missing variables fail fast), so real secrets never need to sit in a yaml file.

Inside the container, `Dockerfile` configures sshd for key-only root login, appends `cd /workspace` to `/root/.bashrc` and `/root/.profile` (so every interactive session starts in the workspace), and runs an entrypoint (`/entrypoint.sh`) that recreates `/run/sshd` (tmpfs-safe) before `exec /usr/sbin/sshd -D`. opencode installs into `/root/.opencode/bin`; that directory is added to `PATH` via `ENV` and `/etc/profile.d/opencode.sh` so it is available in interactive, login and non-interactive shells alike.

### 5. SSH access (`src/commands/ssh.js`)

Two modes:

- **Default (port-forward)** — spawns `kubectl -n <ns> port-forward svc/<project> <localPort>:<port>`, waits up to 15 s for the "Forwarding from" line, then runs `ssh -i <private key> -p <localPort> <user>@127.0.0.1`. The port-forward child is killed in a `finally` block when the session ends. If the configured `localPort` is already in use, the CLI falls back to a free port automatically.
- **Host keys** — pod sshd host keys are regenerated on every image build, so the CLI connects with `StrictHostKeyChecking=no` against a per-project known-hosts file (`~/.config/esuyo-coding-container/keys/<project>-known_hosts` by default, or `<keyDir>/<project>-known_hosts` if `ssh.keyDir` is set). Ephemeral keys never pollute the user's global `~/.ssh/known_hosts` and a rebuilt image never blocks the next connection. This is acceptable for development pods on a trusted network; the private key remains the only credential.
- **`--direct`** — resolves the first node's `InternalIP` via a `kubectl get nodes` jsonpath query and connects to `<nodeIP>:<nodePort>` directly. Use this from machines where `kubectl` works but long-lived port-forwards are undesirable (note: the node must be routable from the client).

## Failure behaviour & exit codes

- Any step failure throws; `program.parseAsync(...).catch()` in `src/index.js:144` prints `Error: <message>` and exits with code 1.
- `ssh` sets exit code 255 (the conventional SSH failure code) when the session itself fails.
- Commands are idempotent where it matters: `ensureNamespace`, `ensurePullSecret`, `ensureKeyPair`, and `kubectl apply` all no-op when the desired state already exists.

## Security notes

- The private key never leaves the developer machine; only the public key reaches the cluster (ConfigMap, namespace-scoped).
- `k8s.env` values are plaintext in the Deployment spec (visible to anyone who can `kubectl get deploy`). Put anything secret in `k8s.secretEnv` instead: values travel in the `<project>-env` Secret and the Deployment only carries a `secretKeyRef`. (A k8s Secret is base64, not encrypted, unless etcd encryption at rest is enabled — but it separates RBAC and stays out of deploy output. `validate --manifest` redacts secret values for the same reason.)
- Password authentication is disabled in the container; only key auth works.
- The key pair lives in `~/.config/esuyo-coding-container/keys/` (outside the repo) and is shared by all projects by design; `ssh.keyDir` in a project config opts a project into its own key. The global config is machine-local; the project `config.yaml` is the only config that belongs in version control.
