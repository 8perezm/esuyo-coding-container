# Architecture

How the app turns one YAML config into a running coding pod on Kubernetes with the workspace kept on NFS, and how the pieces fit together.

If you just want to use the system, read the Web GUI and Desktop guides and skip the internals. This page is for contributors who build and extend the app.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18 or newer, ES modules. CI uses Node 22 |
| Config parsing | js-yaml v4 |
| Container | Ubuntu 26.04 base, sshd, Node 26, opencode V2, pi, herdr, turbo, Playwright with Chrome, postgres client |
| Orchestration | Kubernetes with `kubectl`, manifests rendered in code and applied from stdin |
| Storage | NFS volume per project, one subfolder per project |
| App backend | Node single file HTTP server, `web/server/server.js`, plus `web/server/ssh-terminal.js`, only Node builtins plus `js-yaml` and `ssh2` |
| App frontend | React 18 plus TypeScript plus Vite plus Tailwind in `web/client`, served as static files by the backend |
| Desktop shell | Electron in `electron`, launches the same app server on a loopback port and shows it in a window |

All contact with Docker, kubectl, ssh and ssh keygen happens by starting the local tools from `src/utils/exec.js`. The app backend runs background work as tracked jobs. The frontend talks to the backend over same origin `/api` calls.

## High level flow

```
config.yaml -> load and check -> build -> push -> deploy -> connect
                 merge and        docker     docker    apply plus     port forward
                 validate         build      push      rollout        plus ssh, or browser terminal
```

`loadConfig()` also decides the image mode. It is `global` when the project layer sets none of `image.dockerfile`, `image.buildArgs` or `image.name`, and `custom` when it sets any of them. A custom project builds and pushes its own image, `coding-<project>` unless `image.name` is set, and `image.tag` is required there.

* **Global mode, the default:** deploy skips build and push and runs the team shared image at the version the cluster currently points at, called the float and resolved in `src/utils/system-config.js`. The shared image is versioned with human tags and published only from the Images page. The pointer lives in an in cluster ConfigMap named `coding-system`, not on any laptop.
* **Custom mode:** deploy runs build, then push, then deploy in sequence against the project own image.

Each step is also available as a separate job from the app. Build and push refuse in global mode with a clear message. Cleanup of the project repo refuses in global mode because the shared repo has its own cleanup on the Images page.

**Project bootstrap.** When a project is added with no `config.yaml`, the app creates one first. The project name comes from the display name you type, cleaned to a DNS label, and the NodePort is the first free one in 30000 to 32767 read from `kubectl get svc -A`, with a fallback default when the cluster is unreachable. The rest of the run proceeds with the new config.

### 1. Configuration in `src/config.js`

`loadConfig()` deep merges four layers, lowest to highest:

1. Hardcoded `DEFAULTS`. Generic values. Environment specific ones such as registry, NFS server and NFS base path stay empty and must come from the global config.
2. **Global config:** `~/.config/coding-container/config.yaml` when present, honors `XDG_CONFIG_HOME`. Holds the shared environment settings such as registry, image build, Kubernetes, NFS and SSH.
3. **Local project config:** resolved by `resolveDefaultConfigPath()`. An explicit path wins, then `./config.yaml` in the current working directory, then `config.yaml` next to the repo root. Holds project specific values only.
4. Run time choices from the app, such as the selected project and tag.

Relative paths in either config layer such as `dockerfile`, `context` and `keyDir` resolve against that layer own folder in `withPaths()` in `src/config.js`, so runs work from any folder and the global layer can point at a shared Dockerfile. When no layer sets `ssh.keyDir`, keys default to `keys` inside the global config folder, one shared pair for all projects. Pod host keys are short lived and never stored.

**Checkout identity.** The global config folder leaf, SSH alias prefix, and default namespace are per checkout, driven by the checkout root `.env` file plus real environment values in `src/utils/instance.js`: `CODING_CONFIG_LEAF` default `coding-container`, `CODING_SSH_PREFIX` default `coding-`, and `CODING_NAMESPACE` default `coding`. The loader reads `<checkout>/.env` once per process. Real environment wins and is never overwritten. The app server reads the root `.env` for its own settings such as sign in, port and registry override, plus a legacy `web/.env` read only fallback. Copy `.env.example` to `.env` to suit a checkout, for example `coding-container-dev`, `coding-dev-` and `coding-dev` for an isolated dev instance. `validate()` rejects bad project names, missing registry or name, missing NFS server or base path, bad `nfs.subPath`, unsupported service types, and malformed `web.ports` entries with duplicate ports or hosts, bad names, or bad NodePorts. It also checks `k8s.sidecars` entries for valid names and images, good ports, no duplicates with SSH or web ports, and unique names.

