# Docker-local coding containers — discussion notes

Date: 2026-10-07
Status: pre-implementation, pondering
Source: conversation between maintainer and discuss agent, saved for further thought

## 1. Original idea

> Would it be possible to expand the functionality of this application to run coding containers in Docker? It would hopefully avoid the need of having to use a container registry. Would it be possible without affecting any of the existing functionality?

Short answer agreed on: yes, additive, no break to K8s.

Why the registry exists today:

- `src/config.js: validate()` + `imageRef()` require `image.registry` and a tag.
- `src/commands/build.js` tags `<registry>/<name>:<tag>`, `src/commands/push.js` pushes.
- `src/commands/deploy.js` tells cluster nodes to pull that ref, with `ensurePullSecret()` (`src/utils/registry.js`).

Docker-local never leaves the daemon that built it, so a local tag
(e.g. `coding-<project>:<tag>`) suffices. No push, no pull-secret, no registry.

## 2. Clarifications agreed

1. Target is localhost Docker only for now. Docker hosts over SSH deemed too difficult.
2. Same commands (`create / deploy / ssh / delete / key / validate`) branch internally, no separate `docker-*` commands.
3. `/workspace` in Docker mode is a local bind-mount (not NFS).
4. Motivation: encourage adoption; K8s scares many people. Docker-local is the
   "just try it on your laptop" path; K8s remains the "team / homelab" path.
   Same Dockerfile, same `/workspace` convention, same key-based SSH => on-ramp
   from local to cluster later.

## 3. Non-breaking shape (proposed)

- Add top-level `provider: k8s | docker`, default `k8s`. Every existing config
  keeps working byte-for-byte.
- Settable globally (`~/.config/coding-container/config.yaml`), overridable
  per-project. A K8s teammate and a Docker-local newcomer can share a repo with
  different global configs.
- `loadConfig()` unchanged; `validate()` conditional:
  - K8s: still requires `registry + nfs.server/basePath`.
  - Docker: requires workspace host dir + host ports, ignores K8s-only fields.
- `setup` in Docker mode skips registry/NFS prompts (Dockerfile + keys + workspace root).
- Command branching:
  - `create / deploy`: Docker = `docker build` (local tag, no push) + `docker run -d`
    with `-p` for SSH + web ports, `-v` for bind, `-e` for `env/secretEnv`.
  - `ssh`: Docker = direct `ssh -p <hostPort> root@127.0.0.1`, no
    `kubectl port-forward` (`src/commands/ssh.js`). Keep null-device
    `UserKnownHostsFile` handling for ephemeral host keys.
  - `delete`: Docker = `docker rm -f coding-<project>`.
  - `key / validate`: work for both.
  - `system *`, `gc`, `list update`: K8s concepts, fail fast in Docker mode with
    "not applicable, here's the Docker equivalent", same pattern as `build` guard
    in global mode (`src/commands/build.js`).
- Reuse `buildImage()`, `ensureKeyPair()`, config layering. Keep Docker path thin.
- Dockerfile needs no change (exposes 22, sshd, `/workspace`).

What maps cleanly vs not:

- Clean: `image.buildArgs`, `k8s.env / secretEnv` -> `--env`, `container.workdir/localPort`,
  SSH key + VS Code Remote-SSH alias in `~/.ssh/config`.
- Needs decision / deferred to post-MVP:
  - Persistence: bind-mount vs named volume. Agreed: bind-mount (see §4).
  - `web.ports` -> plain `-p`, no Traefik/Ingress.
  - `sidecars` -> extra `docker run --network container:...` or Compose. MVP: warn-and-ignore or reject.
  - `nfs.volumes` -> extra `-v`. MVP: warn-and-ignore or reject.
  - `system create/rollback/gc` global-image float via `coding-system` ConfigMap has
    no local meaning. Docker uses per-project local tags. `gc` => `docker image prune / rmi`.
  - `NodePort`, `namespace`, `ingress.className`, `imagePullSecret` ignored in Docker mode.

Alternative ruled out: if goal were only "no remote registry" but staying on K8s,
`k3s ctr image import` / in-cluster registry (`zot`, `registry:2`) already removes
the external registry. Docker mode is about "no cluster at all".

Trade-off: two runtimes to maintain (networking, volumes, sidecars, docs/tests diverge).
Mitigate by keeping Docker MVP minimal.

## 4. Workspace = "where I ran it"

Request: `/workspace` local mount from wherever the command was run.

Agreed: yes, and it's the most natural Docker default (`docker run -v .:/workspace`,
devcontainer-like).

Nuance: "wherever" must be stable. `process.cwd()` at every command is ambiguous
(mount fixed at `create`, but later `ssh` from another folder — old or new?).

Refinement agreed in discussion:

- Default workspace = folder containing the resolved project `config.yaml`.
- In practice identical to "where I ran it" because `create` scaffolds `config.yaml`
  in cwd when missing (`ensureProjectConfig()`, `src/utils/project.js`) and
  `resolveDefaultConfigPath()` prefers `./config.yaml`.
- Stable for later `ssh` / `deploy -c /path/to/config.yaml` from elsewhere.

Trade-offs noted:

- Good: `delete` stays safe like K8s (container removed, host files remain).
  Each folder gets own container `coding-<project>`.
- Watch: whole-cwd mount includes `config.yaml`, `.git`, `node_modules` — usually desired,
  but Linux root-owned-files issue (container SSH as root). Decide early: document vs `user:` story.
