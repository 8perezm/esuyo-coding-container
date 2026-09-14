# Configuration

How settings are layered, how to work on multiple projects, and how workspaces are stored on the NAS.

## Layering (lowest to highest priority)

1. **Built-in defaults:** sensible generic values. Environment-specific ones (registry, NFS server, NFS base path) are intentionally left unset and are captured by `coding-container setup`.
2. **Global config:** `~/.config/coding-container/config.yaml` (honors `XDG_CONFIG_HOME`), created by `coding-container setup`. Shared by every project: registry, image build, namespace, resources, NFS, SSH. Your SSH key pair lives next to it in `~/.config/coding-container/keys/`, and the image `Dockerfile` is copied next to it on setup (so this config is self-contained and never points at the repo).
3. **Project config:** `config.yaml` in the folder you run the command from (picked up automatically; override with `-c`, else the repo's own `config.yaml` is used). `create` scaffolds it if missing. Only what differs per project:

   ```yaml
   project: my-project        # k8s resource name + NAS subfolder name
   k8s:
     nodePort: 30022          # needed when several projects run at once
   web:
     ports:                   # browser access (Traefik Ingress), optional
       - { port: 3000, hosts: [my-web.example.com, www.example.com] }
   ```

4. **CLI flags:** `-p/--project` and `--tag` win over everything.

Any key from any layer can be overridden in a higher layer. The global config for this machine looks like:

```yaml
image:
  registry: registry.example.com/coding
  name: coding-container
  # tag: unset in global mode -> deploys float on the cluster's current version
  #      (see 'coding-container system get'). Custom-mode projects must set a tag.
  dockerfile: Dockerfile       # relative to this file's dir; setup copies the repo Dockerfile here
  context: .                   # the build context is the global config folder (keys stay out)
  buildArgs:
    BASE_IMAGE: ubuntu:26.04
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
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: "2",  memory: 8Gi }
  env: {}                      # extra environment variables
  # secretEnv: {}              # secret env (managed <project>-env Secret, valueFrom refs);
                               # values may use ${LOCAL_VAR} (expanded from your shell at deploy time)
  sidecars: []                 # extra pod containers (db, queue, ...), see ./sidecars.md

nfs:
  server: 10.0.0.5
  basePath: /workspaces
  # subPath: my-folder     # optional: pin the NAS subfolder (default: project name)
  # volumes: []            # extra NAS folders mounted into the container, see below

ssh:
  user: root
  port: 22
  keyName: id_ed25519
  # keyDir unset: keys live in ~/.config/coding-container/keys/ (shared).
  # Set ssh.keyDir in a project config to keep a per-project key pair instead.

container:
  workdir: /workspace
  localPort: 2222              # local port used by `coding-container ssh`
```

## Working on multiple projects

`cd` into a new (or existing) project folder and run `coding-container create`. If the folder has no `config.yaml`, one is created automatically: project name from the folder name, first free NodePort from the cluster:

```sh
cd C:\work\my-api
coding-container create      # auto-creates ./config.yaml, then deploys
                                 # (global mode floats on the shared image;
                                 #  custom-mode projects build + push first)
```

The auto-created file is minimal. Edit it to change anything:

```yaml
project: my-api
k8s:
  nodePort: 30023             # distinct nodePort so projects can run together
```

`-c <file>` still works when you don't want to `cd` (e.g. `coding-container -c C:\work\api\config.yaml ssh`). Each project gets its own pod, service, and NAS subfolder (`/workspaces/my-api`). Global-mode projects share the same image and (by default) the same key pair; custom-mode projects build their own image (`registry/coding-<project>` unless `image.name` is set), and `ssh.keyDir` opts a project into its own key pair.

**Pinning the NAS folder.** By default the subfolder is the project name. To mount a specific folder instead (e.g. to reuse data from an earlier project or a folder you already manage on the NAS), set `nfs.subPath`, which must be a relative folder name under `nfs.basePath`:

```yaml
project: my-api
nfs:
  subPath: api-data           # /workspace -> <basePath>/api-data
```

Only the NAS folder changes: the pod, service, SSH alias and configmap keep the project name. A missing folder is created on first mount, like any project subfolder.

## Extra NFS volumes

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

- **Same share, subfolders only.** `subPath` must be a relative folder name under `nfs.basePath` (no leading `/`, no empty or `..` segments); it must not collide with the `/workspace` folder and must be unique across entries. A missing folder is created on first mount, like the per-project workspace folder.
- **`mountPath` is a container path.** It must be absolute with no trailing `/` (except root) and no empty/`..` segments. It must not be `/workspace` (or anything under it), must not be `/root/.ssh/authorized_keys`, and entries must not nest inside or duplicate each other.
- **`readOnly`:** when `true`, the container cannot write to the mount; omit it (or set `false`) for a writable mount.
- **Only the coding container gets the mounts.** A sidecar that needs the same data references the `workspace` volume with its own `subPath` in its `volumeMounts` (see ./sidecars.md).
- Changes apply on the next `deploy` (or `create`); removing an entry unmounts the folder, and nothing on the NAS is ever deleted by the CLI.

## See also

- [Global image](./global-image.md): global vs. custom image modes and versioning
- [CLI reference](./cli-reference.md): all commands and flags
- [Architecture](./architecture.md): how layering and validation are implemented
