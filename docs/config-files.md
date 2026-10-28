# App config and setup files

Where to put the setup and config files that tools like opencode and other apps expect, for example `~/.config/opencode/`, `~/.gitconfig` and dotfiles. This is about making those files survive while still landing where the app looks for them.

> Status: proposal. The current `Dockerfile` entrypoint only recreates `/run/sshd`, republishes container env, and starts sshd. It does not link dotfiles yet.

## The core rule: only `/workspace` persists

The container home folder such as `/root` lives on the short lived container filesystem. Any Deploy that runs a different image version starts a new pod with a fresh home. In custom mode every build produces a new tag, and in global mode the pod is recreated whenever the team publishes a new shared version on the Images page or you pin another one. Anything you copy into home over SSH, for example `~/.config/opencode/`, is wiped on the next rebuild.

The only thing that survives rebuilds is `/workspace`, because it is the NFS NAS mount per project. So:

> Any file that must persist has to live under `/workspace`.

The remaining question is simply how an app finds a file that it expects under `~/.config`.

## Suggested approach: the dotfiles pattern

1. **Keep the config files in the persistent workspace**, laid out relative to home. Example:

    ```
    /workspace/.dotfiles/
    ├── .config/
    │   └── opencode/
    │       └── opencode.json
    └── .gitconfig
    ```

2. **At container start, the entrypoint would link each entry into place** (proposed, not yet built):

    ```
    /root/.config/opencode -> /workspace/.dotfiles/.config/opencode
    /root/.gitconfig       -> /workspace/.dotfiles/.gitconfig
    ```

    Use `ln -sfn`, and only create a link when the matching source exists under the dotfiles folder.

### Why this over the alternatives

* **Persists per project.** It sits on the NAS subfolder, so it survives rebuilds and stays isolated per project.
* **Works with version control.** `/workspace` is usually your project checkout, so you can commit the dotfiles and keep them synced like any other source.
* **No image rebuild, no extra Kubernetes objects.** Baking a `COPY` into the shared `Dockerfile` would affect every project because one image is shared by all, so it cannot hold project specific config. A ConfigMap has a 1 MiB size limit and feels awkward for many or binary files.
* **Works for any app.** Links satisfy apps that do not honor environment overrides such as `XDG_CONFIG_HOME` or `OPENCODE_CONFIG`.

## Notes for builders, proposed

The change would stay inside the `Dockerfile` entrypoint: add a small loop that links `/workspace/.dotfiles/*` into home. The NFS mount is available before the entrypoint runs, so timing is not a concern, and the links are cheap to recreate on every boot. Make the dotfiles folder configurable, defaulting to `/workspace/.dotfiles`.

## Project scope or shared scope

* **Project specific config** such as opencode settings and app config that differs per project belongs in the workspace dotfiles pattern.
* **Truly shared config** that is identical for every project, for example a base opencode auth or model, belongs in the image Dockerfile or a shared default, not in a single project workspace.

You edit these files from the browser terminal on the project page, from VS Code connected to the project, or from any SSH session. They live on the NAS, so they stay put across deploys.
