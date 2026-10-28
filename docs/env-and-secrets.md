# Environment variables and secrets

Where to put plain values and secrets so each project gets what it needs and nothing private leaks.

## The short version

There are three separate places. They do different jobs.

* Checkout `.env` in the repo root, copied from `.env.example`. Holds checkout identity and server settings only. It does not set container variables.
* Project `config.yaml`, edited on the project page. Holds project variables under `k8s.env` for plain values and `k8s.secretEnv` for secrets.
* Shell environment on your machine. Holds secret values before you press Deploy. Referenced as `${NAME}` inside `config.yaml`.

You are already using the right pattern. Keep project values in `config.yaml`. Keep secrets in shell variables and reference them with `${NAME}`.

## 1. Checkout `.env` is identity plus server settings

Location: repo root `.env`, gitignored, copied from `.env.example`. Verified in `src/utils/instance.js` and `web/server/server.js`.

Use it for:

* `CODING_CONFIG_LEAF` for the global folder under `~/.config`
* `CODING_SSH_PREFIX` for alias names
* `CODING_NAMESPACE` for the default namespace
* `PORT`, `PROJECTS_FILE`, `AUTH_FILE`, `JOBS_FILE`, `ALLOWED_ORIGIN` for the app server
* Legacy `ADMIN_EMAIL` plus `ADMIN_PASSWORD` for first sign in on older checkouts

Do not use it for project variables. It never sets container env by itself. Real environment wins over `.env`, and `.env` never overwrites keys already in the environment.

Format is simple `KEY=VALUE` lines. Blank lines and `#` comments are ignored. One layer of single or double quotes is removed. Keep this file local. Never commit secrets here.

## 2. Project `config.yaml` holds project variables

Edit it on the project page with checks and manifest preview. Verified in `src/config.js`.

Use `k8s.env` for plain values. They land in the Deployment in plain text and stay visible to anyone who can read the Deployment. Good for non private settings.

```yaml
k8s:
  env:
    LOG_LEVEL: debug
    API_URL: https://api.example.com
```

Use `k8s.secretEnv` for anything private. It lands in a managed `<project>-env` Secret and the Deployment only carries a reference. The app redacts these values in pages, API responses, and manifest previews. Verified in `src/utils/manifest.js` and `web/server/server.js`.

```yaml
k8s:
  secretEnv:
    OPENAI_API_KEY: ${OPENAI_API_KEY}
    DB_PASSWORD: ${DB_PASSWORD}
```

Reference rules for `${NAME}`, verified in `src/utils/envsubst.js`:

* Braced form only. `${NAME}` expands. Bare `$NAME` stays as is.
* No defaults. `${NAME:-fallback}` is not supported.
* No escape. A literal `${...}` in these fields always tries to expand.
* Missing variable fails fast before anything is applied. Set it first, then press Deploy.

Only `k8s.env` and `k8s.secretEnv` expand this way. Hosts, paths, and ports never expand, so a surprise value cannot change routing or mounts.

## 3. Shell environment holds secrets before Deploy

Set the secret in the shell where you run the app or the job, then press Deploy on the project page. The value is read at deploy time and never needs to sit in a file.

Windows PowerShell, current window only:

```powershell
$env:OPENAI_API_KEY = "sk-live-abc123"
```

macOS or Linux, current shell only:

```sh
export OPENAI_API_KEY="sk-live-abc123"
```

Then open the project, confirm `config.yaml` references `${OPENAI_API_KEY}`, and press Deploy. Follow the Jobs page log. A missing variable stops early with a clear message naming what is not set.

## How to add a plain variable

1. Open the project page and the Configuration tab.
2. Add it under `k8s.env`.
3. Use Validate to check the shape.
4. Press Deploy. Confirm on the Dashboard and in the browser terminal with normal shell reads.

## How to add a secret

1. Set it in your shell as above. Close that shell and you will need to set it again. That is expected.
2. Open the project page and add it under `k8s.secretEnv` as `${NAME}`.
3. Use Manifest preview. The secret value shows as redacted.
4. Press Deploy. The value travels in the managed Secret. The Deployment only holds a reference.
5. To rotate, set the new shell value and press Deploy again. No image rebuild is needed.

## How secrets travel

* Saved under `k8s.secretEnv` in `config.yaml` as `${NAME}` placeholders, not values.
* Expanded on your machine at deploy time from shell variables.
* Stored in the cluster in the `<project>-env` Secret.
* Referenced from the container with secret references, so plain reads of the Deployment never show values.
* Redacted as `***REDACTED***` in config views and manifest previews.

## What to avoid

* Avoid putting secrets under `k8s.env`. That field stays plain text by design.
* Avoid committing real values in `config.yaml`. Commit the `${NAME}` shape and keep values in shell variables.
* Avoid reusing one secret name for unrelated uses. One shell name per purpose keeps rotation safe.
* Avoid placing project secrets in checkout `.env` as a habit. It can technically expand because that file loads into the local environment, but it mixes checkout identity with project data and makes rotation harder. Keep checkout `.env` for `CODING_*` plus server settings. Keep project secrets in shell variables.

## Troubleshooting

* **Deploy says a variable is not set.** The `${NAME}` has no matching shell variable in the app process. Set it and press Deploy again.
* **Secret shows as redacted everywhere.** That is correct. Pages and previews hide it on purpose. Check the Jobs log for success and test inside the container.
* **Value looks old after rotation.** Set the new shell value and press Deploy again so the Secret rolls. Pods restart on change.
* **Sign in or server settings look wrong.** That is checkout `.env`, not project secrets. Check `PORT`, `PROJECTS_FILE`, `AUTH_FILE`, and `CODING_*` in root `.env`. See [Configuration](./configuration.md).

## See also

* [Configuration](./configuration.md) for layering and checkout identity
* [Web GUI](./gui.md) for the project editor, manifest preview, Deploy, and Jobs
* [Terminal use](./cli-reference.md) for the optional shell path
