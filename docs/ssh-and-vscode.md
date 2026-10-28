# SSH and VS Code

How SSH access works, how to rotate keys, and how to connect from VS Code.

Deploying a project registers an SSH alias named `coding-<project>` in your `~/.ssh/config`, inside a managed block the app owns. Removing the project removes the alias. You can see the result any time on the SSH and Keys page.

## See your connections

Open the SSH and Keys page. The aliases table shows alias, host, port, user and identity file. Press Refresh aliases to reload the table. This view is read only and works offline.

The table uses the same ordering as SSH itself, by host then port.

## Rotate your SSH key

Your key pair is generated once and stored in your global config folder as a dedicated `id_ed25519` under `~/.config/coding-container/keys`. It is shared by all projects by design, never your `~/.ssh/id_*`. Only the public key ever reaches the cluster. Key changes never need an image rebuild. You deploy again so the new public key reaches the pods.

To rotate:

1. Open the SSH and Keys page and pick the project in the Project key card.
2. Press Rotate key and confirm. This starts a tracked job. You can follow it on the Jobs page.
3. When the job is done, open each deployed project and press Deploy so the new public key is distributed.

The key details stay visible on the page: private key path, public key path, resolved image, fingerprint, and the public key itself.

Note: the pair is shared across projects, so after a rotation every deployed project needs a Deploy to receive the new public key. Give a project its own key with `ssh.keyDir` in its config when you need independent rotation. Key rotation only changes access. Your files on the NAS stay untouched.

## Keep aliases correct on clusters with many nodes

The alias stores one node IP, captured at deploy time. A NodePort service is reachable through any node, so pods moving between nodes are harmless. But when that stored node goes away or its IP changes, the alias goes stale.

Fix it on the SSH and Keys page in the Refresh aliases card:

1. Keep Dry run checked to preview changes without applying them, then press Update alias list.
2. Open the job on the Jobs page to review the preview.
3. Uncheck Dry run and press Update alias list again to rewrite stale host and port values.

The app repoints each alias at a currently Ready node and resyncs the port from the live Service. No redeploy is needed. Entries with no matching service, for example after removal, are left untouched with a note in the log.

Nothing outside the managed block in `~/.ssh/config` is ever changed.

## Connect with VS Code

To connect with Remote SSH:

1. Install the Remote SSH extension, id `ms-vscode-remote.remote-ssh`.
2. Press `Ctrl+Shift+P` and pick Remote SSH Connect to Host, then pick `coding-<project>`.
3. Open folder `/workspace`, your persistent NAS backed workspace.

The entry points at the Kubernetes node IP plus the project NodePort, so it works with no port forward running. Pod host keys are fresh on every image build, so the alias never stores them. The app points `UserKnownHostsFile` at the OS null device for you, so a rebuild can never leave a stale key behind to break VS Code with `Port forwarding is disabled`. Legacy `<project>-known_hosts` files from older versions are removed the next time you deploy or open a terminal.

## Connect in a browser terminal

Each project page has a Terminal action that opens a full terminal in the browser. You land in `/workspace`. Exit with `exit` or by closing the tab. The server side tunnel is cleaned up for you.

This is the easiest way to run a quick shell without setting up VS Code or an SSH client.

## See also

- [SSH image paste](./ssh-image-paste.md) for clipboard images into opencode over SSH
- [Configuration](./configuration.md) for `ssh.keyDir` and project keys
- [Troubleshooting](./troubleshooting.md) for host key and port forward fixes
- [Terminal use](./cli-reference.md) for the same tasks from a prompt