First run help: while the global config is missing, the Setup entry appears in the sidebar and the Setup page explains how to create it. Setup copies the `Dockerfile` from the repo into the global config folder plus a `.dockerignore` keeping keys out of the build context, copies the `opencode/` defaults for the image build, writes the global config template pointing at that local `Dockerfile`, and creates the key pair, never overwriting existing files. This keeps the global config self contained with no repo path and gives the build a clean context.

**Coding areas.** `src/utils/namespaces.js` lists namespaces labeled `coding-container=true` and reads setup values from annotations `coding-container.io/registry`, `coding-container.io/nfs-server` and `coding-container.io/nfs-base-path`. The Setup page offers Use existing versus Create new, prefills from stored annotations, falls back to live workload values from deployments, and marks areas with a `coding-system` ConfigMap as ready. Setup and init tag the namespace label and annotations on a best effort basis, so offline use still works.

**Values that differ per machine.** Setup fills the three environment values, registry, NFS server and NFS base path, in this order: explicit values you type in the Setup form, an interactive prompt only when a real TTY is present, then a clearly marked placeholder. The non TTY fallback means setup never blocks when scripted. Generated values are emitted as YAML double quoted scalars so special characters stay safe.

### 2. Build and push in `src/commands/build.js` and `src/commands/push.js`

* Build runs `docker build -t <registry>/<name>:<tag> -f <dockerfile>` with each `image.buildArgs` entry as a build arg. The Dockerfile consumes `BASE_IMAGE`, `NODE_VERSION`, `EXTRA_APT_PACKAGES`, `EXTRA_NPM_PACKAGES` and `INSTALL_PLAYWRIGHT`.
* Push runs `docker push <ref>` and wraps failures with a `docker login` hint.
* Tag rules: there is no `latest` fallback. `imageRef()` throws when no tag is set. In custom mode the tag comes from `image.tag` or job options and is required. In global mode deploy resolves the tag from the project pin when set, else the ConfigMap `current`. Publish from the Images page is the one place a global mode tag is chosen for a build.
* Docker runs through `dockerExec()` in `src/utils/exec.js`. The `DOCKER_BIN` env value points at a specific binary or wrapper. Tests use a stub. On Windows an overridden `DOCKER_BIN` runs with a shell.

### 2b. Tag cleanup in `src/commands/gc.js` and `src/utils/registry-api.js`

Both image modes accumulate tags, global with one per published version and custom with one per build, and two cleanups prune them: project cleanup for the project custom repo, custom mode only, and shared cleanup for the shared repo. Both call the shared `gcTags()`, which lists the repo tags, finds what is in use, plans with `planGc()` and deletes unless preview is on.

`planGc()` keeps a tag when it is in use, meaning its tag appears in the image of any `coding-container=true` deployment in the namespace found with `kubectl get deploy -l coding-container=true` in `inUseTags()`, or the pin, meaning the project tag for project cleanup and the ConfigMap `current` for shared cleanup, or `previous`, meaning the ConfigMap last version and only passed by shared cleanup, or one of the newest `keep` semver versions behind the pin. Everything else is deleted oldest first, semver ascending then other tags alphabetically. Tags that are not semver such as `latest` never count in the keep window. They are deletable unless in use or exactly the pin, and every run reports them separately. Preview prints the plan without deleting.

**Versions** in `src/utils/semver.js`: the shared image versions are strict `vMAJOR.MINOR.PATCH` strings. Helpers validate, compare numerically so `v1.10.0` beats `v1.9.9`, sort ascending, and bump patch. No prerelease or build metadata. Versions are human picked and immutable.

