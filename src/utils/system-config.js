import { exec, runWithInput } from "./exec.js";
import { isSemver, compareSemver } from "./semver.js";

/**
 * The team-wide source of truth for the global coding image: one ConfigMap
 * in the cluster, no files on laptops. All team state lives here; laptops
 * hold only machine secrets (docker login, kubectl context).
 *
 * Data keys (all strings):
 *   current   - what global-mode deploys float on
 *   previous  - last good version, the default rollback target (may be absent)
 *   maxEver   - highest version ever published; never moves backward, so a
 *               rolled-back (poisoned) tag can never be republished
 *   keep      - gc window: how many versions behind current to keep
 */
export const SYSTEM_CM_NAME = "coding-system";
export const SYSTEM_CM_LABEL = "coding-container=true";

export const INIT_HINT =
  `The ${SYSTEM_CM_NAME} ConfigMap does not exist yet. Bootstrap it with:\n` +
  `  coding-container system init --tag v1.0.0 --keep 10`;

/**
 * Which kubectl to run. KUBECTL_BIN lets tests (and users with a wrapper)
 * point at a specific binary. A node script stub (.js/.cjs/.mjs) is run
 * directly, without a shell: piping stdin through cmd.exe is racy on
 * Windows (the apply -f - manifest would be lost). A Windows script stub
 * (.cmd/.bat) needs a shell to spawn.
 * Returns { cmd, args, opts }; `args` must be prepended to the kubectl args.
 */
export function kubectlExec() {
  const bin = process.env.KUBECTL_BIN || "kubectl";
  if (process.env.KUBECTL_BIN && /\.(c|m)?js$/.test(bin)) {
    return { cmd: process.execPath, args: [bin], opts: {} };
  }
  const opts =
    process.env.KUBECTL_BIN && process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)
      ? { shell: true }
      : {};
  return { cmd: bin, args: [], opts };
}

/**
 * Parse and validate the data block of the coding-system ConfigMap.
 * Throws with a clear message on any invalid value.
 */
export function parseSystemData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`system config: ${SYSTEM_CM_NAME} ConfigMap has no data block`);
  }
  const out = {};
  for (const key of ["current", "maxEver"]) {
    const v = data[key];
    if (typeof v !== "string" || !isSemver(v)) {
      throw new Error(
        `system config: "${key}" must be a semver string (vX.Y.Z), got: ${JSON.stringify(v)}`
      );
    }
    out[key] = v;
  }
  const previous = data.previous;
  if (previous === undefined || previous === "") {
    out.previous = undefined;
  } else if (!isSemver(previous)) {
    throw new Error(
      `system config: "previous" must be a semver string (vX.Y.Z) or empty, got: ${JSON.stringify(previous)}`
    );
  } else {
    out.previous = previous;
  }
  const keep = data.keep;
  if (typeof keep !== "string" || !/^\d+$/.test(keep)) {
    throw new Error(
      `system config: "keep" must be a non-negative integer string, got: ${JSON.stringify(keep)}`
    );
  }
  out.keep = Number.parseInt(keep, 10);
  if (compareSemver(out.current, out.maxEver) > 0) {
    throw new Error(
      `system config: current ${out.current} is newer than maxEver ${out.maxEver} — the ConfigMap is corrupted`
    );
  }
  return out;
}

/**
 * Read the coding-system ConfigMap from the cluster. Throws INIT_HINT when
 * the ConfigMap is missing (fresh cluster) so callers can surface it.
 */
export function getSystemConfig(ns) {
  const { cmd, args, opts } = kubectlExec();
  let out;
  try {
    out = exec(cmd, [...args, "get", "cm", SYSTEM_CM_NAME, "-n", ns, "-o", "json"], opts);
  } catch (err) {
    if (/not found/i.test(err.message)) {
      throw new Error(INIT_HINT);
    }
    throw new Error(
      `cannot read the ${SYSTEM_CM_NAME} ConfigMap in namespace ${ns}:\n${err.message}`
    );
  }
  let cm;
  try {
    cm = JSON.parse(out);
  } catch (err) {
    throw new Error(`cannot parse the ${SYSTEM_CM_NAME} ConfigMap: ${err.message}`);
  }
  return parseSystemData(cm.data);
}

export function systemConfigManifest(ns, data) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: SYSTEM_CM_NAME,
      namespace: ns,
      labels: { "coding-container": "true" },
    },
    data,
  };
}

/**
 * Write the full coding-system state (create-or-update via kubectl apply).
 * Callers compute the new complete state; the ConfigMap is small and the
 * writers are human-driven, so read-then-write is safe for this team.
 */
export async function patchSystemConfig(ns, { current, previous, maxEver, keep }) {
  const data = { current, maxEver, keep: String(keep) };
  if (previous) data.previous = previous;
  parseSystemData(data);
  const { cmd, args, opts } = kubectlExec();
  await runWithInput(cmd, [...args, "apply", "-f", "-"], JSON.stringify(systemConfigManifest(ns, data)), opts);
}

/**
 * The tag a deploy/create should use:
 *   custom mode  - the project's own pin (image.tag or --tag), required
 *   global mode  - the project's pin when set (image.tag or --tag), else
 *                  the ConfigMap's current (the float)
 */
export function resolveDeployTag(cfg) {
  if (cfg.imageMode === "custom") {
    if (!cfg.image.tag) {
      throw new Error(
        "custom image mode requires a tag: set image.tag in the project config or pass --tag"
      );
    }
    return cfg.image.tag;
  }
  if (cfg.image.tag) {
    if (!isSemver(cfg.image.tag)) {
      throw new Error(
        `global-mode tags must be semver (vX.Y.Z) — the global repo only carries semver tags, got: ${cfg.image.tag}`
      );
    }
    return cfg.image.tag;
  }
  return getSystemConfig(cfg.k8s.namespace).current;
}