- Guardrail: `create` in `~` would mount entire home. Echo `workspace: <abs path>` and
  consider "mounting 40GB, continue?" confirmation.
- Win/Mac: Docker Desktop path translation / WSL / drive sharing. Resolve to absolute
  host path once at `create`, reuse.

## 5. Path in config.yaml, config can live anywhere

Request: put the path in `config.yaml`, then `config.yaml` can be stored anywhere.

Agreed: yes, consistent with existing `withPaths()` in `src/config.js`
(`dockerfile`, `context`, `keyDir` relative to that layer's own dir).
So `docker.workspace` relative = relative to config file, absolute = as-given.
Enables `~/.config/coding-container/projects/api.yaml -> C:\work\my-api`.

Decision: make it optional, not required.

- Required: friction for newcomers (the audience we're winning over), plus absolute
  host paths in committed project `config.yaml` leak layout and break teammates
  on different machines/OS.
- Optional with smart default (§4): unset => config dir; set => explicit override
  for advanced / central-config-store use.

Details for planning:

- Layer placement: project config is versioned/portable; global is machine-local.
  Workspace path is machine-specific => either needs `${HOME}/${VAR}` expansion
  (today only `k8s.env/secretEnv` expand via `expandEnvMap`, `src/utils/envsubst.js`)
  or lives as per-project entry in global file.
- Validation: exists, is-directory, refuse `/`, `C:\Windows`, etc.

## 6. `.coding-container/` folder convention (latest proposal)

Request:

> The config file would need to be stored inside the project repo in .coding-container
> folder, similarly to devcontainers then the application would bind the parent folder.
> Or the path can be added to the config.yaml and the config.yaml can be stored
> somewhere else.

Agreed direction: support both. A = onboarding path, B = power-user path.

- Option A: `<repo>/.coding-container/config.yaml` (committed, like
  `.devcontainer/devcontainer.json`), workspace implicitly parent (`<repo>`), no path to edit.
  Zero paths, clean root, familiar to devcontainer users.
- Option B: config anywhere + explicit `docker.workspace`. For central store,
  monorepo multi-workspace, or paths you don't want in git.

### Issues mentioned in last response — must resolve before implementing

1. Discovery order without breaking K8s.
   Today: `-c flag -> ./config.yaml -> repo's own config.yaml`, `create` scaffolds
   `./config.yaml` (`src/utils/project.js`, `src/config.js:resolveDefaultConfigPath`).
   Extension (not replacement): `-c flag -> ./config.yaml (legacy, keep forever) ->`
   `./.coding-container/config.yaml -> upward walk?`
   Upward walk (run from `my-app/src/` finding `my-app/.coding-container/config.yaml`)
   is new devcontainer-like behavior. Needs deliberate yes/no.

2. "Bind the parent" precise rule.
   Relative paths resolve against config file's dir, so `.coding-container/config.yaml`
   + `docker.workspace: ..` falls out naturally. Open: default when unset — "config dir"
   (would wrongly bind `.coding-container` itself) vs magic "parent when in dot-folder,
   else config dir"? Preference from discussion: keep rule dumb (default = config dir)
   and have scaffolder write explicit `..` for dot-layout so file stays readable.

3. K8s consistency.
   K8s ignores workspace path but should accept same config locations, else same repo
   has two layouts per provider and Docker->K8s migration confuses.

4. Scaffolder ambiguity.
   Existing users have `./config.yaml`; new Docker projects get
   `.coding-container/config.yaml`? Resolver must check both; scaffolder must pick by
   provider. Avoid surprising existing K8s users.

5. Scope of `.coding-container/`.
   Just `config.yaml`, or reserve for future Dockerfile overrides / setup scripts
   devcontainer-style? If it may grow, reserve name now. See `docs/project-structure.md`:
   Dockerfile today lives globally (copied by `setup`), build context is global folder.
   For Docker-local newcomers a alongside-code Dockerfile may be more discoverable,
   but breaks shared-team-image model. Decide: config-only for now.

6. Validation guards for binds.
   Unlike NFS `subPath` (name check for `..`/leading `/`, `src/config.js:validate`,
   `src/utils/manifest.js:workspaceSubPath`), host bind needs exists/is-dir,
   not `/` or system dirs, plus size warning.

7. Cross-cutting edge cases.
   Root-owned files, Desktop path translation, port collisions (reuse `ssh.js`
   free-port fallback idea), container-name idempotency (`coding-<project>` exists
   => reuse/recreate like `kubectl apply` idempotency in `src/commands/deploy.js`).

## 7. Suggested MVP boundary (for pondering, not yet approved)

Additive provider, K8s default. Docker-local MVP: build + run + ssh + rm, bind-mount,
`-p` web ports, `-e` env, SSH alias. Warn-and-ignore or reject `sidecars`,
`nfs.volumes`, Ingress/NodePort/namespace/pull-secret. No `system` float.
Document root-ownership + Desktop caveats. Keep tests hermetic like existing
`DOCKER_BIN` / `KUBECTL_BIN` stub pattern (`docs/architecture.md`, `docs/project-structure.md`).

## 8. Open questions

- Workspace default root if not config-dir: `~/workspaces/<project>` vs `./.workspace`
  vs config-dir/parent? Lean: config-dir / parent, overridable.
- `list`: show Docker containers alongside K8s aliases, or K8s-only for MVP?
- `.coding-container/`: config-only or future extras?
- Central config store vs checked-in-per-repo: which is primary for Option B?
- File ownership story for Linux binds?
- Should `validate --manifest` print `docker run` equivalent in Docker mode?