`src/utils/registry-api.js` is a small Docker Registry HTTP API V2 client. `listTags()` calls `GET /v2/<repo>/tags/list` and follows paging. `deleteTag()` resolves the digest with `GET /v2/<repo>/manifests/<tag>` then calls `DELETE` on the digest, with fallback to tag delete on registries like Gitea that accept a tag directly. It performs the standard auth dance. On `401` it follows the challenge. Basic uses local docker credentials directly. Bearer exchanges them for a token, cached per realm and scope, probing `GET /v2/` first when no challenge is present. Requests use core `node:http` and `node:https` with keep alive off, not global fetch, so sockets never outlive the run. Deleting a tag reclaims disk only once the registry runs its own cleanup, automatic on GitLab and Harbor. AWS ECR does not expose tag deletion with the V2 API, so cleanup reports a hint rather than pruning ECR.

### 2c. The shared global image in `src/utils/system-config.js` and `src/commands/system.js`

The team shared image state lives in the cluster, not on laptops. It is one ConfigMap, `coding-system` with label `coding-container=true`, in `k8s.namespace` default `coding`. Its `data` block holds strings only:

| Key | Meaning |
|---|---|
| `current` | what global mode deploys float on |
| `previous` | the version `current` had before its last change, the default roll back target, may be absent |
| `maxEver` | highest version ever published, never moves backward |
| `keep` | cleanup window, how many versions behind `current` to keep, integer string |

`src/utils/system-config.js` is the only place that reads or writes it. `getSystemConfig(ns)` reads plus validates with `parseSystemData()`. It throws a bootstrap hint when the ConfigMap is missing and a clear error on any invalid value such as `current` newer than `maxEver`. `patchSystemConfig(ns, state)` writes the complete state with `kubectl apply -f -`. Read then write is safe because the ConfigMap is tiny and writers are human driven. `systemConfigManifest()` renders the object. `resolveDeployTag(cfg)` implements the float, custom uses the project pin and requires it, global uses the pin when set else `current`.

All kubectl calls go through `kubectlExec()` in the same file. The `KUBECTL_BIN` env value points at a specific binary or wrapper. Tests stub the cluster this way. No real cluster, registry, docker build or network is needed for unit runs.

The system task group in `src/commands/system.js` is the only writer and reader of this state. It requires global mode, so a custom mode project gets a clear error instead of acting on the shared image:

* **Init:** creates the ConfigMap on a fresh cluster and fails when it already exists. There is exactly one per cluster. No image is built. The recorded version becomes the float target and `maxEver`.
* **Get:** prints current, previous, maxEver and keep plus the resolved global image.
* **List:** lists the shared repo registry tags, semver sorted newest first, marking current, previous and maxEver. Other tags are listed separately. Read only.
* **Create:** the only writer of the shared image. Validates the tag, semver above `maxEver` and not yet in the registry, omitted means `maxEver` patch plus one with `bumpPatch()`, builds plus pushes with `buildImage()` and `pushImage()`, then repoints previous to current and current and maxEver to the new tag.
* **Rollback:** repoints `current` to an existing version, default `previous`. The target must exist in the registry. Pure pointer change, no build, push or delete. `maxEver` never moves and `previous` becomes the old `current`.
* **Cleanup:** prunes the shared repo with `gcTags()`. Keeps `current` plus `previous` plus every tag in use plus the keep many semver predecessors of `current`.

Because the pointer lives in the cluster, publishing or rolling back needs no config edits anywhere. Every project picks the new `current` up on its next deploy.

### 3. Deploy in `src/commands/deploy.js`

Deploy first resolves the image tag with `resolveDeployTag()`. Custom mode uses the project pin and requires it, while global mode uses the pin when set else the `coding-system` ConfigMap `current`. On a fresh cluster without that ConfigMap you get the system init hint. Then it runs seven steps:

1. **SSH key:** `ensureKeyPair()` in `src/utils/keys.js` generates an ed25519 pair with `ssh-keygen` when none exists in the key folder, default `keys` next to the global config and override with `ssh.keyDir`, no passphrase and `0600` on the private key. The public key is read back for the manifest.
2. **Namespace:** created when missing with `kubectl create namespace`.
3. **NodePort preflight:** with `serviceType: NodePort`, the SSH `nodePort`, every `web.ports` `nodePort`, and every sidecar `nodePort` are checked against `kubectl get svc -A` in `findNodePortOwner()` in `src/utils/project.js`. A port held by another service fails the deploy before anything is applied, because a conflicting apply leaves a partial state. The project own service with an unchanged port is not a conflict.
4. **Pull secret:** `ensurePullSecret()` in `src/utils/registry.js` resolves in priority order: `k8s.imagePullSecret` from config when set, a previously created managed secret named `coding-<registry-host-with-dashes>`, a new managed secret built from local docker credentials including inline `~/.docker/config.json` auths or the OS credential helper such as `docker-credential-desktop`, then an existing `kubernetes.io/dockerconfigjson` secret in the namespace whose content matches the registry host. When none apply, deploy proceeds with a warning. The registry may be public or the cluster may have shared access.
5. **Manifest apply:** `fullManifest()` in `src/utils/manifest.js` renders up to five documents as YAML and pipes them to `kubectl apply -f -`:
    * **ConfigMap** `<project>-ssh`: holds `authorized_keys` with the local public key.
    * **Secret** `<project>-env`: rendered only when `k8s.secretEnv` is not empty. Holds secret values with `stringData`, so the Deployment never carries them as plaintext. A short content hash is stamped onto the pod template as `coding-container-secrets-hash` so rotated values roll the pods on the next deploy.
    * **Deployment** `<project>`: the container with its volumes and resources. References the pull secret with `imagePullSecrets` when one exists. Declares one containerPort per `web.ports` entry beside ssh. `k8s.sidecars` entries render as extra containers after the coding one, near raw pass through of the Kubernetes container spec, with `env` maps converted to a Kubernetes env list in `sidecarContainers()`.
    * **Service** `<project>`: `NodePort` by default, port `ssh.port` to `k8s.nodePort`, defaults `22` to `30022`, or `LoadBalancer`, plus a cluster port per `web.ports` entry carrying a `nodePort` when the entry sets one, and a NodePort port per sidecar port carrying a `nodePort`.
    * **Ingress** `<project>`: rendered only when `web.ports` is not empty. One rule per host. Each entry host or hosts list routes to that entry container port on the service, using `ingress.className` default `traefik`. This is how browsers reach dev servers. Entries with a `nodePort` are also reachable on every cluster node at `http://<node-ip>:<nodePort>/`.
6. **Rollout:** waits on `kubectl rollout status deployment/<project> --timeout=300s`. Skippable with the no wait job option.
7. **SSH alias:** `addHostEntry()` in `src/utils/ssh-config.js` writes or updates a `Host coding-<project>` block in the user `~/.ssh/config`, in a marker delimited managed section. Everything outside the markers is never touched. A failure here only warns. The block points at the node InternalIP plus the project NodePort, carries `StrictHostKeyChecking no` and a null device `UserKnownHostsFile`, see section 5, so VS Code Remote SSH works with no port forward. Remove deletes the block with `removeHostEntry()`.

### 4. The pod

The pod spec rendered by `deploymentManifest()` in `src/utils/manifest.js` declares two volumes:

* **`workspace`:** raw NFS volume. `nfs.server` at path `<nfs.basePath>`, which must exist on the NAS, mounted at `container.workdir` which is `/workspace` with `subPath: <nfs.subPath or project>` in `workspaceSubPath()`. NFS servers reject mounts of paths that do not exist, so the pod mounts the base export and isolates projects with `subPath`. The kubelet creates the project folder on the share at first mount. This is what makes workspaces survive pod restarts and stay per project isolated. `nfs.subPath` pins a specific folder, for example to reuse data across renames. Pod, service and alias names always stay the project name.
* **Extra NFS volumes:** `nfs.volumes` entries add further `volumeMounts` on the same `workspace` NFS volume in `extraVolumeMounts()`. Each mounts a subfolder of `nfs.basePath` at its own absolute `mountPath` in the coding container, with optional `readOnly: true`. No extra pod `volumes` are created. A new NFS `Volume` per entry would fail on folders that do not exist yet. The kubelet creates each subfolder at first mount, exactly like the project folder.
* **`ssh-keys`:** the `<project>-ssh` ConfigMap, mounted with `subPath: authorized_keys` at `/root/.ssh/authorized_keys`. The image ships an empty placeholder file. The mount shadows it with the project specific key.

**Sidecars:** `k8s.sidecars` entries run as extra containers in the same pod. They share the pod network, so the coding container reaches them on `localhost` with no host names, and its volumes so they can persist state on the `workspace` NFS volume under their own `subPath`, for example `subPath: postgres` for a database data folder. The service exposes ssh, the `web.ports` ports, and any sidecar port that carries a `nodePort`. Each of those renders an extra NodePort service port shaped like the ssh one in `sidecarNodePorts()`. The `nodePort` field is a service level knob and is removed from the rendered container port. A sidecar port becomes reachable outside by giving it a `nodePort`, raw TCP on every cluster node, for databases and queues that an HTTP Ingress cannot route. `web.ports` entries route to the coding container, so a sidecar `containerPort` duplicating one is rejected by validation, which also guarantees uniqueness across the pod.

