# Plan: Additional NFS volumes via config.yaml

> Status: plan only (no code changes).
> Source request: "For each volume, I need to be able to set the path on the nfs share, the folders will be subfolders of workspaces folder, I need to be able to set the path in the container, I need to be able mark them as readonly..." (request was cut off at "they", open questions in §6 cover the likely continuations).

## 1. Goal

Let a project mount extra NAS folders alongside `/workspace`, all backed by the
same NFS export (`nfs.server` + `nfs.basePath`, i.e. the `workspaces` folder),
configured purely in `config.yaml`:

```yaml
nfs:
  server: 10.0.0.5
  basePath: /workspaces
  # existing: subPath pins the /workspace folder (default: project name)

  volumes:                          # NEW: zero or more extra mounts
    - subPath: shared-datasets       # NAS folder: <basePath>/shared-datasets
      mountPath: /data               # path inside the coding container
      readOnly: true                 # container cannot write (default: false)
    - subPath: team-tools
      mountPath: /opt/team-tools
      readOnly: true
```

Each entry needs exactly the three knobs from the request:
1. `subPath`: folder on the NFS share, always a subfolder of `nfs.basePath`.
2. `mountPath`: absolute path in the container.
3. `readOnly`: when `true` the container can read but not write.

## 2. Design decisions

- **New key: `nfs.volumes` (array, default `[]`).** It lives under `nfs` because
  every entry reuses `nfs.server` / `nfs.basePath`, so no per-volume server/path,
  matching the request ("subfolders of workspaces folder"). This also keeps
  `deepMerge()` semantics simple (arrays replace wholesale, like `web.ports`
  and `k8s.sidecars`).
- **Reuse the single `workspace` NFS `Volume`.** The pod today declares one
  Volume (`nfs: { server, path: basePath }`) and mounts it at `/workspace` via
  `subPath`. Extra volumes become extra `volumeMounts` on the **same** Volume
  with different `subPath` values. No new `volumes[]` entries, one NFS mount
  per subPath, kubelet auto-creates each subfolder on first mount (same as the
  per-project folder today). Alternative (one `Volume` per entry with full
  `path: <basePath>/<subPath>`) is rejected: NFS servers refuse mounts of
  non-existent paths, so it would break for not-yet-created folders.
- **Only the `coding` container gets the mounts** (v1). `k8s.sidecars` already
  supports raw `volumeMounts: [{ name: workspace, subPath, mountPath }]`, so
  sidecars needing the same data can reference it manually. Auto-mounting into
  every sidecar is left as an opt-in follow-up (see §6).
- **No changes to build/push/ssh/delete/gc.** Pure `config.js` + `manifest.js`
  change; `deploy` picks it up via `fullManifest()` and `kubectl apply` is
  idempotent, so existing projects redeploy with no migration.

## 3. Changes, file by file

