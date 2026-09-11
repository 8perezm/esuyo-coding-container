import { exec } from "../utils/exec.js";
import { listTags } from "../utils/registry-api.js";
import { isSemver, compareSemver, semverSortAsc } from "../utils/semver.js";
import {
  getSystemConfig,
  patchSystemConfig,
  kubectlExec,
  SYSTEM_CM_NAME,
} from "../utils/system-config.js";
import { buildImage } from "./build.js";
import { pushImage } from "./push.js";
import { gcTags } from "./gc.js";
import { ensureNamespace } from "./deploy.js";

function requireGlobalMode(cfg) {
  if (cfg.imageMode === "custom") {
    throw new Error(
      "system commands manage the shared global image and must be run from a " +
        "global-mode project (or the repo root) — this project uses its own custom image."
    );
  }
}

function requireSemverTag(tag, what = "--tag") {
  if (!tag) throw new Error(`${what} is required (semver vX.Y.Z)`);
  if (!isSemver(tag)) {
    throw new Error(
      `${what} must be semver vX.Y.Z (human-picked, no timestamps, no pre-release), got: ${tag}`
    );
  }
}

/**
 * Registry tags of the global repo; an empty list when the repo has not
 * been created in the registry yet (nothing pushed so far).
 */
async function globalTags(cfg) {
  try {
    return await listTags(cfg);
  } catch (err) {
    if (/was not found/i.test(err.message)) return [];
    throw err;
  }
}

/**
 * Create the coding-system ConfigMap (fresh cluster only). Fails when the
 * ConfigMap already exists — there is exactly one, per cluster.
 */
export async function systemInit(cfg, { tag, keep = 10 } = {}) {
  requireGlobalMode(cfg);
  requireSemverTag(tag);
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`--keep must be a non-negative integer, got: ${keep}`);
  }
  const ns = cfg.k8s.namespace;
  const { cmd, args, opts } = kubectlExec();
  try {
    exec(cmd, [...args, "get", "cm", SYSTEM_CM_NAME, "-n", ns], opts);
    throw new Error(
      `the ${SYSTEM_CM_NAME} ConfigMap already exists in namespace ${ns} — ` +
        `inspect it with 'coding-container system get' and publish new versions with 'system create --tag vX.Y.Z'`
    );
  } catch (err) {
    if (!/not found/i.test(err.message)) throw err;
  }
  await ensureNamespace(ns);
  await patchSystemConfig(ns, { current: tag, previous: undefined, maxEver: tag, keep });
  console.log(
    `Created ${SYSTEM_CM_NAME} in namespace ${ns}: current=${tag} maxEver=${tag} keep=${keep}`
  );
  console.log(`Global image: ${cfg.image.registry}/${cfg.image.name}:${tag}`);
  console.log("Projects now deploy it on their next 'coding-container deploy'.");
}

/**
 * Show the coding-system state and the resolved global image reference.
 */
export function systemGet(cfg) {
  requireGlobalMode(cfg);
  const sys = getSystemConfig(cfg.k8s.namespace);
  console.log(`${SYSTEM_CM_NAME} ConfigMap in namespace ${cfg.k8s.namespace}:`);
  console.log(`  current:  ${sys.current}`);
  console.log(`  previous: ${sys.previous ?? "none (no rollback target recorded yet)"}`);
  console.log(`  maxEver:  ${sys.maxEver}`);
  console.log(`  keep:     ${sys.keep}`);
  console.log(`Global image: ${cfg.image.registry}/${cfg.image.name}:${sys.current}`);
}

/**
 * List the global repo's registry tags, semver-sorted. Read-only helper
 * for picking the next version.
 */
export async function systemList(cfg) {
  requireGlobalMode(cfg);
  console.log(`Listing tags of ${cfg.image.registry}/${cfg.image.name} ...`);
  const tags = await globalTags(cfg);
  if (tags.length === 0) {
    console.log("No tags found.");
    return;
  }
  let sys = null;
  try {
    sys = getSystemConfig(cfg.k8s.namespace);
  } catch {
    /* offline or not initialized — just list */
  }
  for (const t of [...semverSortAsc(tags)].reverse()) {
    let mark = "";
    if (sys) {
      if (t === sys.current) mark = "  <- current";
      else if (t === sys.previous) mark = "  (previous)";
      else if (t === sys.maxEver) mark = "  (maxEver)";
    }
    console.log(`  ${t}${mark}`);
  }
  const other = tags.filter((t) => !isSemver(t));
  if (other.length) {
    console.log(`  non-semver (not part of the version history): ${[...other].sort().join(", ")}`);
  }
}