Because the key lives in a ConfigMap and not in the image, rotating a key only needs key rotation plus deploy, with no image rebuild. The same applies to `k8s.secretEnv`. Values live in the `<project>-env` Secret, created and pruned on each deploy and removed by project removal, and `${VAR}` references in `k8s.env` and `k8s.secretEnv` expand from the local shell at load time. Missing values fail fast, so real secrets never need to sit in a YAML file.

Inside the container, `Dockerfile` configures sshd for key only root login, appends `cd /workspace` to `/root/.bashrc` and `/root/.profile` so every interactive session starts in the workspace, and runs an entrypoint at `/entrypoint.sh` that recreates `/run/sshd` before `exec /usr/sbin/sshd -D`. It also republishes container env for login shells. Opencode installs into `/root/.opencode/bin`. That folder is added to `PATH` with `ENV` and `/etc/profile.d/opencode.sh` so it is available in interactive, login and non interactive shells alike. The image ships opencode defaults from `opencode/opencode.json`, `opencode/cli.json`, the custom provider, and `opencode/agent/*.md` team agents, plus pi config dirs. Your per project files under `/workspace` stay separate from those image defaults.

### 5. SSH access in `src/commands/ssh.js` and the browser terminal

Two classic modes plus the browser terminal most people use:

* **Default port forward:** starts `kubectl -n <ns> port-forward svc/<service> <localPort>:<port>`, waits up to 15 seconds for the Forwarding from line, then runs `ssh -i <private key> -p <localPort> <user>@127.0.0.1`. The port forward child is stopped in a `finally` block when the session ends. When the configured `localPort` is already in use, the run falls back to a free port automatically.
* **Host keys:** pod sshd host keys are new on every image build, so persisting them has no value. A stale key makes VS Code refuse forwarding with Port forwarding is disabled. The run connects with `StrictHostKeyChecking=no` and `UserKnownHostsFile` pointing at the OS null device, `NUL` on Windows and `/dev/null` elsewhere in `ephemeralKnownHostsFile()` in `src/utils/ssh-config.js`, so keys are never written to the user global `~/.ssh/known_hosts` and a rebuilt image never blocks the next connection. Runs also remove any legacy `~/.config/coding-container/keys/<project>-known_hosts` file from older versions in `removeLegacyKnownHostsFile()`. This is acceptable for development pods on a trusted network. The private key remains the only credential.
* **Direct:** resolves the first node `InternalIP` with a `kubectl get nodes` jsonpath query and connects to `<nodeIP>:<nodePort>` directly. Use this from machines where `kubectl` works but long lived port forwards are unwanted. The node must be routable from the client.
* **Browser terminal:** most people press Terminal on the project page instead. The server opens the same SSH session server side and bridges it to the browser. See section 8.

### 5b. SSH alias store in `src/commands/list.js`

Deploy registers one `Host coding-<project>` block per project, see step 7 above. The SSH and Keys page is the read only view of those managed blocks. It parses `~/.ssh/config` in `listHostEntries()` in `src/utils/ssh-config.js` and prints a table of alias, host, port, user and identity file, sorted by host with IPv4 awareness then port. It never touches the cluster, config layers, or the SSH config.

The refresh action on the same page repairs stale aliases. It picks the IP of a currently Ready node in `getReadyNodeIp()`, falling back to any addressed node when no Ready condition is present, and looks up each `coding-<project>` alias service by name across all namespaces in `indexServicesByName()`, then rewrites the block HostName and Port from the live service ssh nodePort with `addHostEntry()`. Stale entries with no matching service and ambiguous ones with the same service name in several namespaces are left untouched with a warning, and nothing outside the managed block is modified. Both paths go through `kubectlExec()` with the `KUBECTL_BIN` override, as everywhere else. A preview option shows what would change without writing anything.

**Node IP resolution** in `src/utils/node-ip.js`: deploy and direct connect resolve the SSH target IP with `resolveSshNodeIp(cfg)`, the `hostIP` of a `Running` pod for the project when that node is `Ready`, else the first `Ready` node with an `InternalIP` in `pickNodeIp()`. JSON output with `-o json` is used instead of jsonpath so Windows script stubs avoid shell quoting issues. It returns null when the cluster is unreachable or nothing is `Ready`, so callers warn instead of writing a dead alias.

