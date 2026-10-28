# Configuration

How settings are layered, how to work on many projects, and where workspaces live on the NAS.

You do most of this in the app. The Setup page creates the global config, the Projects pages create and edit project configs, and the System page edits the global config with checks. This guide explains what each layer means so the forms make sense.

## Checkout identity, the root `.env`

Each checkout carries its own identity in a gitignored `.env` file in the repo root. Copy it from the template to suit a checkout. It keeps repeated checkouts such as prod and dev from sharing state.

| Key | Default | Effect |
|---|---|---|
| `CODING_CONFIG_LEAF` | `coding-container` | global folder is `~/.config/<leaf>` with config, Dockerfile, opencode defaults, keys and projects registry |
| `CODING_SSH_PREFIX` | `coding-` | SSH aliases read `<prefix><project>` |
| `CODING_NAMESPACE` | `coding` | default Kubernetes namespace, config files can still override it |
| `ADMIN_EMAIL` and `ADMIN_PASSWORD` | none | older first sign in, moved once into the hashed credential file, see [Web GUI](./gui.md) |
| `AUTH_FILE` | none | credential file override, default is `auth.json` next to the registry |
| `JOBS_FILE` | none | jobs file override, default is `jobs.json` next to the registry |
| `PORT` | `3401` | app server port |
| `PROJECTS_FILE` | none | registry override, absolute or relative to the repo root, default is `projects.json` next to the global config |
| `ALLOWED_ORIGIN` | none | optional single origin CORS for the app API |

Real environment values win over `.env`, and `.env` never overwrites keys already in the environment. Example dev instance: `CODING_CONFIG_LEAF=coding-container-dev`, `CODING_SSH_PREFIX=coding-dev-`, `CODING_NAMESPACE=coding-dev`.

## Layering, lowest to highest

1. **Built in defaults:** sensible generic values. Environment specific ones such as registry, NFS server and NFS base path stay empty on purpose. The Setup page fills them.
2. **Global config:** `~/.config/<leaf>/config.yaml`, created from the Setup page. Shared by every project: registry, image build, namespace, resources, NFS, SSH. Your SSH key pair lives next to it in `~/.config/<leaf>/keys`, the image `Dockerfile` is copied next to it during setup, and `opencode/` defaults are copied for the image build, so this config stays self contained and never points at the repo.
   The namespace is a naming convention, not access control. Use one name per developer for private work, or one shared name for a team. Every coding area namespace carries the `coding-container=true` label and its registry and NFS values are filled from namespace notes with live workload fallback.
3. **Project config:** the YAML you edit in a project page. It holds only what differs per project:

    ```yaml
    project: my-project        # Kubernetes resource name plus NAS subfolder name
    k8s:
      nodePort: 30022          # needed when several projects run at once
    web:
      ports:                   # browser access with Traefik Ingress, optional
        - { port: 3000, hosts: [my-web.example.com, www.example.com] }
    ```

4. **Your choices at run time:** the project you pick in the picker, the tag you type on the Images page, and similar job options win over saved files for that run.

Any key from any layer can be overridden in a higher layer. The global config for this machine looks like this:

```yaml
image:
  registry: registry.example.com/coding
  name: coding-container
  # tag: unset in global mode so deploys float on the current cluster version
  #      shown on the System page. Custom mode projects must set a tag.
  dockerfile: Dockerfile       # relative to this file, setup copies the repo Dockerfile here
  context: .                   # the build context is the global config folder, keys stay out
  buildArgs:
    BASE_IMAGE: ubuntu:26.04
    NODE_VERSION: "26"
    EXTRA_APT_PACKAGES: ""     # for example "tmux sqlite3"
    EXTRA_NPM_PACKAGES: ""     # for example "pnpm yarn"

k8s:
  namespace: coding
  replicas: 1
  serviceType: NodePort        # or LoadBalancer
  nodePort: 30022
  # nodeName: worker-02        # optional: pin the pod to one named node, see `kubectl get nodes`
  imagePullSecret: ""          # leave empty: the app resolves one automatically
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: "2",  memory: 8Gi }
  env: {}                      # extra environment variables
  # secretEnv: {}              # secret env with the managed <project>-env Secret, valueFrom refs
                               # values may use ${LOCAL_VAR} expanded from your shell at deploy time
  sidecars: []                 # extra pod containers such as a database, see ./sidecars.md

nfs:
  server: 10.0.0.5
  basePath: /workspaces
  # subPath: my-folder     # optional: pin the NAS subfolder, default is the project name
  # volumes: []            # extra NAS folders mounted into the container, see below

ssh:
  user: root
  port: 22
  keyName: id_ed25519
  # keyDir unset: keys live in ~/.config/coding-container/keys/, shared
  # Set ssh.keyDir in a project config to keep a separate key pair for that project

container:
  workdir: /workspace
  localPort: 2222              # local port used for direct SSH sessions
```

