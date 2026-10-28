# Terminal use

An optional way to work for people who prefer a shell. Most people should use the desktop app or the browser pages instead.

If you are new here, start with the README and open the app. Come back to this page only if you specifically want to drive projects from a shell on this machine.

## A quick note before you start

The app is the primary path. It gives you the Dashboard for live status, the Projects pages for editing and deploy, the Images and System pages for the shared image, the SSH and Keys page for aliases and key rotation, and the Jobs page for logs. Everything below has an equivalent button or form in those pages. If something here feels unclear, you will likely find it easier in the app.

You still need the same prerequisites as the app: Node.js 18 or newer, Docker, kubectl pointed at your cluster, OpenSSH tools on PATH, plus a registry you can push to and a NAS your nodes can reach.

## Installation

```sh
npm install -g @esuyo/coding-container
coding-container --help
```

Or run from source:

```sh
npm install
npm link
coding-container --help
```

`npm link` puts `coding-container` on your PATH. If you prefer not to link globally, run it with `node src/index.js ...` instead.

One time setup, creates your global config and SSH key and never overwrites existing files:

```sh
coding-container setup
```

## Quick start

```sh
coding-container create   # deploy this project
coding-container ssh      # connect, you land in /workspace
coding-container delete   # remove cluster resources (files stay safe on the NAS)
```

If you run `create` in a folder with no `config.yaml`, a minimal file is created for you. The project name comes from the folder name and the NodePort is the first free one in 30000 to 32767. Each project gets its own container and workspace. Projects that are already registered can be addressed from anywhere with `coding-container -p <name> deploy`.

In the app this is the Deploy button on the Dashboard or on a project page, the Terminal button on a project page, and the Remove action with its confirmation.

## Commands

Every `coding-container` command and its most useful flags.

| Command | What it does |
|---|---|
| `coding-container setup` | One time: create the global config plus Dockerfile plus SSH key pair, never overwrites |
| `coding-container create` | Deploy the project, the full pipeline, registers an SSH alias in `~/.ssh/config`. Global mode: deploys the shared image. Custom mode: builds plus pushes the project image first |
| `coding-container build` | Build the project custom image. For global mode projects use `system create` |
| `coding-container push` | Push the project custom image. For global mode projects use `system create` |
| `coding-container deploy` | Apply the Kubernetes manifests and wait for the rollout. In global mode this floats on the current cluster version |
| `coding-container ssh` | Open an SSH session, using `kubectl port-forward` |
| `coding-container list` | List the SSH connections registered in `~/.ssh/config`, ordered by host then port. Read only, no cluster needed |
| `coding-container list update` | Refresh the SSH aliases from the live cluster, using the Ready node IP and service nodePorts. Add `--dry-run` to preview |
| `coding-container key` | Show or generate the SSH key pair |
| `coding-container validate` | Load and validate the config without changing anything. Add `--manifest` to print the rendered manifests |
| `coding-container delete` | Remove deployment, service, Ingress, `<project>-ssh` ConfigMap and `<project>-env` Secret, and the SSH alias. Also available as `destroy` |
| `coding-container gc` | Delete old tags from the project custom image repo, custom mode only. For global mode use `system gc` |
| `coding-container projects list` | List registered projects from the shared registry, the same store the app uses. Any slug, name or id works with `-p/--project` |
| `coding-container system init` | One time: create the `coding-system` ConfigMap in `k8s.namespace` on a fresh cluster, global mode |
| `coding-container system get` | Show current, previous, maxEver and keep plus the resolved global image |
| `coding-container system list` | List the global repo registry tags, sorted newest first, read only |
| `coding-container system create` | Build plus push a new global version and repoint `current`, the only writer of the global image |
| `coding-container system rollback` | Repoint `current` to an existing version, default is `previous`. Swaps so `previous` becomes the old `current`. No build, push or delete |
| `coding-container system gc` | Delete old tags from the global repo. Keeps `current`, `previous`, all tags in use, and the ConfigMap keep count behind `current` |

Useful flags:

```sh
# Global, before the command
-c, --config <file>    use a different config, default is ./config.yaml if present
-p, --project <slug|name|id>  select a project from the shared registry, see 'projects list'
    --project-name <name>  override the project name
    --tag <tag>        pin the image tag, global mode uses semver, custom mode requires a tag if unset in config

# examples
coding-container projects list
coding-container --project esuyo-mapping deploy
coding-container --project "Esuyo Mapping" validate

# create
    --skip-build       reuse the locally built image
    --skip-push        reuse the already pushed image

# deploy
    --no-wait          do not block on the rollout

# ssh
     --direct           connect with node IP plus nodePort instead of port forward

# list update
     --dry-run          show what would change without writing anything

# key
    --force            create a new key pair, this rotates access

# delete
    --keep-secrets     keep the <project>-ssh ConfigMap and <project>-env Secret

# gc, custom mode, and system gc
    --keep <n>         how many versions behind the pin or current to keep, gc default is 5, system gc uses the ConfigMap keep value
    --dry-run          list what would be deleted without deleting anything

# system create
    --tag <tag>        the new version to publish, semver, above maxEver, not yet in the registry. Omit to bump maxEver patch by one

# system init
    --tag <tag>        the initial version, semver
    --keep <n>         the cleanup window to store in the ConfigMap, default is 10

# projects list
    --json           print the registry as JSON, with slug, name, id and file exists flag

# system rollback
     [tag]              version to roll back to, default is previous
```

## See also

- [Configuration](./configuration.md) for config layers and project overrides
- [Shared global image](./global-image.md) for image modes, publishing and pruning in detail
- [SSH and VS Code](./ssh-and-vscode.md) for key rotation and editor setup
