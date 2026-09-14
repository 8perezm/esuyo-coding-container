# Project Structure

Directory layout of `esuyo-k8s-coding-container` and the role of each file.

```
esuyo-k8s-coding-container/
├── package.json            # ESM package, bin entry "coding-container" -> src/index.js
├── package-lock.json
├── config.yaml             # Project-specific config (project name, nodePort); layers over the global config
├── Dockerfile              # Packaged starting point: `setup` copies it to ~/.config/coding-container/; the build uses that personal copy
├── .gitignore              # Ignores .opencode/, node_modules/, keys/, *.pem
├── docs/                   # Developer documentation
├── test/                   # node:test suite (run with `npm test`); hermetic, no cluster/registry/network needed
└── src/
    ├── index.js            # CLI entrypoint: commander program, command wiring, global flags
    ├── config.js           # Config file resolution (cwd -> repo), layered merge (defaults -> global -> project -> CLI), path resolution, validation
    ├── commands/
    │   ├── setup.js        # one-time global setup: copies Dockerfile + .dockerignore, captures registry/NFS (flags > TTY prompt > placeholder), config template, key pair
    │   ├── build.js        # buildImage() (raw docker build) + build (guarded: custom mode + tag; global mode: use 'system create')
    │   ├── push.js         # pushImage() (raw docker push, login hint on failure) + push (same guards)
    │   ├── deploy.js       # tag float (resolveDeployTag) + SSH key + namespace + NodePort preflight + pull secret + manifest apply + rollout wait + SSH alias in ~/.ssh/config
    │   ├── create.js       # deploy pipeline: global mode floats on the shared image, custom mode builds + pushes the project image first
    │   ├── ssh.js          # port-forward (default, auto port fallback) or direct node; per-project host keys
      │   ├── delete.js       # delete deployment/service/ingress + <project>-ssh ConfigMap + <project>-env Secret (--keep-secrets) + remove SSH alias
      │   ├── validate.js     # load + validate the config, print a summary or the rendered k8s manifests (--manifest)
      │   ├── gc.js           # imageTag(), planGc() retention plan, gcTags() shared pruner, gc (project's custom repo, custom mode only)
      │   └── system.js       # the 'system' group: init/get/list/create/rollback/gc of the shared global image (ConfigMap 'coding-system')
    └── utils/
        ├── exec.js         # spawn helpers: exec (captured), run (streamed), runWithInput, start + dockerExec() (DOCKER_BIN override)
        ├── keys.js         # ed25519 key pair generation via ssh-keygen, public key reader
        ├── manifest.js     # ConfigMap/Deployment/Service/Ingress + <project>-env Secret renderers + web.ports normalization + k8s.sidecars pass-through (env-map conversion, nodePort stripping) + nfs.volumes mounts + multi-doc YAML
        ├── project.js      # project bootstrap: name from folder, free NodePort, minimal config.yaml, NodePort ownership lookup (deploy preflight)
        ├── registry.js     # pull-secret resolution (config option, docker creds, existing secrets)
        ├── registry-api.js # Docker Registry V2 client for gc: list/delete tags, Bearer/Basic auth, Link pagination
        ├── semver.js       # strict vX.Y.Z validation, numeric compare, semver/all-tag sorting
        ├── system-config.js# the coding-system ConfigMap: read (getSystemConfig), write (patchSystemConfig), validation, resolveDeployTag (the float), kubectlExec (KUBECTL_BIN override)
        └── ssh-config.js   # managed block in ~/.ssh/config: add/remove per-project Host alias
```

## Notes

- **Config is layered.** The project `config.yaml` (what a repo commits) overrides the global config at `~/.config/coding-container/config.yaml`, which overrides built-in defaults; CLI flags win over all of it. Every relative path in a layer (`dockerfile`, `context`, `keyDir`) resolves against that layer's own directory, so the CLI works from any working directory.
- **SSH material lives globally, not in the repo.** `~/.config/coding-container/keys/` holds the shared ed25519 key pair plus per-project `<project>-known_hosts` files; the first `deploy`/`create`/`ssh`/`key` invocation generates the pair. `coding-container key --force` rotates it (all deployed projects then need a `deploy`). A project can opt into its own key with `ssh.keyDir` in its config.
- **The build's Dockerfile lives globally too.** `setup` copies the repo's `Dockerfile` into `~/.config/coding-container/` (plus a `.dockerignore`), and the global config points there, so the build context is the global folder, never the repo, and the private keys stay out of it.
- **`src/utils/exec.js` is the only place that spawns processes.** Commands and utilities stay thin on top of `exec`/`run`/`runWithInput`/`start`.
- **`src/utils/manifest.js` owns all Kubernetes object shapes.** If you add a k8s resource (e.g. a PodDisruptionBudget), add a renderer there and include it in `fullManifest()`.
- **Tests run with `npm test` (Node's built-in `node:test`, no extra dependencies).** `test/gc.test.js`, `test/semver.test.js` and `test/system-config.test.js` are pure unit tests (retention logic `planGc`/`imageTag`, semver sorting, ConfigMap parsing + the float). `test/registry-api.test.mjs`, `test/cli-gc.test.mjs` and `test/cli-system.test.mjs` are hermetic integration tests: they start an in-process mock Docker Registry and stub `kubectl` (a `.js` script via `KUBECTL_BIN`) and `docker` (a `.js` script via `DOCKER_BIN`), so no cluster, real registry, real docker build or network is needed.
