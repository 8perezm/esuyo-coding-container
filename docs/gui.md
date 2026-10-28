# Web GUI

What the browser app covers, how to run it, and what you can do on each page.

This is the primary way to use the system, along with the desktop app. Open the pages in a browser, sign in, and manage projects, images and keys from there. Every long task runs as a tracked job with live logs, so you can follow what happens and look back later on the Jobs page.

## Running it

You need Node.js 18 or newer. The first time, install the page assets:

```sh
npm --prefix web/client install
```

Then copy the environment template and start the app:

```sh
copy .env.example .env
node web/dev.js
```

On macOS or Linux use `cp .env.example .env` in place of `copy`. After that, open the pages and sign in.

For everyday use:

* Development address for pages: `http://localhost:3400`
* API address: the `PORT` value in your `.env` file, default is `3401`. The dev pages forward `/api` calls there for you, including the browser terminal.

For production or shared hosting, build the pages once and run the single port server:

```sh
npm --prefix web/client run build
node web/server/server.js
```

This serves the pages and the API together on the `.env` `PORT`. If the pages were never built, the root address answers `{"message":"GUI not built"}`. Build first, then reload.

To stop orphaned dev servers that still hold the dev ports:

```sh
node web/kill-dev.js
```

## Signing in

The first launch on a computer shows a create sign in form. This happens when no account exists yet. Fill in an email and a password of 8 characters or more. From then on you see the usual sign in form.

If you installed from a copy that still carries `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the root `.env`, the server moves those into a hashed credential file on first start and removes the plaintext password line. After that the credential file is the source of truth. You can change where it lives with `AUTH_FILE`. A legacy `web/.env` still fills in missing keys if you have one.

Browser sessions last 12 hours in a secure cookie. The desktop app stays signed in for 1 year while left open and slides forward. The Profile page lets you change your password and sign out other browsers. If you delete the credential file while the server runs, the pages ask you to create a new sign in.

On a network address, registration is closed on purpose. Only the computer that runs the server can create the first account. Other addresses see a message that points back to the local machine.

## Pages

* **Dashboard:** live status with resource totals for Memory and CPU across ready nodes, Projects running and Nodes ready counts, sortable and filterable project table with Age and CPU and Memory and Node plus pod squares, cluster Nodes table, and Used NodePorts table with SSH alias. Each project row has actions for deploy and remove plus Terminal when running. Status hover shows ports. Auto refresh follows the interval picker. If the cluster or metrics server is unreachable, the page still loads and says what is missing.
* **Projects:** the shared registry of projects with status filter and sort by name and status and namespace and NodePort. Add a project by name and the app assigns a config path for you, or attach an existing config file on import. Row actions are Create when stopped, Deploy, Edit, Terminal when running, and Delete workloads with confirmation. Remove entry on the edit page only clears the registry, while Delete workloads tears down cluster objects. Each project opens an editor with checks and a manifest preview, a deploy panel, and a browser terminal.
* **Project terminal:** a full terminal in the browser for the selected project. It opens a server side session into the container with correct sizing, including resize. You land in `/workspace`.
* **Images:** shared image versions with optional project override for another namespace or registry. Tabs are Versions with current and previous and max ever and keep plus resolved image plus Dockerfile path, Publish with optional tag that auto bumps patch when empty, Roll back to previous or a named tag, and Cleanup with keep plus dry run preview and run. Custom mode projects are refused for shared publish with a clear message.
* **System:** global config editor with validation, state summary with current and previous and max ever and keep, and System init with tag plus keep. Run init once per cluster, then publish from Images.
* **SSH and Keys:** registered connection aliases in a table with Refresh aliases button, a refresh card with Dry run checked by default plus Update alias list, project key details with fingerprint and public key, and Rotate key with confirmation. Redeploy after rotation so the new key reaches the pods.
* **Setup:** Coding area with Use existing versus Create new, stored values from namespace annotations, live workload fallback when annotations are missing, ready badge when the shared ConfigMap exists. One time environment setup for registry and file server and workspace path as a tracked job, plus the current global config. Manual entry works when the cluster is unreachable.
* **Jobs:** history of operations, newest first with 50 persisted across restarts, with live log output and exit status. Open an entry to see the full log. Running jobs show as interrupted after a restart.
* **Profile:** your account, password change, and sign out.

Look and feel and your sign in live in the header and sidebar. The Setup entry in the sidebar only appears when the global config is missing. Appearance controls live under Theme.

## How work runs

Short reads load straight away and never change anything. Examples are the merged config view with secrets redacted, validation of saved files or unsaved editor drafts, manifest preview, cluster state, key details, and the alias list. Validation also warns about NodePorts that are already held by other services or claimed by other saved projects.

Anything that changes state runs as a job. Press a button, the app starts a job, and the Jobs page follows it until it reaches done or error. Supported work includes setup, create with skip build and skip push, build, push, deploy with no wait, delete with keep secrets, project cleanup with keep and dry run, refresh of aliases with dry run, key rotation, and the system tasks for init, publish, roll back and cleanup. The job log keeps the last 200 KB of output. The last 50 jobs persist in `jobs.json` next to the registry. System wide tasks run with the default config when no project is selected.

## Configuration

One environment file in the repo root, `.env`:

| Key | Purpose | Default |
|---|---|---|
| `ADMIN_EMAIL` and `ADMIN_PASSWORD` | first sign in on older checkouts, moved once into the hashed credential file, then ignored | none |
| `AUTH_FILE` | credential file override, absolute or relative to the repo root | `auth.json` next to the projects registry |
| `JOBS_FILE` | jobs file override, absolute or relative to the repo root | `jobs.json` next to the projects registry |
| `PORT` | API port, and pages plus API port in production | `3401` in `.env.example`, same fallback in code |
| `PROJECTS_FILE` | registry override, absolute or relative to the repo root | `projects.json` next to the global config |
| `ALLOWED_ORIGIN` | optional single origin CORS for `/api` calls | none |

On startup the server moves the legacy dev registry at `web/projects.json` into the shared store once, and adds a starter project when the registry is empty. The starter is a personal copy under the global folder, never the repo template. It is a small realistic app plus Postgres sidecar with free NodePorts already picked and clearly marked placeholder hosts and passwords.

## See also

- [Desktop](./desktop.md) for the installable wrapper around these pages
- [Development Guide](./development.md) for running the GUI from source
- [Configuration](./configuration.md) for checkout identity and the projects registry
- [Terminal use](./cli-reference.md) for the optional shell path, same tasks from a prompt
