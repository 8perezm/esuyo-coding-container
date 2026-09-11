# Shared global image

How the team-shared image is versioned, published, rolled back, and cleaned up.

Projects run in one of two image modes, decided by the *project* config:

- **Global mode (the default)** — the project does not set `image.dockerfile`, `image.buildArgs` or `image.name`. Every such project runs one team-shared image, `image.registry/image.name:tag` (e.g. `registry.example.com/you/coding-container:v1.1.0`), versioned with human semver tags (`v1.0.0`, `v1.1.0`, ...). Deploys **float** on the version the cluster currently points at — no config edit is needed when a new version is published.
- **Custom mode** — the project sets any of `image.dockerfile` / `image.buildArgs` / `image.name`. The project builds + pushes its own image, `image.registry/coding-<project>` (or `image.name` if set), and `image.tag` is **required** (it pins the exact version the project deploys).

The cluster is the source of truth for the global image: a ConfigMap named `coding-system` in `k8s.namespace` (default `coding`) holds the state (all strings):

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
# Rollback swaps the pointers: current -> target, previous -> old current.
# maxEver never moves. The target must be semver and exist in the registry.

# Prune old versions:
coding-container system gc --dry-run
```

Notes:

- `system init` only creates the ConfigMap (no image is built); the first real image is published with `system create --tag <a version greater than the init tag>`, and that is what projects start floating on.
- After any `system create` or `rollback`, existing projects pick the new version up on their next `deploy`/`create` — no config changes, no re-builds on the projects' side.
- Global-mode tags must be semver; custom-mode tags are free-form but required.
- To run your project on a specific global version (instead of floating), pin it with `image.tag` in the project config or `--tag`.

## Garbage-collecting old images

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

Everything else is deleted, oldest first. Non-semver tags (e.g. `latest` or legacy timestamp tags) are never counted in the keep window — they are deleted unless in use or literally the pin/`current` (every `gc` run reports them separately, not just dry runs). Deleting a tag frees disk space only once the registry runs its own garbage collection — automatic on GitLab/Harbor, or `registry garbage-collect` on a bare Docker registry. Note that AWS ECR does not expose tag deletion through the standard registry API, so gc cannot prune ECR-hosted images.

## See also

- [Configuration](./configuration.md) — global vs. project config
- [CLI reference](./cli-reference.md) — full `system` and `gc` flags
- [Architecture](./architecture.md) — how the ConfigMap float and registry client work
