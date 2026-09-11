# Esuyo coding-container

> Spin up a ready-to-code SSH container on your k3s cluster in one command.

`coding-container` gives every project its own consistent coding environment. One command deploys a container with Ubuntu 26.04, Node.js 22, [opencode](https://opencode.ai), [pi](https://pi.dev), [herdr](https://herdr.dev), turbo, Playwright, and common dev tools (plus pnpm/yarn via corepack and a Postgres client) to your k3s cluster. You SSH in and land in `/workspace` — a folder backed by your NAS, so your work survives restarts and stays separate per project.

## Features

- One command to deploy a ready-to-code container (`create`), SSH in (`ssh`), and tear down (`delete`)
- Persistent per-project workspace on your NAS — files survive restarts
- Generates a dedicated SSH key; VS Code Remote-SSH ready
- Optional browser access to dev servers and sidecars for databases and queues
- Shared team image with versioning, or a custom image per project

## Prerequisites

- Node.js >= 18, Docker, `kubectl` pointed at your k3s cluster
- `docker login` to your container registry
- OpenSSH (`ssh`, `ssh-keygen`)
- Your NAS reachable from the cluster nodes

## Installation

```sh
npm install
npm link
coding-container --help
```

`npm link` puts `coding-container` on your PATH. Prefer not to link globally? Run it with `node src/index.js ...` instead.

One-time setup (creates your global config and SSH key, never overwrites):

```sh
coding-container setup
```

## Configuration

Two small YAML files drive everything: a global config for your environment (`~/.config/coding-container/config.yaml`) and a per-project `config.yaml` for what differs per project.

```yaml
project: my-project
k8s:
  nodePort: 30022
```

See [Configuration](./docs/configuration.md) for layering, multiple projects, and NAS folders.

## Quick Start

```sh
coding-container create   # deploy this project
coding-container ssh      # connect — you land in /workspace
coding-container delete   # remove cluster resources (files stay safe on the NAS)
```

Working in another folder? `cd` there and run `create` — a minimal `config.yaml` is scaffolded automatically. Each project gets its own container and workspace.

For everything else — web URLs, databases, image versions, all commands and flags — see [CLI reference](./docs/cli-reference.md) and the guides below.

## Troubleshooting

- **Missing registry or NAS settings?** Run `coding-container setup`.
- **Push auth error?** Run `docker login <your-registry>` first.
- **Pod stuck?** Usually NFS or image pull — see [Troubleshooting](./docs/troubleshooting.md).

## License

MIT — see [LICENSE](./LICENSE).

## Developer Documentation

- [Configuration](./docs/configuration.md) — Config layering, multiple projects, NAS volumes
- [Shared global image](./docs/global-image.md) — Team image versions, publishing, rollback, cleanup
- [Web access](./docs/web-access.md) — Browser access to dev servers via Traefik
- [Sidecars](./docs/sidecars.md) — Databases, queues, and other pod companions
- [CLI reference](./docs/cli-reference.md) — All commands and flags
- [SSH and VS Code](./docs/ssh-and-vscode.md) — Key rotation and Remote-SSH setup
- [Troubleshooting](./docs/troubleshooting.md) — Common failures and fixes
- [Architecture](./docs/architecture.md) — Tech stack and system design
- [Project Structure](./docs/project-structure.md) — Folder layout
- [Development Guide](./docs/development.md) — Local setup for contributors
- [App config & setup files](./docs/config-files.md) — Persisting tool configs via /workspace
- [Plan: Additional NFS volumes](./docs/build/additional-volumes.md) — Design history for extra volumes
- [Plan: Public prebuilt images](./docs/build/public-images.md) — Design history for public images
