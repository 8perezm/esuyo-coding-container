# SSH and VS Code

How SSH access works, how to rotate keys, and how to connect from VS Code.

`deploy`/`create` register an SSH alias `coding-<project>` in your `~/.ssh/config` (in a managed block the CLI owns; `delete` removes it).

Show all registered connections (read-only, works offline):

```sh
coding-container list
```

## Rotating your SSH key

```sh
coding-container key --force   # new key pair in ~/.config/coding-container/keys/
coding-container deploy        # push the new public key to the cluster
```

Note: the key pair is shared across projects, so after `--force` **every** deployed project needs a `deploy` to receive the new public key. Give a project its own key with `ssh.keyDir` in its config if you need independent rotation.

An SSH key pair is generated once and stored in your global config folder (`~/.config/coding-container/keys/` as dedicated `id_ed25519`, shared by all projects — never your `~/.ssh/id_*`); only the public key ever reaches the cluster. Key changes never require an image rebuild — just redeploy.

## Using VS Code (Remote - SSH)

To connect:

1. Install the **Remote - SSH** extension (`ms-vscode-remote.remote-ssh`).
2. `Ctrl+Shift+P` → **Remote-SSH: Connect to Host...** → pick `coding-<project>`.
3. Open folder `/workspace` — your persistent NAS-backed workspace.

The entry points at the k3s node's IP + the project's NodePort, so it works without any port-forward running. Pod host keys are ephemeral (regenerated on every image build), so the alias never stores them (`UserKnownHostsFile` points at the OS null device) — a rebuild can never leave a stale key behind to break VS Code with `Port forwarding is disabled`. `ssh`, `deploy`, and `delete` also remove any legacy `<project>-known_hosts` file left over from older versions.

## Keeping aliases correct on multi-node clusters

The alias stores one node's IP, captured at deploy time. A NodePort service is reachable through *any* node, so pods moving between nodes is harmless — but if that stored node goes away (or its IP changes) the alias goes stale. Refresh all aliases from the live cluster (re-points each at a currently-Ready node and resyncs the port from the live Service; no redeploy needed):

```sh
coding-container list update --dry-run   # preview what would change
coding-container list update             # rewrite stale HostName/Port values
```

Entries with no matching service (e.g. after `delete`) are left untouched with a warning.

You can also connect directly with the CLI (you land in `/workspace`, exit with `exit`; the SSH tunnel is cleaned up automatically):

```sh
coding-container ssh              # via kubectl port-forward (default)
coding-container ssh --direct     # via node IP + nodePort
```

## See also

- [SSH image paste](./ssh-image-paste.md) — Clipboard images into opencode over SSH

- [Configuration](./configuration.md) — `ssh.keyDir` and per-project keys
- [CLI reference](./cli-reference.md) — `ssh`, `list`, `key`, and `delete` flags
- [Troubleshooting](./troubleshooting.md) — host-key and port-forward fixes
