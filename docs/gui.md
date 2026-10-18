# Web GUI

What the browser admin interface covers, how it runs, and how its backend maps onto the CLI.

The GUI is a single-server web app: one backend process serves both the JSON API and the built frontend. It performs the same operations as the terminal workflow (deploying projects, publishing images, rotating keys) through pages and buttons, with every long operation running as a tracked job whose log streams back to the browser.

## Running it

Prerequisites: Node.js ≥ 18, plus the client dependencies installed once (`npm --prefix web/client install` — the client keeps its own lockfile).

```sh
copy .env.example .env   # Windows — then set ADMIN_EMAIL + ADMIN_PASSWORD
node web/dev.js          # development: API + live-reload frontend together
node web/kill-dev.js     # stop orphaned dev servers still holding the dev ports
```

Development addresses: the pages on `:3400`, the API on the `.env` `PORT` (default `3401`); the dev frontend proxies `/api` (including terminal sessions) to the API. Production is a single port:

```sh
npm --prefix web/client run build   # emit web/client/dist/
node web/server/server.js           # serve the API + the built pages (reads root .env)
```

Without a built client, `/` answers `{"message":"GUI not built"}`. Sign-in uses a single account stored as a hash in `auth.json` next to the projects registry (`AUTH_FILE` overrides; a legacy `web/.env` still fills in missing keys). The first launch migrates a legacy `ADMIN_EMAIL`/`ADMIN_PASSWORD` from the root `.env` into that file and removes the plaintext password line. When no account exists, the Sign in page becomes a Create your sign-in page on the computer where the app is running (`/register` works the same); over the network it explains that registration is not allowed remotely. Sessions last 12 hours via an `HttpOnly` cookie. The Profile page changes the password (minimum 8 characters), re-hashes it, and signs out other browsers; its Reset sign-in section tells where the credential file lives — deleting it while the app runs asks to create a new sign-in.

## Pages

- **Dashboard:** live per-project workload status (deployment health, pods, service ports, configured ports, image) plus cluster nodes and NodePort usage, with per-project deploy/remove shortcuts. Degrades gracefully when the cluster or metrics-server is unreachable.
- **Projects:** the shared registry (same store the terminal workflow uses). Add a project by name (a config path is assigned automatically), attach an existing config file, rename (managed configs move along), or remove the entry. Each project opens an editor (YAML with validation and manifest preview), a deploy panel, and a browser terminal.
- **Project terminal:** a full terminal in the browser, backed by a server-side session into the project's container (port-forward + shell channel with real terminal sizing, including resize support).
- **Images:** global vs. custom image repos, publishing new versions and pruning old tags as tracked jobs.
- **System:** the shared-image pointer (`current`/`previous`/`maxEver`/`keep`), the resolved global image, registry tags, and the global config editor.
- **SSH & Keys:** the registered connection aliases (same ordering as the terminal `list`), key rotation, and per-project key/image details.
- **Setup:** first-time global setup (registry, file server, workspace path) as a tracked job, plus the current global config. It lists existing coding areas (one per developer or one shared per team by convention, labeled `coding-container=true`) and prefills the form from each area's stored annotations, with manual entry when the cluster is unreachable.
- **Jobs:** history of every operation (latest 50, newest first) with live log output and exit status.
- **Profile:** signed-in account, password change, sign-out.

Appearance (dark/light) and the sign-in profile live in the header/sidebar; the Setup entry in the sidebar appears only when the global config is missing.

## How operations run

Short reads (config, validation, manifest preview, cluster state, key details) are synchronous API calls that import `src/*` directly and never change anything. Validation also accepts unsaved editor drafts and warns about NodePorts already held by other services or claimed by other projects' saved configs. Secret values are always redacted in API responses.

Anything that changes state runs as a **job**: the backend translates the request into the equivalent terminal invocation and spawns it (`node src/index.js ...`) with the full environment, capturing the trailing 200 KB of output. The Jobs page polls until the job reaches `done` or `error`. Supported operations: `setup`, `create`, `build`, `push`, `deploy`, `delete`, `gc`, `system-init`, `system-create`, `system-rollback`, `system-gc`, `list-update`, `key-rotate`. System-wide operations run against the default config when no project is selected.

## Configuration

Single environment file (repo-root `.env`):

| Key | Purpose | Default |
|---|---|---|
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | legacy first sign-in (migrated into the hashed credential file on startup, then ignored) | — |
| `AUTH_FILE` | credential file override (absolute, or relative to the repo root) | `auth.json` next to the projects registry |
| `PORT` | API (+ pages in production) port | `3401` in `.env.example` (`3401` code fallback) |
| `PROJECTS_FILE` | registry override (absolute, or relative to the repo root) | `projects.json` next to the global config |
| `ALLOWED_ORIGIN` | optional single-origin CORS for `/api/*` | — |

On startup the server migrates the legacy dev registry (`web/projects.json`) into the shared store once and seeds a starter project when the registry is empty (a personal copy under the global dir, never the repo template). The starter template is a realistic app + Postgres sidecar setup with allocated free NodePorts and clearly-marked placeholder hosts/passwords.

## See also

- [Architecture](./architecture.md): backend/frontend/terminal internals (§7–§10)
- [Desktop](./desktop.md): the installable wrapper around this GUI
- [Development Guide](./development.md): running the GUI from source
- [Configuration](./configuration.md): checkout identity and the projects registry