### 6. Projects registry shared by app and shell

`src/utils/projects.js` owns the JSON registry both interfaces share: an array of `id`, `name` and `configPath` at `<globalConfigDir()>/projects.json` unless `PROJECTS_FILE` overrides it, absolute or relative to the repo root. `readProjects()` and `writeProjects()` never throw on a missing or corrupt file, missing reads as empty. `resolveProjectsFile()` maps an explicit value to an absolute path, and `defaultProjectsFile()` touches the global folder first so a `PROJECTS_FILE` set in the checkout `.env` is loaded before it is read.

Managed configs live under `<globalDir>/projects/<slug>/config.yaml` in `managedProjectsDir()` and `defaultProjectConfigPath()`. `isManagedConfigPath()` tells managed from supplied paths. Managed paths follow renames, supplied paths stay put. `uniqueManagedConfigPath()` suffixes `-2`, `-3` and so on while a candidate is taken by another entry or an on disk file. `slugifyProjectName()` derives the DNS slug from a display name, lowercase, other chars to dash, collapse, trim, max 63 chars, fallback `project`. `computeProjectSlugs()` makes them unique in registry order, and `findProjectByRef()` plus `resolveProjectRefOrThrow()` match a user ref against id with exact or unique 4 char prefix, then slug, then name exact then case insensitive, throwing friendly errors otherwise.

The app server reuses the same helpers with shared prefixed imports and adds entry create, read, update and delete plus rename follows slug moves and a starter YAML generator with `buildStarterYaml()`, a Postgres sidecar template with allocated free NodePorts. The optional shell lists the same store in tabular or JSON form with per entry file exists flags. For the shell form, see [Terminal use](./cli-reference.md).

### 7. App backend in `web/server/server.js`

Single file Node ESM HTTP server with no framework. In file order:

1. **Paths and `.env`:** repo root `.env` plus legacy `web/.env` fallback parsed by a minimal `KEY=VALUE` parser in `parseDotEnv()`. Real environment wins. `loadEnvConfig()` yields sign in, port, projects file, auth file, jobs file, allowed origin and env file. `JOBS_FILE` overrides where the last 50 jobs persist, default `jobs.json` next to the registry. `CLUSTER_CACHE_TTL_MS` tunes the cluster snapshot cache, default 5000 ms.
2. **Auth:** single account hashed with scrypt in `auth.json` next to the projects registry, `defaultAuthFile()`, `AUTH_FILE` overrides. Read and write with `0600` in `readAuthRecord()` and `writeAuthRecord()` plus timing safe verify in `verifyAuthPassword()`. Startup migrates legacy `ADMIN_EMAIL` and `ADMIN_PASSWORD` once in `migrateLegacyToAuthFile()` and strips the plaintext line so the file wins afterwards. Unregistered means `GET /api/auth-status` reports registered plus canRegister with loopback check in `isLoopbackReq()`. `POST /api/register` is loopback only, remote gets a GUI message pointing at the local machine. `POST /api/login` verifies the hash to an in memory session token in an `HttpOnly` `SameSite=Lax` cookie named `SESSION_COOKIE`. Browser sessions last 12 hours. Desktop sessions use header `x-esuyo-desktop` over loopback, last 1 year, and slide forward while the app stays open. Register, login, auth status and health are public. Everything else under `/api` needs the session, and deleting the credential file voids sessions so the pages ask to register again. Password change with `POST /api/change-password`, 8 chars or more and must differ, rehashes, strips any `.env` leftover, and drops all other sessions.
3. **Projects registry:** `GET` and `POST /api/projects`, `GET`, `PUT` and `DELETE /api/projects/:id` with rename moves of managed configs without overwriting, explicit path changes win, plus `GET /api/project-starter` with slug plus two free NodePorts plus starter YAML. Startup migrates the legacy dev registry once in `migrateProjectsFile()`, `web/projects.json` to shared store with relative paths resolved against the repo root, and seeds a starter project when empty in `ensureDefaultProject()`, personal copy under the global folder, never the repo template. The starter template is a realistic app plus Postgres sidecar setup with allocated free NodePorts and clearly marked placeholder hosts and passwords.
4. **Structured reads that import `src` directly and never mutate:** `GET /api/config` with merged config plus redacted `k8s.secretEnv` plus raw YAML plus image mode, `GET` and `PUT /api/global-config` with global file plus effective Dockerfile path, `GET` and `POST /api/validate` for saved files on GET and unsaved editor drafts on POST with hidden temp sibling files removed by `cleanup()`, with NodePort taken or claimed warnings from `getClusterPorts()` plus other saved configs and silent offline, `GET` and `POST /api/manifest` with rendered manifests from captured validate output, `GET /api/key` with pair plus fingerprint plus image unresolved safe, `GET /api/system/state` and `/api/system/tags` project optional and without a project the repo root default config is used, `GET /api/cluster/summary` with one shared snapshot for nodes plus ports plus workloads, plus legacy `GET /api/cluster/nodes`, ports and workloads with live kubectl and degrading to ok false so config data still renders, per project workload status never throws per project, `GET /api/ssh-list` with managed aliases in host, port and alias sort, `GET /api/namespaces` or `GET /api/cluster/namespaces` with coding areas plus stored setup values plus ready flag, and `GET /api/ssh/info` with terminal page summary. Secret values are always redacted in API responses. The snapshot cache in `getCachedCluster()` keeps successful results for a short TTL so parallel page requests share one set of kubectl results.
5. **Job runner:** `POST /api/jobs` with op, projectId and args maps to a background task in `buildJobArgv()` with `ALLOWED_OPS` covering setup, create, build, push, deploy, delete, gc, system init, system create, system rollback, system gc, list update and key rotate, global choices first, then `startJob()` runs it with full environment passthrough so `KUBECTL_BIN` and `DOCKER_BIN` work, and captures the trailing 200 KB of logs. `GET /api/jobs` shows latest 50 summaries and `GET /api/jobs/:id` shows the full log. Jobs persist to `jobs.json` next to the registry so the list survives restarts, with running jobs marked interrupted on load. Progress polls until done or error. System and shared runs use the repo root config when no `projectId` is given.
6. **Static pages plus CORS:** serves `web/client/dist` with SPA fallback to `index.html`, `{"message":"GUI not built"}` when unbuilt, optional single origin CORS with `ALLOWED_ORIGIN` and preflight only for that origin.

