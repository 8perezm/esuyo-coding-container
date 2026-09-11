import { exec } from "../utils/exec.js";
import { listTags, deleteTag } from "../utils/registry-api.js";
import { allTagsSortAsc, isSemver, semverSortAsc } from "../utils/semver.js";
import { kubectlExec } from "../utils/system-config.js";

/**
 * The tag part of a full image reference; "latest" when untagged.
 */
export function imageTag(image) {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) return image.slice(lastColon + 1);
  return "latest";
}

/**
 * Retention plan for one repo (global or coding-<project>):
 *   keep = {pinned, previous (global repos only), all in-use tags,
 *           the `keep` semver predecessors of pinned (closest first)}
 *   toDelete = everything else, oldest first.
 * Non-semver tags (legacy timestamp tags) are never counted in the keep
 * window — they are deletable unless in use (or literally pinned).
 * In-use tags are never deleted, even more than `keep` behind pinned.
 */
export function planGc({ tags, inUse, pinned, previous, keep }) {
  const sortedSemver = semverSortAsc(tags);
  const keepSet = new Set();
  if (pinned) keepSet.add(pinned);
  if (previous) keepSet.add(previous);
  for (const t of inUse) keepSet.add(t);
  if (pinned && isSemver(pinned)) {
    const idx = sortedSemver.indexOf(pinned);
    if (idx > 0) {
      for (const t of sortedSemver.slice(Math.max(0, idx - keep), idx)) keepSet.add(t);
    }
  }
  const toDelete = [
    ...sortedSemver.filter((t) => !keepSet.has(t)),
    ...[...tags].filter((t) => !isSemver(t) && !keepSet.has(t)).sort(),
  ];
  const kept = allTagsSortAsc([...tags].filter((t) => keepSet.has(t)));
  const nonSemver = [...tags].filter((t) => !isSemver(t)).sort();
  return { toDelete, kept, nonSemver };
}

/**
 * Tags referenced by coding-container deployments in the namespace — the
 * images the cluster currently runs, which must never be deleted.
 */
function inUseTags(cfg) {
  const { cmd, args, opts } = kubectlExec();
  let out;
  try {
    out = exec(cmd, [
      ...args,
      "get", "deploy", "-n", cfg.k8s.namespace,
      "-l", "coding-container=true", "-o", "json",
    ], opts);
  } catch (err) {
    throw new Error(
      `cannot list deployments in namespace ${cfg.k8s.namespace} to determine which ` +
        `image tags are in use:\n${err.message}\n` +
        `Refusing to delete tags without knowing which images are deployed.`
    );
  }
  const tags = new Set();
  for (const d of JSON.parse(out).items || []) {
    const pod = d.spec?.template?.spec || {};
    for (const c of [...(pod.containers || []), ...(pod.initContainers || [])]) {
      if (c.image) tags.add(imageTag(c.image));
    }
  }
  return tags;
}

/**
 * List tags of cfg's repo, planning and (unless dryRun) deleting the
 * unreferenced ones per planGc(). Shared by bare `gc` (custom repo) and
 * `system gc` (global repo).
 */
export async function gcTags(cfg, { pinned, previous, keep, dryRun }) {
  console.log(`Listing tags of ${cfg.image.registry}/${cfg.image.name} ...`);
  let tags;
  try {
    tags = await listTags(cfg);
  } catch (err) {
    if (/was not found/i.test(err.message)) {
      console.log("No tags found; nothing to do.");
      return;
    }
    throw err;
  }
  if (tags.length === 0) {
    console.log("No tags found; nothing to do.");
    return;
  }

  const inUse = inUseTags(cfg);
  const { toDelete, kept, nonSemver } = planGc({ tags, inUse, pinned, previous, keep });
  console.log(
    `Found ${tags.length} tag(s); in use: ${[...inUse].join(", ") || "none"}; ` +
      `keeping ${kept.length}, ` +
      (dryRun ? "would delete" : "deleting") + ` ${toDelete.length}.`
  );
  if (nonSemver.length) {
    console.log(
      `Note: ${nonSemver.length} non-semver tag(s) (${nonSemver.join(", ")}) are not ` +
        `counted in the keep window (legacy tags); they are deleted unless in use.`
    );
  }

  if (toDelete.length === 0) {
    console.log("Nothing to delete.");
    return;
  }
  if (dryRun) {
    for (const t of toDelete) console.log(`  would delete ${t}`);
    console.log("(dry run — nothing was deleted)");
    return;
  }

  const failed = [];
  for (const t of toDelete) {
    try {
      await deleteTag(cfg, t);
      console.log(`Deleted ${t}`);
    } catch (err) {
      failed.push(t);
      console.error(`Failed to delete ${t}: ${err.message}`);
    }
  }
  if (failed.length) {
    throw new Error(`could not delete ${failed.length} tag(s): ${failed.join(", ")}`);
  }
  console.log(
    `Deleted ${toDelete.length} tag(s). Disk space is reclaimed when the registry ` +
      `runs its own garbage collection (automatic on GitLab/Harbor; ` +
      `"registry garbage-collect" on a bare Docker registry).`
  );
}

/**
 * Bare `gc`: garbage-collects the current project's custom repo
 * (registry/coding-<project>). Global-mode projects have no custom repo —
 * the shared image is pruned by `system gc` instead.
 */
export async function gc(cfg, { keep = 5, dryRun = false } = {}) {
  if (cfg.imageMode === "global") {
    throw new Error(
      "this project uses the shared global image — there is no project repo to prune. " +
        "Use 'coding-container system gc' to garbage-collect the global image."
    );
  }
  if (!cfg.image.tag) {
    throw new Error(
      "custom image mode requires a tag: set image.tag in the project config or pass --tag"
    );
  }
  await gcTags(cfg, { pinned: cfg.image.tag, previous: undefined, keep, dryRun });
}
