# coding-container

> Spin up a ready-to-code SSH container on your k3s cluster in one command.

`coding-container` is a command-line tool for developers who want a consistent, powerful coding environment for any project. One command builds a Docker image with Ubuntu, Node.js, [opencode](https://opencode.ai), [pi](https://pi.dev), Playwright and common dev tools, publishes it to your registry (`registry.example.com/you`), and deploys it to the `coding` namespace of your k3s cluster. You then SSH straight in and land in `/workspace` — a folder that is backed by your NAS, so your work survives restarts and is kept separate per project.

Everything is driven by two small YAML files: a global config (`~/.config/esuyo-coding-container/config.yaml`) for your environment, and a per-project `config.yaml` layered on top. Each project you work on gets its own isolated container and workspace folder with zero code changes.

## Features

- **One command, full pipeline**: build the image, push it to your registry, deploy to k3s.
- **SSH access with your own key**: an SSH key pair is generated once and stored in your global config folder (`~/.config/esuyo-coding-container/keys/`, shared by all projects); only the public key ever reaches the cluster. You land in `/workspace` on login.
- **Browser access via Traefik**: expose any number of container ports as named Ingress hosts (`web.ports`), so dev servers are reachable in a browser — no port-forwards, no NodePorts for HTTP (an entry can optionally also get a NodePort).
- **Persistent per-project workspaces**: `/workspace` is mounted from `10.0.0.5:/workspaces/<project>` — a dedicated NAS subfolder for every project.
- **Powerful base image**: Ubuntu 24.04, Node.js 22, opencode, pi, Playwright + Chromium, htop, git, build-essential, ripgrep, fd, jq and more — extendable with extra apt/npm packages from the config.
- **Sidecars for app dependencies**: databases, message queues, caches — `k8s.sidecars` adds extra containers to the pod, reachable from the coding container on `localhost`, with state persisted on the NAS.
- **Fully configurable via YAML**: registry, tags, namespace, replicas, resources, ports, NFS location, SSH user — all in `config.yaml`.
- **Key rotation without rebuilding**: regenerate the key and redeploy; the image is never rebuilt for a key change.

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js >= 18 | Runs the CLI |
| Docker | Builds and pushes the image |
| `docker login` to your registry | `docker login registry.example.com` |
| `kubectl` configured for your k3s cluster | Already set up on your machine |
| OpenSSH (`ssh`, `ssh-keygen`) | Standard on Windows 10+, macOS, Linux |
| Cluster nodes can reach your NAS | `10.0.0.5` must be reachable from the k3s nodes, and `nfs.basePath` (`/workspaces`) must exist on it — per-project folders are created automatically |

## Installation

From the project folder (`C:\work\coding-container`):

```sh
npm install
npm link
```

`npm link` puts `coding-container` on your PATH. If you prefer not to link globally, run it with `node src/index.js ...` instead.

Verify the install:

```sh
coding-container --help
```

One-time setup — creates the global config, copies the image `Dockerfile` next to it, and generates your SSH key pair (never overwrites existing files). It asks a few questions about your environment (container registry, NFS server, NFS base path) — or pass them as flags to run it non-interactively:

```sh
coding-container setup
# or:
coding-container setup --registry registry.example.com/you --nfs-server 10.0.0.5 --nfs-base-path /workspaces
```

These values are environment-specific, so they can't be skipped: without a global config (or the flags above) commands fail fast with a clear "run `coding-container setup`" error. Running `setup` non-interactively without flags writes clearly-marked placeholders for you to fill in.

## Configuration

Settings are layered, lowest to highest priority:

1. **Built-in defaults** — sensible generic values. Environment-specific ones (registry, NFS server, NFS base path) are intentionally left unset and are captured by `coding-container setup`.
2. **Global config** — `~/.config/esuyo-coding-container/config.yaml` (honors `XDG_CONFIG_HOME`), created by `coding-container setup`. Shared by every project: registry, image build, namespace, resources, NFS, SSH. Your SSH key pair lives next to it in `~/.config/esuyo-coding-container/keys/`, and the image `Dockerfile` is copied next to it on setup (so this config is self-contained and never points at the repo).
3. **Project config** — `config.yaml` in the folder you run the command from (picked up automatically; override with `-c`, else the repo's own `config.yaml` is used). `create` scaffolds it if missing. Only what differs per project:

    ```yaml
    project: my-project        # k8s resource name + NAS subfolder name
    k8s:
      nodePort: 30022          # needed when several projects run at once
    web:
      ports:                   # browser access (Traefik Ingress), optional
        - { port: 3000, host: my-web.example.com }
    ```

4. **CLI flags** — `-p/--project` and `--tag` win over everything.

Any key from any layer can be overridden in a higher layer. The global config for this machine looks like:

```yaml
image:
   registry: registry.example.com/you
   name: coding-container
   # tag: unset in global mode -> deploys float on the cluster's current version
   #      (see 'coding-container system get'). Custom-mode projects must set a tag.
  dockerfile: ~/.config/esuyo-coding-container/Dockerfile   # copied here by setup
  context: ~/.config/esuyo-coding-container
  buildArgs:
    BASE_IMAGE: ubuntu:24.04
    NODE_VERSION: "22"
    EXTRA_APT_PACKAGES: ""     # e.g. "tmux sqlite3"
    EXTRA_NPM_PACKAGES: ""     # e.g. "pnpm yarn"

k8s:
  namespace: coding
  replicas: 1
  serviceType: NodePort        # or LoadBalancer
  nodePort: 30022
  imagePullSecret: ""          # leave empty: the CLI resolves one automatically
    resources:
      requests: { cpu: 500m, memory: 1Gi }
      limits:   { cpu: "4",  memory: 8Gi }
    env: {}                      # extra environment variables
    # secretEnv: {}              # secret env (managed <project>-env Secret, valueFrom refs);
                                 # values may use ${LOCAL_VAR} (expanded from your shell at deploy time)
    sidecars: []                 # extra pod containers (db, queue, ...), see below

nfs:
  server: 10.0.0.5
  basePath: /workspaces
  # subPath: my-folder     # optional: pin the NAS subfolder (default: project name)
  # volumes: []            # extra NAS folders mounted into the container, see below

ssh:
  user: root
  port: 22
  keyName: id_ed25519
  # keyDir unset: keys live in ~/.config/esuyo-coding-container/keys/ (shared).
  # Set ssh.keyDir in a project config to keep a per-project key pair instead.

container:
  workdir: /workspace
  localPort: 2222              # local port used by `coding-container ssh`
```

### Working on multiple projects

`cd` into a new (or existing) project folder and run `coding-container create`. If the folder has no `config.yaml`, one is created automatically — project name from the folder name, first free NodePort from the cluster:

```sh
cd C:\work\my-api
coding-container create      # auto-creates ./config.yaml, then builds + pushes + deploys
```

The auto-created file is minimal — edit it to change anything:

```yaml
project: my-api
k8s:
  nodePort: 30023             # distinct nodePort so projects can run together
```

`-c <file>` still works when you don't want to `cd` (e.g. `coding-container -c C:\work\api\config.yaml ssh`). Each project gets its own pod, service, and NAS subfolder (`/workspaces/my-api`), all sharing the same image and key pair.

**Pinning the NAS folder.** By default the subfolder is the project name. To mount a specific folder instead (e.g. to reuse data from an earlier project or a folder you already manage on the NAS), set `nfs.subPath` — it must be a relative folder name under `nfs.basePath`:

```yaml
project: my-api
nfs:
  subPath: api-data           # /workspace -> <basePath>/api-data
```

Only the NAS folder changes: the pod, service, SSH alias and configmap keep the project name. A missing folder is created on first mount, like any project subfolder.

### Extra NFS volumes

Besides `/workspace`, a project can mount any number of additional NAS folders from the same share. List them under `nfs.volumes`; each entry reuses `nfs.server` and `nfs.basePath`:

```yaml
project: my-api

nfs:
  volumes:
    - subPath: shared-datasets    # NAS folder: <nfs.basePath>/shared-datasets
      mountPath: /data            # absolute path inside the container
      readOnly: true              # container can read, not write (default: false)
    - subPath: team-tools
      mountPath: /opt/team-tools
```

- **Same share, subfolders only.** `subPath` must be a relative folder name under `nfs.basePath` (no leading `/`, no `..`); a missing folder is created on first mount, like the per-project workspace folder.
- **`mountPath` is a container path.** It must be absolute, must not be `/workspace` (or anything under it), and entries must not nest or duplicate each other.
- **`readOnly`** — when `true`, the container cannot write to the mount; omit it (or set `false`) for a writable mount.
- **Only the coding container gets the mounts.** A sidecar that needs the same data references the `workspace` volume with its own `subPath` in its `volumeMounts` (see the sidecars section).
- Changes apply on the next `deploy` (or `create`); removing an entry unmounts the folder, and nothing on the NAS is ever deleted by the CLI.

## Quick Start

1. Set your project name in `config.yaml`:

   ```yaml
   project: my-project
   ```

2. Deploy:

   ```sh
   coding-container create
   ```

   This generates your SSH key (first run only), creates the `coding` namespace if needed, and deploys until the pod is running. In the default (global) mode `create` does **not** build or push — it deploys the shared global image at the version the cluster currently points at (a fresh cluster needs a one-time `coding-container system init` first — see [The shared global image](#the-shared-global-image)). Projects in custom mode (they set `image.dockerfile`, `image.buildArgs` or `image.name` in the *project* config) build + push their own image first, under a required `image.tag`.

3. SSH in — you land in `/workspace`:

   ```sh
   coding-container ssh
   ```

   Inside the container you have `node`, `opencode`, `pi`, `playwright`, `htop`, and everything else. Exit with `exit`; the SSH tunnel is cleaned up automatically.

4. When you're done with the project:

   ```sh
   coding-container delete
   ```

    (Your files remain safe on the NAS — deleting only removes the cluster resources.)

## The shared global image

Projects run in one of two image modes, decided by the *project* config:

- **Global mode (the default)** — the project does not set `image.dockerfile`, `image.buildArgs` or `image.name`. Every such project runs one team-shared image, `image.registry/image.name` (e.g. `registry.example.com/you/coding-container`), versioned with human semver tags (`v1.0.0`, `v1.1.0`, ...). Deploys **float** on the version the cluster currently points at — no config edit is needed when a new version is published.
- **Custom mode** — the project sets any of `image.dockerfile` / `image.buildArgs` / `image.name`. The project builds + pushes its own image, `image.registry/coding-<project>` (or `image.name` if set), and `image.tag` is **required** (it pins the exact version the project deploys).

The cluster is the source of truth for the global image: a ConfigMap named `coding-system` in the `coding` namespace holds the state (all strings):

| Key | Meaning |
|---|---|
| `current` | what global-mode deploys float on |
| `previous` | last version `current` had before its last change (the default rollback target; may be absent) |
| `maxEver` | highest version ever published; never moves backward, so a rolled-back (poisoned) version can never be republished |
| `keep` | gc window: how many versions behind `current` to keep |

Run the `system` commands from a global-mode project (or the repo root):

```sh
# One-time bootstrap on a fresh cluster (fails if the ConfigMap exists):
coding-container system init --tag v1.0.0

# Inspect / list:
coding-container system get             # current/previous/maxEver/keep + resolved image
coding-container system list            # the global repo's tags, semver-sorted

# Publish a new version (the only writer of the global image):
coding-container system create --tag v1.1.0
# builds + pushes coding-container:v1.1.0, then repoints:
#   previous = current, current = v1.1.0, maxEver = v1.1.0
# The tag must be semver, not exist in the registry yet, and be greater than maxEver.

# Roll back (pure pointer change — no build, push or delete):
coding-container system rollback        # back to 'previous'
coding-container system rollback v1.0.0 # back to a specific existing version

# Prune old versions:
coding-container system gc --dry-run
```

Notes:

- `system init` only creates the ConfigMap (no image is built); the first real image is published with `system create --tag <a version greater than the init tag>`, and that is what projects start floating on.
- After any `system create` or `rollback`, existing projects pick the new version up on their next `deploy`/`create` — no config changes, no re-builds on the projects' side.
- Global-mode tags must be semver; custom-mode tags are free-form but required.
- To run your project on a specific global version (instead of floating), pin it with `image.tag` in the project config or `--tag`.

## Web access (Traefik Ingress)

For web app development you'll want to reach the dev server in a browser. List the container ports you need in `web.ports`; each entry gets one Ingress host that routes to that port on the project's service. The rule is rendered with `ingress.className` (default `traefik`, the class k3s ships) and is applied on every `deploy`:

```yaml
project: my-webapp

web:
  ports:
    - { port: 3000, host: my-webapp.example.com }        # e.g. Vite/Next
    - { port: 8080, host: my-api.example.com, name: api } # optional explicit port name
    - { port: 5173, host: my-vite.example.com, nodePort: 30080 } # + optional NodePort
```

- **You choose the hosts.** Nothing is hardcoded — the host is whatever you put in the config, per project. Use as many entries as you have ports.
- **DNS is on you.** Each host must resolve (A/AAAA record, wildcard, or hosts entry) to your Traefik LoadBalancer IP. The CLI does not manage DNS.
- **Optional NodePort per port.** An entry's `nodePort` (30000–32767) additionally exposes that port on every cluster node, so the app is also reachable at `http://<node-ip>:<nodePort>/` — useful when the Ingress hosts don't resolve from your machine. The port must be unique across the SSH NodePort, `web.ports`, and sidecar `nodePort`s; `deploy` checks the cluster for conflicts before applying and prints the resulting URL.
- After `deploy` the CLI prints the resulting URLs.

```sh
$ coding-container create
Deployed my-webapp in coding
Web (Traefik Ingress):
  http://my-webapp.example.com/  (container port 3000)
  http://my-api.example.com/  (container port 8080)
```

`delete` removes the Ingress along with the deployment, service and configmap.

## Sidecars (databases, message queues, ...)

If the app you're developing needs another container in the pod — a Postgres database, Redis, RabbitMQ — list it under `k8s.sidecars`. Each entry runs alongside the coding container in the same pod and shares its network namespace, so the app in the coding container reaches it on `localhost`:

```yaml
project: my-api

k8s:
  sidecars:
    - name: postgres
      image: postgres:16
      env:                             # map (like k8s.env) or a plain k8s env list
        POSTGRES_DB: myapi
        POSTGRES_PASSWORD: dev
      ports:
        - { containerPort: 5432, name: postgres }
      volumeMounts:                    # persist the data on the NAS workspace
        - name: workspace
          mountPath: /var/lib/postgresql/data
          subPath: postgres
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits:   { cpu: "1",  memory: 1Gi }
```

- **Near-raw k8s container spec.** Only `name` and `image` are required; everything else (`command`, `args`, `env`, `envFrom`, `ports`, `volumeMounts`, `resources`, probes, `securityContext`, ...) passes through unchanged, so any image works. `env` additionally accepts a plain map.
- **Persist state on the NAS.** Mount the `workspace` volume with its own `subPath` (as above) and the data survives restarts, isolated per project — same folder your `/workspace` lives in.
- **Access from the coding container: `localhost`.** All containers in a pod share the network namespace — point the app at `localhost:5432`, no hostnames needed.
- **Optional browser access.** Add the sidecar's port to `web.ports` (e.g. `{ port: 5432, host: my-api-db.example.com }`) and it gets a Traefik Ingress host like any other container port.
- **Optional NodePort for non-HTTP services.** Traefik's Ingress routes HTTP, so TCP services (databases, queues) can't use `web.ports`. Add a `nodePort` (30000–32767) to a sidecar port entry to expose it on every cluster node: `{ containerPort: 5432, name: postgres, nodePort: 30432 }` — then connect from your machine to `<node-ip>:30432`. The NodePort must be unique and different from the SSH NodePort (`k8s.nodePort`); `deploy` prints the resulting mapping.
- **Collisions are rejected.** A sidecar port must not duplicate the SSH port or a `web.ports` port, and container names/ports must be unique across sidecars — otherwise the service's port resolution becomes ambiguous.
- **Single replica.** `k8s.replicas` must stay `1` while sidecars are configured: replicas share the same NAS folder, so two stateful sidecars would clobber each other.

## Commands

| Command | What it does |
|---|---|
| `coding-container setup` | One-time: create the global config + Dockerfile + SSH key pair (never overwrites) |
| `coding-container create` | Deploy the project (the full pipeline); registers an SSH alias in `~/.ssh/config`. Global mode: deploys the shared image (float). Custom mode: builds + pushes the project image first |
| `coding-container build` | Build the project's custom image (global-mode projects: use `system create`) |
| `coding-container push` | Push the project's custom image (global-mode projects: use `system create`) |
| `coding-container deploy` | Apply the k8s manifests and wait for the rollout (global mode: floats on the cluster's current version) |
| `coding-container ssh` | Open an SSH session (via `kubectl port-forward`) |
| `coding-container key` | Show or generate the SSH key pair |
| `coding-container validate` | Load and validate the config without changing anything (`--manifest` prints the rendered k8s manifests) |
| `coding-container delete` | Remove deployment, service, Ingress and SSH configmap, and the SSH alias (alias: `destroy`) |
| `coding-container gc` | Delete old tags from the project's custom image repo (custom mode only; global-mode projects: use `system gc`) |
| `coding-container system init` | One-time: create the `coding-system` ConfigMap on a fresh cluster (global mode) |
| `coding-container system get` | Show current/previous/maxEver/keep and the resolved global image |
| `coding-container system list` | List the global repo's registry tags, semver-sorted (read-only) |
| `coding-container system create` | Build + push a new global version and repoint `current` (the only writer of the global image) |
| `coding-container system rollback` | Repoint `current` to an existing version (default: `previous`); no build/push/delete |
| `coding-container system gc` | Delete old tags from the global repo (keeps `current`, `previous`, all in-use tags and the ConfigMap's `keep`-many behind `current`) |

Useful flags:

```sh
# Global (before the command)
-c, --config <file>    use a different config (default: ./config.yaml if present)
-p, --project <name>   override the project name
    --tag <tag>        pin the image tag (global mode: semver; custom mode: required if unset in config)

# create
    --skip-build       reuse the locally built image
    --skip-push        reuse the already-pushed image

# deploy
    --no-wait          don't block on the rollout

# ssh
    --direct           connect via node IP + nodePort instead of port-forward

# key
    --force            regenerate the key pair (rotate access)

# delete
    --keep-secrets     keep the SSH configmap

# gc (custom mode) / system gc
    --keep <n>         how many versions behind the pin/current to keep (gc default: 5; system gc: the ConfigMap's keep)
    --dry-run          list what would be deleted without deleting anything

# system create
    --tag <tag>        the new version to publish (semver, > maxEver, not yet in the registry)

# system init
    --tag <tag>        the initial version (semver)
    --keep <n>         the gc window to store in the ConfigMap (default: 10)

# system rollback
    [tag]              version to roll back to (default: 'previous')
```

### Garbage-collecting old images

Global images accumulate one tag per published version; custom images one per build. Two commands prune them, with the same safety rules:

```sh
coding-container gc             # custom repo: keep the pinned tag + 5 versions behind it
coding-container gc --keep 10   # wider window
coding-container gc --dry-run   # preview only
coding-container system gc --dry-run   # global repo
```

A tag is **never** deleted if it is any of:
- **In use** — referenced by a `coding-container=true` deployment in the namespace (queried live via `kubectl`; if that query fails, gc refuses to delete anything).
- **The pin** — the project's `image.tag` (custom), or the ConfigMap's `current` (global).
- **`previous`** — the ConfigMap's last version (global only).
- **Within the keep window** — the newest `--keep` (or ConfigMap `keep`) semver versions behind the pin/current.

Everything else is deleted, oldest first. Non-semver tags (e.g. `latest` or legacy timestamp tags) are never counted in the keep window — they are deleted unless in use (gc reports them separately in dry runs). Deleting a tag frees disk space only once the registry runs its own garbage collection — automatic on GitLab/Harbor, or `registry garbage-collect` on a bare Docker registry. Note that AWS ECR does not expose tag deletion through the standard registry API, so gc cannot prune ECR-hosted images.

### Rotating your SSH key

```sh
coding-container key --force   # new key pair in ~/.config/esuyo-coding-container/keys/
coding-container deploy        # push the new public key to the cluster
```

Note: the key pair is shared across projects, so after `--force` **every** deployed project needs a `deploy` to receive the new public key. Give a project its own key with `ssh.keyDir` in its config if you need independent rotation.

## Using VS Code (Remote - SSH)

`deploy`/`create` register an SSH alias `coding-<project>` in your `~/.ssh/config` (in a managed block the CLI owns; `delete` removes it). To connect:

1. Install the **Remote - SSH** extension (`ms-vscode-remote.remote-ssh`).
2. `Ctrl+Shift+P` → **Remote-SSH: Connect to Host...** → pick `coding-<project>`.
3. Open folder `/workspace` — your persistent NAS-backed workspace.

The entry points at the k3s node's IP + the project's NodePort, so it works without any port-forward running. If a connection fails with a host-key mismatch after a rebuild (pod host keys rotate per image), delete the project's known-hosts file (`~/.config/esuyo-coding-container/keys/<project>-known_hosts`) and reconnect.

## Troubleshooting

**`config: image.registry is not set` (or `nfs.server` / `nfs.basePath`)**
Your global config is missing an environment-specific value. Run `coding-container setup` (it asks for them, or accept `--registry` / `--nfs-server` / `--nfs-base-path`), or add the values to `~/.config/esuyo-coding-container/config.yaml` yourself.

**Push fails with an authentication error**
Log in to the registry first: `docker login registry.example.com`.

**Pod is stuck in `ImagePullBackOff`**
The cluster can't pull the image. On deploy, the CLI resolves a pull secret automatically: `k8s.imagePullSecret` if you set it, a managed secret it created from your local docker credentials, or an existing `dockerconfigjson` secret in the namespace that matches the registry. To force a refresh, delete the managed secret and redeploy:

```sh
kubectl -n coding delete secret coding-registry-example-com
coding-container deploy
```

Or pin a specific secret with `k8s.imagePullSecret` in `config.yaml`.

**Pod is stuck in `ContainerCreating`**
Almost always the NFS mount: a k3s node can't reach `10.0.0.5`, or `nfs.basePath` does not exist on the NAS (per-project folders are created automatically, but the base path must exist). The mount error names the cause: `kubectl -n coding describe pod -l app=<project>`.

**`coding-container ssh` says port-forward did not start in time**
The pod isn't running yet (`kubectl -n coding get pods`), or kubectl can't reach the cluster. A busy local port 2222 is no longer a problem — the CLI switches to a free port automatically.

**SSH complains that the host key changed after a rebuild**
In practice it won't: pod host keys rotate with every image build, so the CLI auto-accepts new keys into a per-project file (`~/.config/esuyo-coding-container/keys/<project>-known_hosts`) instead of your global `~/.ssh/known_hosts`.

**Nodes keep using an old image after a rebuild**
Should not happen: the pod spec uses `imagePullPolicy: Always`, so every new pod re-checks the registry before starting. If a pod still runs an old image, the deployment's image string didn't change, so no new pod was created — check it with `kubectl -n coding get deployment <project> -o jsonpath='{.spec.template.spec.containers[0].image}'` and force one with `kubectl -n coding rollout restart deployment/<project>`.

**NodePort already in use by another service**
`deploy` checks for this before applying anything and fails with the name of the service holding the port (e.g. `nodePort 30023 (k8s.nodePort (SSH)) is already allocated to service "tryout" in namespace "coding"`). NodePorts are allocated cluster-wide, so ports used by other projects count too. Pick a different `k8s.nodePort` (30000–32767) in `config.yaml` (and for sidecar `nodePort`s likewise), then deploy again.

**Web app unreachable in the browser (Ingress)**
Work the chain from the outside in:
1. Does the host resolve to your Traefik LoadBalancer IP? (`nslookup <host>`)
2. Is the Ingress present and does it list the host? `kubectl -n coding get ingress -o wide`
3. Is the ingress class `traefik` (the one k3s ships)? `kubectl get ingressclass`
4. Is the dev server actually listening on the container port inside the pod? `kubectl -n coding exec deploy/<project> -- ss -ltnp` (or the tool's own log)
5. Is Traefik itself running? `kubectl -n kube-system get pods | grep traefik`

**Preview the exact manifests without touching the cluster**

```sh
coding-container validate --manifest
coding-container validate --manifest | kubectl apply --dry-run=client -f -
```

Or inspect what is currently deployed:

```sh
kubectl -n coding get deploy,svc,cm,pod -l coding-container=true
```

## License

MIT

## Developer Documentation

- [Architecture](./docs/architecture.md) — Tech stack, pipeline flow, SSH key and NFS models
- [Project Structure](./docs/project-structure.md) — File layout and the role of each module
- [Development Guide](./docs/development.md) — Running from source, extending commands and the image, debugging
