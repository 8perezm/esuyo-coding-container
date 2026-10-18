import { exec } from "./exec.js";
import { kubectlExec, SYSTEM_CM_NAME } from "./system-config.js";

/**
 * Label every coding-container namespace carries. The namespaces endpoint
 * lists with `-l coding-container=true` server-side, so unlabeled namespaces
 * are not coding-container namespaces by definition and never show up.
 */
export const NAMESPACE_LABEL = "coding-container=true";

/**
 * Free-form setup values live in annotations (labels are for selection).
 * Written at setup/init time, read back to prefill the Setup form when an
 * existing namespace is picked.
 */
export const SETUP_ANNOTATIONS = {
  registry: "coding-container.io/registry",
  nfsServer: "coding-container.io/nfs-server",
  nfsBasePath: "coding-container.io/nfs-base-path",
};

function coerceItems(json) {
  let parsed = json;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    return null;
  }
  return parsed.items;
}

/**
 * Pure merge of `kubectl get ns -l coding-container=true -o json` with
 * `kubectl get cm coding-system -A -o json`. A namespace counts as
 * `initialized` when a coding-system ConfigMap lives in it. Namespaces
 * without annotations prefill namespace-only (setupValues {}).
 *
 * Both inputs accept an already-parsed object or a raw JSON string.
 * Anything unparseable or wrongly shaped degrades to [] so Setup stays
 * usable offline with a manual-input fallback.
 */