### 8. Browser SSH terminal in `web/server/ssh-terminal.js`

`ws(s)://<host>/api/ssh/<projectId>` with the same session cookie auth as the REST API opens the project SSH session server side, `kubectl port-forward svc/<service>` with 15 second timeout and `KUBECTL_BIN` awareness, then an `ssh2` shell channel with a real pty size, `xterm-256color` and browser columns and rows with every resize forwarded as an SSH window change, and bridges raw bytes over a minimal RFC 6455 WebSocket built on Node builtins only, handshake plus frame codec and no extra package. Browser to server text frames carry terminal input except JSON `{"type":"resize","cols","rows"}` control messages. Server to browser binary frames carry session output. Session end or pre handshake failure is a close frame with a human readable reason. Failures map to friendly messages in `describeSshError()`. Pod host keys are accepted without persisting with `hostVerifier` always true, same reason as the null device known hosts. Every teardown path, browser close, shell close or error, and port forward close or error, ends the session. `openShell` is injectable so tests substitute the transport.

### 9. App frontend in `web/client/`

React 18 plus TypeScript SPA with react router, Tailwind, CodeMirror YAML editor, and xterm terminal lazily loaded only on the terminal page. Routes in `src/App.tsx`: `/login`, `/register`, `/` Dashboard with live workloads plus resource totals plus nodes plus NodePort usage plus per project deploy and remove shortcuts, filter by status, sort by name and status and age and CPU and memory and node, auto refresh picker, resizable ports table with SSH alias, status hover with ports, pod squares and age, `/projects` registry list with status filter and sort by name and status and namespace and NodePort plus row actions Create and Deploy and Edit and Terminal and Delete workloads, `/projects/new` and `/projects/import` for create and attach existing config, `/projects/:id/edit` with Settings plus Configuration plus Deploy tabs, starter Fill with example and Download example, YAML editor plus validate and manifest preview plus deploy tab plus config save, Remove entry versus Delete workloads, `/projects/:id/ssh` with browser terminal, `/images` with shared versus custom image repos and project override plus Versions plus Publish plus Roll back plus Cleanup jobs, `/system` with global config editor plus state summary plus system init, `/ssh-keys` with aliases plus refresh with dry run plus project key plus rotation, `/setup` with Coding area Use existing versus Create new plus stored values plus live fallback plus shared setup job plus shared config view, `/jobs` with job history plus live tail and persisted jobs, `/profile` with sign in plus password change, `/theme` with fonts plus font sizes and usage thresholds. Same origin `fetch('/api/...')` client in `src/lib/api.ts` with `ApiError` carrying status and body. Pure helpers in `src/lib/systemJobs.ts` and `src/pages/job-helpers.ts` for tags and keep and setup args and prefill. Dev Vite on `:3400` proxies `/api` including websockets at the API target `VITE_API_TARGET` default `http://127.0.0.1:3401`.