/**
 * The ONLY writer of the global image: build + push a new immutable tag,
 * then repoint the ConfigMap (previous=current, current=tag, maxEver=tag).
 */
export async function systemCreate(cfg, { tag } = {}) {
  requireGlobalMode(cfg);
  requireSemverTag(tag);
  const ns = cfg.k8s.namespace;
  const sys = getSystemConfig(ns);
  if (compareSemver(tag, sys.maxEver) <= 0) {
    throw new Error(
      `tag ${tag} is not greater than maxEver ${sys.maxEver} — global tags are immutable and ` +
        `a rolled-back version can never be republished. Pick a new, higher version.`
    );
  }
  console.log(`Checking that ${tag} does not exist in ${cfg.image.registry}/${cfg.image.name} ...`);
  const tags = await globalTags(cfg);
  if (tags.includes(tag)) {
    throw new Error(
      `tag ${tag} already exists in ${cfg.image.registry}/${cfg.image.name} — ` +
        `tags are immutable, pick another version`
    );
  }
  cfg.image.tag = tag;
  await buildImage(cfg);
  await pushImage(cfg);
  await patchSystemConfig(ns, {
    current: tag,
    previous: sys.current,
    maxEver: tag,
    keep: sys.keep,
  });
  console.log(
    `Published ${cfg.image.registry}/${cfg.image.name}:${tag} — ` +
      `current ${sys.current} -> ${tag}, previous -> ${sys.current}, maxEver -> ${tag}`
  );
  console.log("Projects now deploy " + tag + " on their next 'coding-container deploy'.");
}

/**
 * Repoint current to an existing version (default: previous). Pure pointer
 * change — no build, no push, no delete. maxEver never moves.
 */
export async function systemRollback(cfg, { tag } = {}) {
  requireGlobalMode(cfg);
  const ns = cfg.k8s.namespace;
  const sys = getSystemConfig(ns);
  const target = tag ?? sys.previous;
  if (!target) {
    throw new Error(
      "no rollback target: 'previous' is not set yet (nothing has been published or " +
        "rolled back since init). Pass a version explicitly: coding-container system rollback vX.Y.Z"
    );
  }
  requireSemverTag(target, "target version");
  if (target === sys.current) {
    throw new Error(`${target} is already current — nothing to roll back to`);
  }
  console.log(`Checking that ${target} exists in ${cfg.image.registry}/${cfg.image.name} ...`);
  const tags = await globalTags(cfg);
  if (!tags.includes(target)) {
    throw new Error(
      `tag ${target} does not exist in ${cfg.image.registry}/${cfg.image.name} — ` +
        `'coding-container system list' shows what is available`
    );
  }
  await patchSystemConfig(ns, {
    current: target,
    previous: sys.current,
    maxEver: sys.maxEver,
    keep: sys.keep,
  });
  console.log(
    `Rolled back: current ${sys.current} -> ${target}, previous -> ${sys.current} ` +
      `(maxEver stays ${sys.maxEver})`
  );
  console.log(
    "Projects now deploy " +
      target +
      " on their next 'coding-container deploy'. No image was built, pushed or deleted."
  );
}

/**
 * Garbage-collect the global repo only. Keeps current + previous + every
 * in-use tag + the ConfigMap's keep-many predecessors of current.
 * `--keep` overrides the window for one run.
 */
export async function systemGc(cfg, { keep, dryRun = false } = {}) {
  requireGlobalMode(cfg);
  const sys = getSystemConfig(cfg.k8s.namespace);
  await gcTags(cfg, {
    pinned: sys.current,
    previous: sys.previous,
    keep: keep !== undefined ? keep : sys.keep,
    dryRun,
  });
}
