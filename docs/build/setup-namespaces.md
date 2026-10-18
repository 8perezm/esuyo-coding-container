# Plan: Namespace picker on Setup (personal vs shared namespaces)

> Status: plan only (no code changes).
> Source request: "On the setup page, I want to check which coding container namespaces already exist. ... Is it possible to tag the namespaces to have coding container so they're easily identifiable by our application?"
> Follow-up: no backward-compatibility constraint (single user). Label the
> existing `coding` namespace on the current cluster and require all
> coding-container namespaces to carry the label going forward.

## 1. Goal

Extend the Setup page so a user can:

1. See which coding-container namespaces already exist on the connected cluster.
2. Either pick an existing namespace (personal or team-shared) or type a new
   namespace name to create.
3. When an existing, previously-set-up namespace is picked, the Setup form
   inputs (namespace, registry, NFS server, NFS base path) are prefilled from
   that namespace's stored values.

Mental model (no enforcement in v1): one namespace per developer = private
area; one namespace shared by a team = shared float (`coding-system`
ConfigMap), shared NodePort space, shared NFS-backed workspaces. Sharing is a
naming convention, not access control.

Non-goals:

- No RBAC / NetworkPolicy / quota per namespace.
- No migration of existing workloads between namespaces.
- No change to the NFS/storage model.
- This plan itself performs no deletions: implementing it must not delete
  any namespace, deployment, pod, service, ConfigMap, or other workload
  currently in the cluster. Existing delete/gc functionality (`delete`,
  `gc`, `system gc`) stays exactly as-is and is out of scope.

## 2. Design decisions

- **Yes, namespaces can be tagged. Reuse the existing label
  `coding-container=true`.** Every workload object already carries
  `labels: { "coding-container": "true" }` (`src/utils/manifest.js`,
  `src/utils/system-config.js` `SYSTEM_CM_LABEL`). Namespaces accept labels
  the same way, so listing is one call:
  `kubectl get namespaces -l coding-container=true -o json`. Keep the exact
  same key/value so one selector covers namespaces, deployments, services,
  and the `coding-system` ConfigMap. All coding-container namespaces must
  carry this label — no unlabeled steady state.
- **New helper `ensureNamespace(ns, { setupValues })` labels + annotates.**
  Today `ensureNamespace()` in `src/commands/deploy.js` creates the namespace
  when missing and does nothing else. Extend it (shared by `deploy` and
  `system init`) to always run
  `kubectl label namespace <ns> coding-container=true --overwrite` after the
  create-or-keep check. Labeling is idempotent and unconditional: every
  deploy/init re-asserts the label.
- **Prefill values live in namespace annotations, not labels.** Labels are
  for selection; values need free-form strings (registry URLs, paths). Store
  three annotations written at setup/init time and read back for prefill:
  `coding-container.io/registry`, `coding-container.io/nfs-server`,
  `coding-container.io/nfs-base-path`. Annotations need no schema change to
  the `coding-system` ConfigMap and survive `system create/rollback/gc`
  (which only patch ConfigMap data). `setup --namespace` writes them via
  `kubectl annotate --overwrite`; the namespaces endpoint returns them as
  `setupValues` per namespace. Cross-machine prefill then works: developer B
  picks `team-alpha` and gets developer A's registry/NFS values in the form.
  Namespaces without annotations (only the pre-feature `coding` namespace,
  labeled once by hand per §5) prefill namespace-only until their next
  setup/deploy writes annotations.
- **One batched read endpoint: `GET /api/cluster/namespaces`.** Response:
  `{ ok, namespaces: [{ name, initialized, setupValues, createdAt }] }`.
  Implementation: one `kubectl get ns -l coding-container=true -o json`
  (only labeled namespaces are ever returned) plus one
  `kubectl get cm coding-system -A -o json` (namespaces on that list are
  `initialized`). Both degrade to empty on kubectl failure so Setup stays
  usable offline with a manual-input fallback. Share the short-TTL cluster
  cache (`getCachedCluster`) like nodes/ports/summary. No per-namespace
  fan-out, no unlabeled-namespace handling — anything without the label is
  not a coding-container namespace by definition.
