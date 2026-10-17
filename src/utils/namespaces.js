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
