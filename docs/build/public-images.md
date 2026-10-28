# Plan: Public prebuilt images (devcontainers base + SSH layer)

> Status: plan only (no code changes).
> Source request: users without a private container registry can't use the current
> build+push flow; proposal is an opt-in side folder that builds devcontainer-based
> images with SSH layered over, publishes to Docker Hub / GHCR, and is mentioned
> in the README. Nothing existing is replaced.

## 1. Goal

Give users with no private registry a pull-and-deploy path:

* New opt-in folder (proposed: `public-images/`) that defines 1+ image variants.
* Each variant: `FROM mcr.microsoft.com/devcontainers/...` + minimal SSH/workspace
  layer + the same toolchain as the main image (opencode, pi, herdr, turbo,
  optionally Playwright).
* Built images published to a public registry (GHCR primary, Docker Hub optional
  mirror) with semver tags.
* Users opt in purely via config (`image.registry`, `image.name`, `image.tag`);
  no app changes, no changes to root `Dockerfile`, `src`, or existing docs flow.

Non-goals:

* No replacement of root `Dockerfile` or the private-registry flow.
* No `devcontainer.json` / devcontainer-features compatibility.
* No change to NFS/storage model (prebuilt images do not remove the NAS
  requirement, see §6).

## 2. Design decisions

* **Additive only.** Setup copies only root `Dockerfile`. Build, push and deploy
  never look at `public-images/`. Existing hermetic tests (`npm test`) ignore it.
* **One subfolder per variant.** e.g. `public-images/base-ubuntu/`,
  `public-images/devcontainer-base/`, each self-contained with its own
  Dockerfile + README snippet. If Microsoft renames a base tag, only that
  variant breaks.
* **Reuse the SSH contract from the main image.** Same expectations so Deploy,
  Terminal, and VS Code Remote SSH keep working unchanged:
  sshd on 22, key-only auth, `authorized_keys` placeholder path, `/workspace`
  workdir, `/entrypoint.sh` recreating `/run/sshd` (tmpfs-safe).
  Decide root vs `vscode` user per variant (see §6); default recommendation is
  stay `root` for v1 to keep manifest/SSH identical.
* **Full vs slim is really about Playwright.** Size guidance (from current image):
  opencode, pi, herdr and turbo are small at tens of MB each, include by default
  for parity. Node plus build tools plus headers plus clients are medium at hundreds of
  MB, keep for dev parity. Playwright plus Chromium with deps is huge
  at about six hundred MB to more than a GB and dominates build time, pull time, and node disk. So:
  `full` is parity including Playwright, `slim` is identical minus Playwright
  (same as `INSTALL_PLAYWRIGHT=false` today). Both share most layers so
  hosting both costs little extra on the registry.
* **Minimal devcontainer base.** Prefer small ubuntu class minimal bases over
  `universal` at about 2 GB before our layers. Otherwise full plus universal stacks to 3 to 4 GB
  and hurts the slim story.
* **Registry: GHCR primary.** Free public hosting, no anonymous pull rate limits,
  Actions publishes with `GITHUB_TOKEN`. Docker Hub optional mirror for
  discoverability only. Tags follow the repo semver so
  the Images page Versions, Roll back and Cleanup mental model still applies if a team floats on
  the public image.
* **Many arch from day one.** Build `amd64` plus `arm64`; Kubernetes clusters are often mixed
  or Pi-based, devcontainer bases already are.

## 3. Changes, file by file (when implemented, not now)

* `public-images/README.md` (new): purpose, variant matrix, pull examples,
  disclaimer (public, versioned separately, trust the publisher), link back to
  main README.
* `public-images/<variant>/Dockerfile` (new, per variant): `FROM` devcontainer
  base + SSH layer + toolchain. Keep the `ARG`s that matter (`BASE_IMAGE`,
  `NODE_VERSION`, `EXTRA_APT_PACKAGES`, `EXTRA_NPM_PACKAGES`,
  `INSTALL_PLAYWRIGHT`) so full/slim is a build arg, not a fork.
* `public-images/.dockerignore` (new, per variant or shared): keep keys/secrets
  out of context, mirroring the root packaging gotcha.
* `.github/workflows/publish-public-images.yaml` (new): matrix over variants ×
  (full/slim), buildx multi-arch, push to `ghcr.io/<org>/coding-<variant>:vX.Y.Z`
  (+ `:latest` only if deliberately wanted; note the app has no `latest`
  fallback, explicit tag required). Sign with cosign / provenance.
* `README.md` (edit, small): one short "No registry? Use prebuilt community
  images → see `public-images/`" section next to Installation/Prerequisites.
  No rewrite of existing sections.
* Nothing in `src/`, root `Dockerfile`, `config.yaml`, `docs/architecture.md`,
  `docs/development.md`, `docs/project-structure.md` changes for v1, except
  possibly a one-line pointer. `ensurePullSecret` already handles public images
  (warn + proceed with no secret).

## 4. Validation plan (no cluster needed for most)

* `docker build` each variant locally (both `INSTALL_PLAYWRIGHT=true/false`).
* `docker run -d -p 2222:22` + `ssh -i <key> -p 2222 root@localhost` smoke test:
  lands in `/workspace`, `node --version`, `opencode --version`, `pi --version`,
  `herdr --version` present; slim variant asserts `playwright` absent.
* Render check without cluster: Manifest preview in the project editor with a
  project config pointing `image.registry` at the public repo. Manifest image
  ref resolves, no pull-secret failure blocks deploy (warning only).
* End-to-end (needs Kubernetes, once): Deploy plus Terminal plus redeploy against public tag;
  confirm `ImagePullBackOff` does not occur with no pull secret configured.
* Registry API sanity: Images page Versions plus Cleanup preview equivalents against GHCR
  (and Docker Hub if mirrored). V2 `tags/list` + auth flow both work; Docker
  Hub `library/` namespace quirks checked before promising Hub support.

## 5. Rollout / compatibility

* Backward compatible: default flow untouched; public images are purely an
  alternative `image.registry/name/tag` value.
* Removal risk: none. Deleting `public-images/` changes nothing about the app or its background tasks.
* Custom-mode users still need their own registry for their own builds; document
  that `public-images` covers the shared/global use case only.
* Disk/GC: public repos accumulate tags like private ones; document that shared
  cleanup on the Images page applies if a team shares the public stream.

## 6. Open questions

1. **Scope of v1:** full-parity only, or full + slim from the start? Recommendation:
   both via one Dockerfile + build arg (see §2).
2. **User model:** stay `root` (zero manifest/SSH change) or adopt devcontainer
   `vscode` user (requires `ssh.user`, `authorized_keys` path, `/workspace`
   ownership changes)? Recommendation: `root` for v1.
3. **Registry:** GHCR only, or GHCR + Docker Hub mirror? Recommendation: GHCR
   primary, add Hub mirror only on demand.
4. **Slim depth:** cut only Playwright, or also compile headers (`build-essential`,
   `*-dev`) for a truly minimal shell? Recommendation: cut only Playwright to
   keep `npm install` of native modules working.
5. **NFS remains required.** Prebuilt images remove Docker + registry from
   prerequisites but pods still need `nfs.server`/`nfs.basePath`. Is an
   `emptyDir`/`hostPath`/PVC fallback in scope for no-NAS users, or explicitly
   out of scope for this side project?
6. **Folder name:** `public-images/` vs `community-images/` vs `prebuilt/`,
   pick one before writing the README pointer.