## Working on many projects

Use the Projects page to add a project by name. The app assigns a config path under the global folder, or you can attach an existing config file on the import page. Open the project to edit the YAML with checks and a manifest preview, then press Deploy.

If you prefer to start from a folder on disk, create a `config.yaml` there with at least the project name and a distinct NodePort:

```yaml
project: my-api
k8s:
  nodePort: 30023             # distinct NodePort so projects can run together
```

Then attach that file on the Projects import page and press Deploy. Each project gets its own pod, service and NAS subfolder such as `/workspaces/my-api`. Global mode projects share the same image and by default the same key pair. Custom mode projects build their own image, `registry/coding-<project>` unless `image.name` is set, and `ssh.keyDir` gives a project its own key pair.

## The shared projects registry

The app and the optional shell share one registry: a JSON array of `id`, `name` and `configPath` at `<globalDir>/projects.json`. `PROJECTS_FILE` can move it. Every app on the machine shares it by default. Projects created in the app get a managed config under `<globalDir>/projects/<slug>/config.yaml` that follows renames. Paths you supply stay put.

On the Projects page you see slug, name and id for each entry, plus a note when its file is missing. Open an entry to pick it for deploy, terminal, validation and key views.

**Pin the pod to a node.** By default the scheduler picks a node. To force placement on one named node, for example the one with the NAS mount or a GPU, set `k8s.nodeName` in the project editor. Use `kubectl get nodes` for names:

```yaml
project: my-api
k8s:
  nodeName: worker-02
```

It renders as `nodeName` on the pod spec. If that node is down or the name is wrong, the pod stays `Pending` until the node is back. Clear the key to let the scheduler pick again. It applies on the next Deploy.

**Pin the NAS folder.** By default the subfolder is the project name. To mount a specific folder instead, for example to reuse data from an earlier project or a folder you already manage on the NAS, set `nfs.subPath`, which must be a relative folder name under `nfs.basePath`:

```yaml
project: my-api
nfs:
  subPath: api-data           # /workspace points at <basePath>/api-data
```

Only the NAS folder changes. The pod, service, SSH alias and config map keep the project name. A missing folder is created on first mount, like any project subfolder.

## Extra NFS volumes

Beside `/workspace`, a project can mount extra NAS folders from the same share. List them under `nfs.volumes` in the project editor. Each entry reuses `nfs.server` and `nfs.basePath`:

```yaml
project: my-api

nfs:
  volumes:
    - subPath: shared-datasets    # NAS folder: <nfs.basePath>/shared-datasets
      mountPath: /data            # absolute path inside the container
      readOnly: true              # container can read, not write, default is false
    - subPath: team-tools
      mountPath: /opt/team-tools
```

* **Same share, subfolders only.** `subPath` must be a relative folder name under `nfs.basePath` with no leading slash and no empty or parent segments. It must not collide with the `/workspace` folder and must be unique across entries. A missing folder is created on first mount, like the project workspace folder.
* **`mountPath` is a container path.** It must be absolute with no trailing slash except root and no empty or parent segments. It must not be `/workspace` or anything under it, must not be `/root/.ssh/authorized_keys`, and entries must not nest inside or duplicate each other.
* **`readOnly`:** when true, the container cannot write to the mount. Omit it or set false for a writable mount.
* **Only the coding container gets the mounts.** A sidecar that needs the same data references the `workspace` volume with its own `subPath` in its `volumeMounts`, see ./sidecars.md.
* Changes apply on the next Deploy. Removing an entry unmounts the folder, and nothing on the NAS is ever deleted by the app.

## See also

- [Environment variables and secrets](./env-and-secrets.md) for plain values plus secret handling with shell variables
- [Shared global image](./global-image.md) for global and custom image modes and versioning
- [Web GUI](./gui.md) for Setup, Projects and System pages
- [Terminal use](./cli-reference.md) for the same tasks from a prompt
- [Architecture](./architecture.md) for how layering and validation are implemented
