import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Checkout root (PROJECT_FOLDER): src/utils -> src -> root.
export const INSTANCE_ROOT = path.resolve(__dirname, "..", "..");

export const DEFAULT_CONFIG_LEAF = "coding-container";
export const DEFAULT_SSH_PREFIX = "coding-";
export const DEFAULT_NAMESPACE = "coding";

let loaded = false;

/**
 * Minimal .env parser (no dependency): KEY=VALUE lines, optional `export`
 * prefix, `#` comments, single/double-quoted values. Real environment wins:
 * keys already in process.env are never overwritten. Loads once from
 * PROJECT_FOLDER/.env (the checkout root), so each repeated folder carries
 * its own dev/prod identity no matter where commands run from.
 */
export function loadInstanceEnv(root = INSTANCE_ROOT) {
  if (loaded) return;
  loaded = true;
  let text;
  try {
    text = fs.readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (key in process.env) continue;
    process.env[key] = unquote(rest.trim());
  }
}

// Test-only: allow re-loading after env swaps.
export function resetInstanceEnvForTests() {
  loaded = false;
}

function unquote(v) {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    // Double-quoted: honor common escapes; single-quoted: literal.
    return v.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  const comment = v.search(/(^|\s)#/);
  return (comment === -1 ? v : v.slice(0, comment).trim());
}

/** Global config dir leaf: CODING_CONFIG_LEAF, default "coding-container". */
export function configDirLeaf() {
  loadInstanceEnv();
  const v = (process.env.CODING_CONFIG_LEAF ?? "").trim() || DEFAULT_CONFIG_LEAF;
  if (!/^[A-Za-z0-9._-]+$/.test(v) || v === "." || v === "..") {
    throw new Error(`config: CODING_CONFIG_LEAF must be a plain folder name (no slashes): ${JSON.stringify(v)}`);
  }
  return v;
}

/** SSH alias prefix: CODING_SSH_PREFIX, default "coding-". */
export function sshPrefix() {
  loadInstanceEnv();
  const v = (process.env.CODING_SSH_PREFIX ?? "").trim() || DEFAULT_SSH_PREFIX;
  if (!/^[a-z0-9-]+$/.test(v) || !v.endsWith("-") || v.length > 32) {
    throw new Error(`config: CODING_SSH_PREFIX must be lowercase alnum/dashes ending in '-': ${JSON.stringify(v)}`);
  }
  return v;
}

/** Default k8s namespace: CODING_NAMESPACE, default "coding". Config files still override it. */
export function defaultNamespace() {
  loadInstanceEnv();
  const v = (process.env.CODING_NAMESPACE ?? "").trim() || DEFAULT_NAMESPACE;
  if (v.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v)) {
    throw new Error(`config: CODING_NAMESPACE must be a valid k8s name (lowercase alphanum and '-'): ${v}`);
  }
  return v;
}