- **Setup form gets a namespace picker with two modes.** Radio or segmented
  control: "Use existing" (dropdown of labeled namespaces, initialized
  ones badged, e.g. `team-alpha (ready)` vs `dev-miguel (empty)` — exact
  wording TBD) vs "Create new" (text input, DNS-1123 validation, same regex
  as `defaultNamespace()` in `src/utils/instance.js`). Selecting an existing
  entry fills registry/NFS/namespace inputs from its `setupValues`
  (falling back to the local `/api/global-config` values); switching back
  to "Create new" clears to blanks/defaults and never clobbers typed edits
  without an explicit reselect. GUI copy must follow the repo rule: no CLI
  commands, paths-as-commands, or flag names in user-visible text.
- **Existing-file semantics stay: setup never overwrites.** `setup` today
  keeps an existing `config.yaml` untouched. So the picker has two paths:
  (a) no global config yet → `setup` job creates it with the chosen/typed
  namespace + values (new `--namespace` flag, §3); (b) global config already
  exists → picking a different existing namespace offers a separate
  "Apply to global config" save via `PUT /api/global-config` (edits only
  the `k8s.namespace` + supplied fields), never a silent overwrite inside
  the setup job. The Setup page already has both the job path and the
  global-config editor path (System page); reuse them.
- **Non-destructive build.** While implementing this plan, do not delete
  any in-use namespace or workload: `ensureNamespace` only creates-if-missing
  then labels/annotates; the namespaces endpoint only runs `get`; setup only
  creates-or-keeps the global config and labels/annotates. Existing
  delete/gc behavior elsewhere (`delete`, `gc`, `system gc`) is unchanged.
- **CLI parity (behind the GUI): `setup --namespace <name>`:**
  `captureEnvironment()` prompts for it like registry/NFS; `renderTemplate()`
  writes `k8s.namespace` from it instead of the hardcoded `coding`. Keeps
  GUI jobs (`buildJobArgv` `setup` case) and terminal users consistent.

## 3. Changes, file by file (when implemented, not now)

- `src/commands/deploy.js` — extend `ensureNamespace(ns, { setupValues })`:
  keep create-if-missing, then `label ... coding-container=true --overwrite`,
  then `annotate --overwrite` the three `coding-container.io/*` keys when
  values are supplied. This helper itself never deletes; imported by
  `system.js` unchanged.
- `src/commands/setup.js` — add `namespace` through `captureEnvironment()`
  (prompt label "Coding namespace", example e.g. `coding` / `team-alpha`),
  `renderTemplate()` writes `k8s: namespace: <value>`; optional: annotate
  the cluster namespace when reachable (best effort, never fail setup when
  offline). New `PLACEHOLDERS.namespace = "coding"`.
- `src/utils/namespaces.js` (new, pure + thin kubectl edge) —
  `NAMESPACE_LABEL = "coding-container=true"`,
  `SETUP_ANNOTATIONS` map, `parseNamespaces(nsJson, cmJson)` pure function
  (marks `initialized`, extracts `setupValues`), plus
  `getNamespaces()` doing the two kubectl calls (namespaces call already
  label-filtered server-side). Pure part is unit-testable
  without a cluster.
- `src/index.js` — `setup` command gains
  `--namespace <name>` (validated with the `defaultNamespace()` regex).
- `web/server/server.js` — `GET /api/cluster/namespaces` (cached, degrades
  to `{ ok: false, namespaces: [], error }`); read-only `get` calls only.
  `buildJobArgv` `setup` case
  passes `--namespace` through; reuse `sortSshEntries`-style pure sorting
  (alphabetical by name).
- `web/client/src/pages/job-helpers.ts` — `SetupArgs` gains `namespace?`;
  `buildSetupArgs(registry, nfsServer, nfsBasePath, namespace?)` trims/drops
  blanks (existing test pattern in `job-helpers.test.mjs` extends directly).