### 10. Desktop shell in `electron/`

Thin Electron wrapper around the same app and background work. The main process in `electron/main.js` launches the bundled app server in `web/server/server.js` with `server-launcher.mjs` on a loopback free port and shows it in a window. It adds only what an install needs: first run sign in inside the main window with the app sign in page offering registration when no account exists, email plus password checked with 8 chars or more, stored encrypted with the OS keychain with `safeStorage` in `credentials.enc` under `userData`, and a new registration continues to `/setup` in the same window, automatic sign in on launch with login cookie seeded into the window session and best effort fallback to the manual page, frameless window with web WindowControls for minimize and maximize and close, update notice line at the bottom of the nav for packaged builds, startup warnings when `docker`, `kubectl` or `ssh-keygen` are missing, reduced protection note on Linux without a keyring, encrypted storage unavailable dialog with Continue without staying signed in, single instance lock, health check before showing the window, and auto updates for packaged builds with `electron-updater` skipped for Store packages. The server inherits sign in, port and related values from the main process environment, no `PROJECTS_FILE` override, so it shares the per machine store next to the global config. Desktop sessions last 1 year and slide while open. Output persists to `<userData>/logs/gui-server.log` since desktop apps have no visible console. Packaging with `electron-builder.yml`, no asar so the backend keeps real files for background runs and Dockerfile and config resolution, bundles `main.js`, `preload.js`, `server-launcher.mjs`, `src`, `web/server`, the built `web/client/dist`, root `config.yaml` plus `Dockerfile` and `opencode/`, and the curated production `node_modules` set. Release CI syncs `electron/package.json` version to the npm release tag, so local bumps are not needed for releases.

## Failure behaviour

* Any background step that fails throws a human readable error. The app shows it on the Jobs page with the log tail.
* SSH session failures use the conventional 255 code internally and surface as a friendly message on the terminal page.
* Runs are idempotent where it matters: namespace and pull secret creation, key pair creation, and `kubectl apply` all do nothing when the desired state already exists.

## Security notes

For private, internal Kubernetes clusters only. Do not expose to the public web. This tool favors development ease over hardening: NodePort Services listen on every node, Ingress hosts have no auth or TLS by default, pods run SSH as root, host key checking is off, and Secrets are base64, not encrypted, unless you enable etcd encryption at rest. Only run it on a trusted internal network behind a firewall or VPN.

* The private key never leaves your machine. Only the public key reaches the cluster in a namespace scoped ConfigMap.
* `k8s.env` values are plaintext in the Deployment spec and visible to anyone who can `kubectl get deploy`. Put anything secret in `k8s.secretEnv` instead. Values travel in the `<project>-env` Secret and the Deployment only carries a reference. A Kubernetes Secret is base64, not encrypted, unless etcd encryption at rest is on. It still separates access and stays out of deploy output. Manifest preview redacts secret values for the same reason.
* Password auth is disabled in the container. Only key auth works. Pods still run SSH as root with host key checking off for rebuild ease. That is fine on a trusted internal network, and unsafe on the public internet.
* Every project opens one or more NodePorts, SSH plus optional web or sidecar ports, reachable through any node, and `web.ports` Ingress hosts are served with no auth or TLS by default. There are no `NetworkPolicy` objects or IP allow lists in the rendered manifests, so network isolation depends entirely on your cluster firewall or VPN.
* The key pair lives in `~/.config/coding-container/keys/` outside the repo and is shared by all projects by design. `ssh.keyDir` in a project config gives a project its own key. The global config is machine local. The project `config.yaml` is the only config that belongs in version control.
