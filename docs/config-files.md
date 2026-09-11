# App config & setup files

> Status: proposal — the current `Dockerfile` `/entrypoint.sh` only recreates `/run/sshd`, republishes container env, and starts sshd. It does **not** symlink dotfiles yet.

Where to put the setup/config files that tools like opencode and other applications expect (e.g. `~/.config/opencode/`, `~/.gitconfig`, dotfiles). This is about **making those files survive** while still landing where the application looks for them.

## The core rule: only `/workspace` persists

The container's home directory (`/root/...`) lives on the **ephemeral** container filesystem. Any `coding-container create`/`deploy` that runs a different image version forces a new pod and a fresh container filesystem — in custom mode every build produces a new tag, and in global mode the pod is recreated whenever the team publishes a new global version (`system create`) or you pin another one. Anything you copy into `~` over SSH — for example `~/.config/opencode/` — is wiped on the next rebuild.

The only thing that survives across rebuilds is `/workspace`, because it is the NFS (NAS) mount (per-project subfolder). So:

> Any file that must persist has to live under `/workspace`.

The remaining question is simply how an application *finds* a file that it expects under `~/.config/...`.

## Recommended approach: the dotfiles pattern

1. **Keep the config files in the persistent workspace**, laid out relative to `$HOME`. Example:

   ```
   /workspace/.dotfiles/
   ├── .config/
   │   └── opencode/
   │       └── opencode.json
   └── .gitconfig
   ```

2. **At container start, the entrypoint would symlink each entry into place** (proposed, not yet implemented):

   ```
   /root/.config/opencode -> /workspace/.dotfiles/.config/opencode
   /root/.gitconfig       -> /workspace/.dotfiles/.gitconfig
   ```

   Use `ln -sfn`, and only create a link when the corresponding source exists under the dotfiles folder.

### Why this over the alternatives

- **Persists per-project** — it sits on the NAS subfolder, so it survives rebuilds and stays isolated per project.
- **Version-controllable** — `/workspace` is usually your project git checkout, so you can commit the dotfiles and keep them synced like any other source.
- **No image rebuild, no extra k8s objects** — unlike baking a `COPY` into the shared `Dockerfile` (one image is shared by *all* projects, so it cannot hold per-project config), and unlike a ConfigMap (1 MiB size limit, awkward for many or binary files).
- **Works for any app** — symlinks satisfy applications that do *not* honor environment overrides such as `XDG_CONFIG_HOME` or `OPENCODE_CONFIG`.

## Implementation note (proposed)

The change would be confined to `Dockerfile`'s `/entrypoint.sh`: add a small loop that links `/workspace/.dotfiles/*` into `$HOME`. The NFS mount is available before the entrypoint runs, so timing is not a concern, and the links are cheap to recreate on every boot. Make the dotfiles folder configurable, defaulting to `/workspace/.dotfiles`.

## Per-project vs. global

- **Per-project config** (opencode settings, app config that differs per project) → dotfiles pattern in `/workspace`.
- **Truly global config** (identical for every project, e.g. a base opencode auth/model) → belongs in the image (Dockerfile) or a global default, not in a per-project workspace.