- `web/client/src/pages/SetupPage.tsx` — namespace picker UI (§2) wired to
  `/api/cluster/namespaces` + `/api/global-config` prefill; manual-input
  fallback when the endpoint reports `ok: false`; `data-ref` attributes
  follow the existing `page-setup-*` convention for tests.
- `config.yaml` (repo) / `docs/configuration.md` / `docs/gui.md` — one-line
  note each: namespace is per-developer or per-team by convention; labeled
  with `coding-container=true`; prefill comes from namespace annotations.
- No changes to `manifest.js`, `validate`, `delete`, `gc`, `ssh`, workloads polling.

## 4. Validation plan (hermetic, `npm test`)

Repo convention: Node built-in `node:test`, no cluster/registry/network.
Bound long-running calls per `AGENTS.md` (one backend test file ~3–15s).

- `test/namespaces.test.mjs` (new): pure `parseNamespaces()` — `initialized`
  from the `coding-system` list, annotation extraction,
  missing-annotations fallback (namespace-only prefill), invalid JSON shapes.
  No unlabeled-namespace cases: the kubectl call is label-filtered, so
  unlabeled input is out of scope by construction. New namespace paths use
  `get`/`label`/`annotate` only (stub records argv to prove no `delete` on
  these paths; existing `delete`/`gc` flows are untouched).
- Extend `web/client/src/pages/job-helpers.test.mjs`: namespace trimmed,
  blank dropped, existing three-arg cases unchanged.
- Extend server tests (`web/server/server.test.mjs` pattern): `buildJobArgv`
  `setup` with/without namespace; `/api/cluster/namespaces` with a stub
  `KUBECTL_BIN` returning canned `get ns` + `get cm -A` JSON (offline case =
  kubectl throws → `ok: false`, empty list, no throw).
- `setup` template test (existing setup coverage pattern): rendered YAML
  contains the chosen namespace, defaults to `coding` on blank.
- Manual end-to-end (needs cluster, not part of `npm test`):
  `kubectl get ns -l coding-container=true`; create personal + team
  namespaces via the Setup page; repick each and confirm prefill; confirm
  `system init` in a new namespace labels it and shows `initialized`.

## 5. Rollout (no backward compatibility)

- Inventory first: list what is currently in use and keep it running —
  `kubectl get ns`, `kubectl get deploy,pods,svc -n coding` (plus any other
  coding-container namespaces) — before touching anything.
- One-time migration on the current cluster (single user, no version skew
  to protect): label the existing namespace(s) in place, then verify they
  show up in the picker. Labeling touches metadata only and deletes
  nothing:
  `kubectl label namespace coding coding-container=true --overwrite`, then
  `kubectl get ns -l coding-container=true` to confirm, then re-list
  workloads to prove they are untouched. Its setup-value
  annotations are backfilled on the next setup/deploy; until then it
  prefills namespace-only.
- Steady state: every coding-container namespace carries
  `coding-container=true`. `ensureNamespace` re-asserts the label on every
  deploy/init, so the invariant repairs itself. Unlabeled namespaces are
  not listed and not treated as coding-container namespaces.
- No ConfigMap schema change, no workload redeploy needed.
- Rollback risk: none — removing the endpoint/UI from the codebase returns
  to today's manual global-config editing and touches no cluster resources.

## 6. Open questions

1. **Personal default?** Pre-suggest `coding-<os-username>` when creating, or
   keep static `coding` default? Per-developer default reduces accidental
   sharing of one namespace.
2. **Share detection:** show per-namespace project count (from saved project
   configs pointing at it) to hint "2 projects share team-alpha"? Cheap
   (local registry scan) and helps the personal-vs-team choice.
3. **Annotation writes from setup when cluster is unreachable:** silent skip
   (current leaning) vs surface a warning prosing a later deploy will label.
4. **Should `system init` require a labeled namespace, or label implicitly?**
   Leaning: label implicitly via shared `ensureNamespace`, no extra flag.
