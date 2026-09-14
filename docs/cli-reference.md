# CLI reference

Every `coding-container` command and its most useful flags.

| Command | What it does |
|---|---|
| `coding-container setup` | One-time: create the global config + Dockerfile + SSH key pair (never overwrites) |
| `coding-container create` | Deploy the project (the full pipeline); registers an SSH alias in `~/.ssh/config`. Global mode: deploys the shared image (float). Custom mode: builds + pushes the project image first |
| `coding-container build` | Build the project's custom image (global-mode projects: use `system create`) |
| `coding-container push` | Push the project's custom image (global-mode projects: use `system create`) |
| `coding-container deploy` | Apply the k8s manifests and wait for the rollout (global mode: floats on the cluster's current version) |
| `coding-container ssh` | Open an SSH session (via `kubectl port-forward`) |
| `coding-container list` | List the SSH connections registered in `~/.ssh/config`, ordered by host then port (read-only, no cluster needed) |
| `coding-container list update` | Refresh the SSH aliases from the live cluster (Ready node IP + service nodePorts; `--dry-run` to preview) |
| `coding-container key` | Show or generate the SSH key pair |
| `coding-container validate` | Load and validate the config without changing anything (`--manifest` prints the rendered k8s manifests) |
| `coding-container delete` | Remove deployment, service, Ingress, `<project>-ssh` ConfigMap and `<project>-env` Secret, and the SSH alias (alias: `destroy`) |
| `coding-container gc` | Delete old tags from the project's custom image repo (custom mode only; global-mode projects: use `system gc`) |
| `coding-container system init` | One-time: create the `coding-system` ConfigMap in `k8s.namespace` on a fresh cluster (global mode) |
| `coding-container system get` | Show current/previous/maxEver/keep and the resolved global image |
| `coding-container system list` | List the global repo's registry tags, semver-sorted (read-only) |
| `coding-container system create` | Build + push a new global version and repoint `current` (the only writer of the global image) |
| `coding-container system rollback` | Repoint `current` to an existing version (default: `previous`; swaps so `previous` becomes the old `current`); no build/push/delete |
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

# list update
     --dry-run          show what would change without writing anything

# key
    --force            regenerate the key pair (rotate access)

# delete
    --keep-secrets     keep the <project>-ssh ConfigMap and <project>-env Secret

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

## See also

- [Configuration](./configuration.md): config layers and per-project overrides
- [Global image](./global-image.md): image modes, publishing, and pruning in detail
- [SSH and VS Code](./ssh-and-vscode.md): key rotation and editor setup
