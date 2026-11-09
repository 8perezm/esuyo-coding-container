# Rootless coding containers

Run a project's coding container as a non-root user, with no Linux capabilities and no way to regain root. Rootless is opt-in per project with `container.root: false`: projects without it keep the historical root behavior (`root: true` is the default).

This is container-level hardening. The pod still shares the host user namespace, because the workspace is NFS and Linux NFS does not support the idmapped mounts that Kubernetes user namespaces require. Rootless reduces what a compromised or misbehaving tool can do inside the container and on mounted files; it does not replace cluster isolation.

## What changes

| | Root mode (default) | Rootless mode |
|---|---|---|
| Container user | `root` | `ubuntu` (UID/GID 1000 by default) |
| SSH user and port | `root`, 22 | follows `container.user`, 2222 |
| Public key mount | `/root/.ssh/authorized_keys` | `/home/ubuntu/.ssh/authorized_keys` |
| Security context | none | `runAsNonRoot`, `runAsUser`, `runAsGroup`, no privilege escalation, all capabilities dropped, `RuntimeDefault` seccomp |
| Workspace | NFS folder writable as root | NFS folder writable by the non-root UID |

The external SSH NodePort does not change. Only the container port moves to 2222, because a non-root process cannot bind port 22 and the app grants no capabilities.

Sidecars are not changed by this mode. Their own `securityContext` still applies, and the rootless user only controls the coding container.

## Enable it

Open the project in the app, edit the Configuration tab, and set the simple switch:

```yaml
project: my-api

container:
  root: false
```

That is enough for the shared image: the app runs the container as `ubuntu` (UID/GID 1000), fills in `user: ubuntu`, `gid: 1000`, `home: /home/ubuntu`, `ssh.user: ubuntu` and `ssh.port: 2222`. `root: true` (the default) keeps the historical root behavior, and projects without the switch are untouched.

The `container.user`/`uid`/`gid`/`home` fields stay as the advanced path for images or NAS shares that need a different UID. Set them alongside `root: false` and an explicit value always wins:

```yaml
container:
  root: false
  user: alice
  uid: 2001
  gid: 2001
  home: /home/alice
```

Conflicting values fail fast instead of silently flipping modes (`root: true` with a non-zero `uid`, or `root: false` with `uid: 0`). Old configs that set a non-zero `container.uid` without the switch keep working and read back as `root: false`. Set the fields explicitly when your image uses a different user or the NAS needs a different UID.

Deploy the project. The app renders the security context, moves the key mount into the user home, and starts the non-root SSH server on 2222.

## The image

The shared image contains the non-root user and runs both modes:

- The non-root user is selected with the `APP_USER`, `APP_UID` and `APP_GID` build args. The default is the base image's `ubuntu` user (UID/GID 1000).
- opencode, pi, herdr and the npm prefix are prepared under the user's home (`/home/ubuntu` by default), not only `/root`. The image sets npm's global prefix to `<home>/.npm-global`, so runtime `npm install -g` works without root.
- The entrypoint checks its effective UID. As root it starts the historical sshd on 22. As a non-root user it starts sshd on 2222 with host keys, a pid file and a config under that user's home, using `UsePAM no` so it does not need root.

The defaults live in the global config `image.buildArgs`:

```yaml
image:
  buildArgs:
    APP_USER: "ubuntu"
    APP_UID: "1000"
    APP_GID: "1000"
```

If your NAS maps a different UID, change all three build args and the project's `container.user`/`uid`/`gid`/`home` together, then publish a new shared image. The shared image has one non-root user, so all rootless projects that use it share that UID. A project that needs its own UID needs a custom image.

A custom image can be rootless too, but it must:

- contain the user named in `container.user`, with the home from `container.home`;
- run an SSH server as that same user on the configured `ssh.port` (2222 or higher);
- read `authorized_keys` from `<container.home>/.ssh/authorized_keys`;
- be able to start with no capabilities and no privilege escalation.

The shared image's `entrypoint.sh` is the reference implementation.

## NFS workspace

The container runs as UID 1000 (or your chosen UID), so the NFS server must let that UID write the project folder. `fsGroup` is ignored for NFS, so it cannot fix ownership.

The recommended setup is a dedicated export for rootless projects with all clients mapped to the container UID. For example, on a Linux NFS server:

```text
/srv/rootless-workspaces *(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)
```

Point each rootless project at that export with a project-level override, leaving root projects on the existing export:

```yaml
nfs:
  server: 10.0.0.5
  basePath: /srv/rootless-workspaces
```

New project folders are created by the kubelet as the mapped UID, so they are writable on first mount. Existing folders created under root squash are still owned by the old mapped user; give them to the new UID once on the NAS, or start those projects on fresh subfolders.

If you keep one export for both root and rootless projects, all-squash affects root projects and sidecars too. In that case pre-create each rootless project folder and `chown` it to the container UID instead.

## Verify

1. Deploy the project and open Terminal. `id` should show `uid=1000` (or your configured UID), not `uid=0`.
2. Create a file in `/workspace`, then confirm it is owned by the configured UID on the NAS.
3. Connect with the `coding-<project>` SSH alias and with VS Code Remote SSH. The alias still uses the project NodePort; the container listens on 2222.
4. Open the Jobs log if the pod does not become ready. The entrypoint prints a clear error when `/workspace` is not writable by the configured UID.

## Limits

- **No `sudo` or runtime `apt install`.** Rootless pods cannot install system packages. Add packages to the image through a custom project Dockerfile and rebuild.
- **No host user namespace.** `hostUsers: false` is not compatible with NFS-backed volumes, so it is not offered. The container is non-root, but the pod still uses the host user namespace.
- **Existing workspaces need a one-time ownership fix.** Files written by the old root pod are not automatically writable by the new UID.
- **Sidecars share the project export.** All-squash maps their UID too. Give a rootless project its own export when a database sidecar uses the same share with a different UID.
- **Image rollback boundary.** Rootless projects need an image that contains the non-root user and the dual-mode entrypoint. Rolling the shared image back to an older version breaks them; pin or keep a version that includes this support.

## See also

- [Configuration](./configuration.md) for the `container` fields and config layering
- [Sidecars](./sidecars.md) for sidecar security contexts and shared volumes
- [Troubleshooting](./troubleshooting.md) for workspace permission and SSH failures