### 3.1 `src/config.js`
- `DEFAULTS.nfs`: add `volumes: []` with a comment block mirroring `web.ports`.
- `validate(cfg)`: new `nfs.volumes` block (after the existing `nfs.subPath`
  check), mirroring the style of the `web.ports` / `sidecars` validators:
  - must be an array; each entry must be a plain object.
  - `subPath`: required non-empty string; same rule as `nfs.subPath` (relative,
    no leading `/`, no empty or `..` segments
    (`seg === "" || seg === ".."`). Must not equal the resolved
    `workspaceSubPath(cfg)` (would double-mount `/workspace`).
  - `mountPath`: required non-empty string; must be absolute (`startsWith("/")`),
    normalized (no trailing `/` except root, no `..` segments). Must not equal
    `cfg.container.workdir` or `/root/.ssh/authorized_keys`, and must not be
    nested under another extra mount's `mountPath` (or vice versa) to keep
    kubelet mount order unambiguous. Decide: allow mounts *under* `/workspace`
    (e.g. `/workspace/data`)? Recommendation: reject, it shadows NFS-with-NFS
    and confuses git checkouts; document it.
  - `readOnly`: optional boolean, defaults to `false`; reject non-booleans
    (YAML `readOnly: "true"` string must fail, not coerce).
  - Uniqueness: duplicate `subPath` and duplicate `mountPath` each rejected.
  - Normalization: default missing `readOnly` to `false` in the validated object
    (or normalize in `manifest.js`, pick one place; `manifest.js` keeps config
    round-trippable, so prefer normalizing at render).

### 3.2 `src/utils/manifest.js`
- Add `extraVolumeMounts(cfg)` helper next to `webPorts()` / `workspaceSubPath()`:
  ```js
  // -> [{ name: "workspace", mountPath, subPath, readOnly }]
  ```
- `deploymentManifest()`: append its result to the `coding` container's
  `volumeMounts` after the `workspace` + `ssh-keys` entries. No new `volumes[]`
  entries (reuse `workspace`, per §2). `readOnly: true` passed through only when
  true (keeps dry-run diffs minimal for the common writable case).
- Nothing else changes: `configMapManifest`, `serviceManifest`,
  `ingressManifest`, `fullManifest`, `sidecarContainers` untouched.

### 3.3 Examples / templates / docs
- `config.yaml` (repo): commented `nfs.volumes` example (stays empty by default).
- `src/commands/setup.js` `renderTemplate()`: add a commented `volumes:` example
  under `nfs:` so new global configs document it (never an active default).
- `README.md`: extend the `nfs:` sample + a short "Extra NFS volumes" section
  next to "Pinning the NAS folder" (schema, readOnly semantics, redeploy to
  apply, kubelet-creates-folder note).
- `docs/architecture.md` §4: note the pod still declares two Volumes; extra
  mounts are additional `volumeMounts` on the `workspace` NFS volume.
- `docs/project-structure.md` / `docs/development.md`: one-line mention only if
  they enumerate config keys (keep diff small).

## 4. Validation & test plan (hermetic, `npm test`)

Repo convention: Node built-in `node:test`, no cluster/registry/network
(`test/gc.test.js` pattern). Add `test/volumes.test.mjs`:

- Manifest rendering: `deploymentManifest()` with 0/1/N `nfs.volumes` entries →
  assert `volumeMounts` contains `{ name: workspace, mountPath, subPath,
  readOnly }`, single `workspace` Volume, base `nfsBasePath` trailing-slash
  handling unchanged.
- `readOnly` default (`false` omitted) vs explicit `true`.
- Validation rejects (each a `throws` case via `loadConfig` with temp yamls or
  direct `validate` extraction): non-array, missing `subPath`/`mountPath`,
  absolute `subPath`, `..` segment, duplicate `subPath`/`mountPath`,
  `mountPath` equal to workdir or ssh-keys path, nested mountPaths,
  non-boolean `readOnly`, `subPath` colliding with the workspace subPath.
- Layering check: global + project merge replaces (not concatenates) the array,
  consistent with `deepMerge` + `web.ports`.

Manual end-to-end (needs cluster + NAS, not part of `npm test`):

```sh
# render without touching the cluster
node -e "import('./src/config.js').then(async ({loadConfig}) => { const {fullManifest} = await import('./src/utils/manifest.js'); process.stdout.write(fullManifest(loadConfig('config.yaml'), 'test-key')); })" | kubectl apply --dry-run=client --validate=false -f -
kubectl -n coding describe pod -l app=<project>   # mounts listed
kubectl -n coding exec deploy/<project> -- touch /data/should-fail  # readOnly check
```

## 5. Rollout / compatibility

- Backward compatible: default `[]` renders today's manifest byte-for-byte.
- Apply with `coding-container deploy` (or `create`); removal of an entry from
  the config + redeploy unmounts it. Data on the NAS is never deleted by this
  feature (`delete` already leaves NAS contents alone).
- Failure modes unchanged: missing `nfs.basePath` on the NAS →
  `ContainerCreating` (existing troubleshooting applies per subPath).

## 6. Open questions (request was truncated at "they")

1. **Sidecars:** should extra volumes auto-mount into `k8s.sidecars` too, or stay
   coding-only with manual `volumeMounts` (current plan)? If auto, what
   `mountPath`/`readOnly`: same as coding?
2. **Mounts under `/workspace`:** allow (e.g. `/workspace/data`) or reject to
   avoid shadowing the checkout?
3. **`they ...`:** if the cut-off sentence was e.g. "they should be created even
   if empty", already true via kubelet `subPath` creation; if "they should be
   writable by UID X" or "they need per-volume server", that changes §2 and
   needs a follow-up before implementation.
