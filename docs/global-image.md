# Shared global image

How the team shared image is versioned, published, rolled back, and cleaned up.

You do all of this on the Images and System pages. There is no file to edit by hand. Pick a project if the page asks for context, press a button, and follow the job log.

Projects run in one of two image modes, decided by the project config:

* **Global mode, the default:** the project does not set `image.dockerfile`, `image.buildArgs` or `image.name`. Every such project runs one team shared image, `image.registry/image.name:tag`, for example `registry.example.com/you/coding-container:v1.1.0`, versioned with human tags such as `v1.0.0` and `v1.1.0`. Deploys float on the version the cluster currently points at, so no config edit is needed when a new version is published.
* **Custom mode:** the project sets any of `image.dockerfile`, `image.buildArgs` or `image.name`. The project builds and pushes its own image, `image.registry/coding-<project>` or `image.name` when set, and `image.tag` is required because it pins the exact version the project deploys.

The cluster is the source of truth for the global image. A ConfigMap named `coding-system` in `k8s.namespace`, default `coding`, holds the state. All values are strings:

| Key | Meaning |
|---|---|
| `current` | what global mode deploys float on |
| `previous` | last version `current` had before its last change, the default roll back target, may be absent |
| `maxEver` | highest version ever published, never moves backward, so a rolled back version can never be republished |
| `keep` | cleanup window, how many versions behind `current` to keep |

## Publish and manage versions in the app

Open the Images page:

* **Versions tab:** shows current, previous, max ever and keep, the resolved image, and the tag list newest first. Tags marked current or previous are easy to spot.
* **Publish tab:** type a tag or leave it empty to bump max ever patch by one, then press Publish new version. The app builds plus pushes the image, then repoints previous to current and current to the new tag. Custom mode projects are refused here with a clear message.
* **Roll back tab:** leave the tag empty to return to previous, or type a specific existing tag, then press Roll back. This only moves pointers. There is no build, push or delete. Max ever never moves and previous becomes the old current.
* **Cleanup tab:** press Preview with dry run on to see the plan, then Run GC to prune. The keep field is optional. Empty means use the server value shown on the page.

Open the System page for first time init and for the global config:

* **System init card:** run once per fresh cluster. Type the starting tag such as `v1.0.0` and a keep count, then press Initialize system. This only creates the ConfigMap. Publish the first real image from the Images page after that, with a tag above the init tag. That is what projects start floating on.
* **State summary:** the same current, previous, max ever and keep values.
* **Global configuration:** YAML editor for the shared settings with validation. Saving affects every project, so read the warning on the card.

Notes that help day to day:

* After publish or roll back, existing projects pick the new version up on their next Deploy, with no config changes and no rebuilds on the project side.
* Global mode tags use semver. Custom mode tags can be free form but are required.
* To run your project on a specific global version instead of floating, pin it with `image.tag` in the project editor.

## Cleaning up old images

Images accumulate tags over time, one per published version for the shared repo and one per build for custom repos. Both use the same safety rules.

On the Images page use the Cleanup tab for the shared repo. On a project page use its cleanup action for a custom repo.

A tag is never deleted when it is any of:

* **In use:** referenced by a `coding-container=true` deployment in the namespace, looked up live. When that lookup fails, cleanup refuses to delete anything.
* **The pin:** the project `image.tag` for custom repos, or the ConfigMap `current` for the shared repo.
* **`previous`:** the ConfigMap last version, shared repo only.
* **Within the keep window:** the newest keep semver versions behind the pin or current.

Everything else is deleted oldest first. Tags that are not semver, such as `latest` or older timestamp tags, never count in the keep window. They are deleted unless in use or exactly the pin or current. Every run reports them separately, including previews. Deleting a tag frees disk only once the registry runs its own cleanup, which is automatic on GitLab and Harbor, or `registry garbage-collect` on a plain Docker registry. Note that AWS ECR does not expose tag deletion through the standard registry API, so cleanup cannot prune ECR hosted images.

## See also

- [Configuration](./configuration.md) for global and project config
- [Web GUI](./gui.md) for Images, System and Jobs pages
- [Terminal use](./cli-reference.md) for the same tasks from a prompt
- [Architecture](./architecture.md) for how the ConfigMap float and registry client work
