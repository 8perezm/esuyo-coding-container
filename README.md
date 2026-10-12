![coding-container — Standardized, isolated coding environments.](./docs/intro-image.jpg)

# coding-container

> Ready-to-code containers on your Kubernetes cluster — per project, over SSH, with workspaces that survive restarts.

`coding-container` gives every project its own consistent coding environment on Kubernetes. One deploy puts an SSH-accessible container per project at your fingertips: you land in `/workspace`, backed by your NAS so work survives restarts. The default image is just a starting point (Ubuntu, Node.js, and common dev tools); the Dockerfile is yours to customize with any language or toolchain, plus optional sidecars for databases and queues.

Work your way: the terminal workflow, a browser admin UI (dashboard, project editor, terminal in the browser, job history), or the installable desktop app that wraps the same UI. All three share one project registry, so a project created in one place shows up in the others.

For private, internal Kubernetes clusters only. Do not expose to the public web. Every project opens NodePorts on all cluster nodes (SSH plus optional web/sidecar ports) and serves Ingress hosts without authentication or TLS by default. Only run this on a trusted internal network (homelab, LAN, or VPN-gated cluster) behind a firewall. See [Architecture](./docs/architecture.md#security-notes) for details.

## Features

- One deploy for a ready-to-code container, SSH in, and tear down when done
- Kubernetes-native: Deployment, Service, Ingress, ConfigMap, and Secret manifests applied with `kubectl`
- Persistent per-project workspace on your NAS, so files survive restarts
- Dedicated SSH key; VS Code Remote-SSH ready
- Optional browser access to dev servers and sidecars for databases and queues
- Shared team image with versioning, or a custom image per project. Bring your own Dockerfile for any language or toolchain
- Browser admin UI: dashboard with live workload status, project editor with validation, terminal in the browser, image publishing, and a job log for every operation
- Desktop app (Windows / macOS / Linux): the same UI in an installable window with encrypted sign-in and automatic updates
- Shared project registry, so the terminal, browser, and desktop views stay in sync

## Prerequisites

- A private, internal Kubernetes cluster (any CNCF-conformant distribution) with `kubectl` access. Do not use on a publicly exposed cluster
- Node.js >= 18, Docker, `kubectl` on `PATH`
- `docker login` to your container registry
- OpenSSH (`ssh`, `ssh-keygen`)
- Your NAS reachable from the cluster nodes
- For the browser UI / desktop app: a sign-in (email + password) configured in the checkout `.env` file

## Installation

Terminal workflow:

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

`npm link` puts `coding-container` on your PATH. Prefer not to link globally? Run it with `node src/index.js ...` instead.

One-time setup (creates your global config and SSH key, never overwrites):

```sh
coding-container setup
```

Browser UI (from source):

```sh
npm --prefix web/client install   # first time only
copy .env.example .env            # Windows (cp on macOS/Linux) — then set ADMIN_EMAIL + ADMIN_PASSWORD
node web/dev.js                   # pages on :3400, API on the .env PORT
```

Production build: `npm --prefix web/client run build`, then `node web/server/server.js` serves the pages and the API on one port. See [Web GUI](./docs/gui.md).

Desktop app: download an installer from the releases page, or build one from source (`npm --prefix web/client run build`, `npm --prefix electron install`, `npm --prefix electron run dist:win`). See [Desktop](./docs/desktop.md).

## Configuration

Two small YAML files drive everything: a global config for your environment (`~/.config/coding-container/config.yaml`) and a per-project `config.yaml` for what differs per project.

```yaml
project: my-project
k8s:
  nodePort: 30022
```

Each checkout also carries its own identity in a `.env` file (copied from `.env.example`): separate config folders, connection-alias prefixes, and namespaces for isolated dev/prod instances, plus the browser UI sign-in and port.

See [Configuration](./docs/configuration.md) for layering, multiple projects, the shared registry, and NAS folders.

## Quick Start

Terminal workflow:

```sh
coding-container create   # deploy this project
coding-container ssh      # connect, you land in /workspace
coding-container delete   # remove cluster resources (files stay safe on the NAS)
```

Working in another folder? `cd` there and run `create`: a minimal `config.yaml` is scaffolded automatically. Each project gets its own container and workspace. Registered projects can be addressed from anywhere (`coding-container -p <name> deploy`).

Browser UI: open the pages, sign in, and use the Dashboard for live status, Projects to add/edit/deploy (including a terminal per project), Images and System for the shared image, and Jobs for the log of every operation.

Desktop app: sign in once on first launch — the dashboard opens automatically from then on, with the sign-in kept in the OS keychain.

For everything else (web URLs, databases, image versions, all commands and flags), see [CLI reference](./docs/cli-reference.md) and the guides below.

## Troubleshooting

- **Missing registry or NAS settings?** Run `coding-container setup`.
- **Push auth error?** Run `docker login <your-registry>` first.
- **Pod stuck?** Usually NFS or image pull. See [Troubleshooting](./docs/troubleshooting.md).
- **Can't sign in to the browser UI?** Set `ADMIN_EMAIL` + `ADMIN_PASSWORD` in `.env` and restart the server.
- **Pages show "GUI not built"?** Run `npm --prefix web/client run build` first.

## License

MIT. See [LICENSE](./LICENSE).

## Developer Documentation

- [Web GUI](./docs/gui.md) — Pages, jobs, and server settings
- [Desktop app](./docs/desktop.md) — Installable Electron shell
- [Build & Deployment](./docs/build-and-deployment.md) — npm releases, GUI bundle, installers
- [Configuration](./docs/configuration.md) — Config layering, multiple projects, NAS volumes
- [Shared global image](./docs/global-image.md) — Team image versions, publishing, rollback, cleanup
- [Web access](./docs/web-access.md) — Browser access to dev servers via Traefik
- [Sidecars](./docs/sidecars.md) — Databases, queues, and other pod companions
- [CLI reference](./docs/cli-reference.md) — All commands and flags
- [SSH and VS Code](./docs/ssh-and-vscode.md) — Key rotation and Remote-SSH setup
- [SSH image paste](./docs/ssh-image-paste.md) — Clipboard images into opencode over SSH
- [Troubleshooting](./docs/troubleshooting.md) — Common failures and fixes
- [Architecture](./docs/architecture.md) — Tech stack and system design
- [Project Structure](./docs/project-structure.md) — Folder layout
- [Development Guide](./docs/development.md) — Local setup for contributors
- [App config & setup files](./docs/config-files.md) — Persisting tool configs via /workspace
- [Plan: Additional NFS volumes](./docs/build/additional-volumes.md) — Design history for extra volumes
- [Plan: Public prebuilt images](./docs/build/public-images.md) — Design history for public images