export function parseNamespaces(nsJson, cmJson) {
  const nsItems = coerceItems(nsJson);
  if (!nsItems) return [];
  const cmItems = coerceItems(cmJson) ?? [];
  const initializedByNs = new Set();
  for (const cm of cmItems) {
    const cmNs = cm?.metadata?.namespace;
    // The kubectl call is already name-filtered server-side; the name check
    // keeps the pure function honest when handed an unfiltered list.
    if (typeof cmNs === "string" && cm?.metadata?.name === SYSTEM_CM_NAME) {
      initializedByNs.add(cmNs);
    }
  }
  const out = [];
  for (const item of nsItems) {
    const name = item?.metadata?.name;
    if (typeof name !== "string" || !name) continue;
    const annotations = item?.metadata?.annotations;
    const setupValues = {};
    if (annotations && typeof annotations === "object") {
      for (const [field, key] of Object.entries(SETUP_ANNOTATIONS)) {
        const v = annotations[key];
        if (typeof v === "string" && v.trim()) setupValues[field] = v;
      }
    }
    out.push({
      name,
      initialized: initializedByNs.has(name),
      setupValues,
      createdAt:
        typeof item?.metadata?.creationTimestamp === "string"
          ? item.metadata.creationTimestamp
          : undefined,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Read-only cluster edge: exactly two `get` calls, never anything
 * destructive. A failed namespace list means the cluster is unreachable and
 * throws (the namespaces endpoint maps that to `{ ok: false }`); a failed
 * ConfigMap read degrades to all-`initialized: false` so a partial answer
 * still lists the namespaces.
 */
export function getNamespaces() {
  const { cmd, args, opts } = kubectlExec();
  let nsJson;
  try {
    nsJson = exec(cmd, [...args, "get", "ns", "-l", NAMESPACE_LABEL, "-o", "json"], opts);
  } catch (err) {
    throw new Error(`cannot list coding-container namespaces:\n${err.message}`);
  }
  let cmJson = '{"items":[]}';
  try {
    cmJson = exec(cmd, [...args, "get", "cm", SYSTEM_CM_NAME, "-A", "-o", "json"], opts);
  } catch {
    cmJson = '{"items":[]}';
  }
  return parseNamespaces(nsJson, cmJson);
}

/**
 * Extract the setup registry (everything before the image name) from a
 * container image reference. Strips tag/digest first, then drops the last
 * path segment (the image name):
 *   "registry.example.com/you/coding-container:v1.0.0" -> "registry.example.com/you"
 *   "10.0.0.5:5000/coding-container:v1.0.0"            -> "10.0.0.5:5000"
 * Returns "" when there is no registry prefix to infer.
 */
export function registryFromImage(image) {
  const raw = String(image ?? "").trim();
  if (!raw) return "";
  let s = raw.split("@")[0];
  const lastSlash = s.lastIndexOf("/");
  const lastColon = s.lastIndexOf(":");
  if (lastColon > lastSlash) s = s.slice(0, lastColon);
  const slash = s.lastIndexOf("/");
  if (slash <= 0) return "";
  return s.slice(0, slash).trim();
}

/**
 * Placeholder values that must never count as live cluster state. Mirrors
 * PLACEHOLDERS in src/commands/setup.js (kept local to avoid a cycle:
 * setup.js imports this module). A broken deploy written from placeholders
 * (e.g. the legacy `wicked` case) must not poison inference for the rest.
 */
const PLACEHOLDER_VALUES = new Set([
  "your-registry.example.com/you",
  "your-nas-ip-or-hostname",
  "/path/to/shared/workspaces",
]);

function isUsableSetupValue(v) {
  if (typeof v !== "string") return false;
  const t = v.trim();
  return Boolean(t) && !PLACEHOLDER_VALUES.has(t);
}

/**
 * Pure extraction of setup values from `kubectl get deploy -n <ns> -o json`.
 * Reads the NFS volume (`volumes[].nfs.{server,path}`) and the container
 * image registry across all workloads and returns the most common value
 * per field (majority vote), so one broken deploy written from placeholders
 * cannot override the healthy majority. Placeholders and blanks are ignored.
 * Accepts an already-parsed object or a raw JSON string; anything
 * unparseable or wrongly shaped degrades to {}.
 */
export function parseDeploymentSetupValues(deployJson) {
  let parsed = deployJson;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) return {};
  const votes = { registry: new Map(), nfsServer: new Map(), nfsBasePath: new Map() };
  const vote = (field, value) => {
    if (!isUsableSetupValue(value)) return;
    const t = value.trim();
    votes[field].set(t, (votes[field].get(t) ?? 0) + 1);
  };
  for (const item of parsed.items) {
    const podSpec = item?.spec?.template?.spec;
    if (!podSpec || typeof podSpec !== "object") continue;
    const volumes = Array.isArray(podSpec.volumes) ? podSpec.volumes : [];
    for (const vol of volumes) {
      const nfs = vol?.nfs;
      if (!nfs || typeof nfs !== "object") continue;
      vote("nfsServer", nfs.server);
      let basePath = typeof nfs.path === "string" ? nfs.path.trim() : "";
      if (basePath) basePath = basePath.replace(/\/+$/, "") || "/";
      vote("nfsBasePath", basePath);
    }
    const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
    for (const c of containers) vote("registry", registryFromImage(c?.image));
  }
  const out = {};
  for (const [field, counts] of Object.entries(votes)) {
    let best = "";
    let bestN = 0;
    for (const [value, n] of counts) {
      if (n > bestN) {
        best = value;
        bestN = n;
      }
    }
    if (best) out[field] = best;
  }
  return out;
}

/**
 * Best-effort read of one namespace's live workload values (deployments).
 * Returns {} when the namespace has no deployments, is unreachable, or
 * carries no NFS/image info. Never throws, so `setup` stays usable offline.
 */
export function readDeploymentSetupValues(ns) {
  const name = String(ns ?? "").trim();
  if (!name) return {};
  try {
    const { cmd, args, opts } = kubectlExec();
    const out = exec(cmd, [...args, "get", "deploy", "-n", name, "-o", "json"], opts);
    return parseDeploymentSetupValues(out);
  } catch {
    return {};
  }
}

/**
 * Best-effort read of one namespace's stored setup values (annotations).
 * Returns {} when the namespace is missing, unreachable, or has no
 * annotations. Never throws, so `setup` stays usable offline.
 */
export function readNamespaceSetupValues(ns) {
  const name = String(ns ?? "").trim();
  if (!name) return {};
  try {
    const { cmd, args, opts } = kubectlExec();
    const out = exec(cmd, [...args, "get", "namespace", name, "-o", "json"], opts);
    let obj;
    try {
      obj = typeof out === "string" ? JSON.parse(out) : out;
    } catch {
      return {};
    }
    const annotations = obj?.metadata?.annotations;
    if (!annotations || typeof annotations !== "object") return {};
    const values = {};
    for (const [field, key] of Object.entries(SETUP_ANNOTATIONS)) {
      const v = annotations[key];
      if (typeof v === "string" && v.trim()) values[field] = v.trim();
    }
    return values;
  } catch {
    return {};
  }
}
