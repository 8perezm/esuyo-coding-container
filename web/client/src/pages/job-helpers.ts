/**
 * Pure, UI-agnostic helpers for the GC / Setup / Jobs pages.
 *
 * Kept free of JSX/React so the logic stays unit-testable with the repo's
 * existing `node --test` runner (see job-helpers.test.mjs).
 */

export type JobTone = 'default' | 'accent' | 'violet';

/** Grayscale+accent discipline: running=accent, error=violet, everything else=default. */
export function jobTone(status: string): JobTone {
  if (status === 'running') return 'accent';
  if (status === 'error') return 'violet';
  return 'default';
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function shortId(id: string, length = 8): string {
  if (!id) return '—';
  return id.length > length ? id.slice(0, length) : id;
}

export interface ParsedKeep {
  keep?: number;
  error?: string;
}

/**
 * Parse a GC "keep" text input. Empty means "server default" (omitted from
 * job args). Mirrors the CLI rule: a non-negative integer.
 */
export function parseKeep(raw: string): ParsedKeep {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return { error: 'Keep must be a non-negative integer.' };
  return { keep: n };
}

export interface SetupArgs {
  registry?: string;
  nfsServer?: string;
  nfsBasePath?: string;
  namespace?: string;
}

/** Build `setup` job args, dropping blank (whitespace-only) fields. */
export function buildSetupArgs(
  registry: string,
  nfsServer: string,
  nfsBasePath: string,
  namespace = '',
): SetupArgs {
  const args: SetupArgs = {};
  const r = registry.trim();
  const s = nfsServer.trim();
  const b = nfsBasePath.trim();
  const n = namespace.trim();
  if (r) args.registry = r;
  if (s) args.nfsServer = s;
  if (b) args.nfsBasePath = b;
  if (n) args.namespace = n;
  return args;
}

/**
 * DNS-1123 label rule for namespace names.
 * Same regex as `defaultNamespace()` in `src/utils/instance.js`.
 */
export const NAMESPACE_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** True when `name` is a valid non-empty namespace name (≤63 chars). */
export function isValidNamespaceName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 && trimmed.length <= 63 && NAMESPACE_NAME_PATTERN.test(trimmed)
  );
}

export interface NamespaceSetupValues {
  registry?: string;
  nfsServer?: string;
  nfsBasePath?: string;
}

export interface ClusterNamespaceEntry {
  name: string;
  initialized: boolean;
  setupValues?: NamespaceSetupValues | null;
  createdAt?: string | null;
}

/**
 * Merge a picked namespace's stored setup values over the local
 * global-config values. Blank namespace fields fall through to the
 * global value; everything else stays blank (omitted from job args).
 */
export function mergeSetupPrefill(
  fromNamespace?: NamespaceSetupValues | null,
  fromGlobal?: NamespaceSetupValues | null,
): { registry: string; nfsServer: string; nfsBasePath: string } {
  const pick = (nsValue?: string, globalValue?: string): string =>
    (nsValue ?? '').trim() || (globalValue ?? '').trim();
  return {
    registry: pick(fromNamespace?.registry, fromGlobal?.registry),
    nfsServer: pick(fromNamespace?.nfsServer, fromGlobal?.nfsServer),
    nfsBasePath: pick(fromNamespace?.nfsBasePath, fromGlobal?.nfsBasePath),
  };
}

/**
 * Best-effort subset reader for the machine-written global config YAML.
 * Extracts only `image.registry`, `k8s.namespace`, `nfs.server`, and
 * `nfs.basePath`; anything else (nested maps, lists, unknown keys) is
 * ignored. Returns `{}` when there is nothing usable.
 */
export function extractGlobalSetupValues(
  rawYaml: string | null | undefined,
): NamespaceSetupValues & { namespace?: string } {
  const out: NamespaceSetupValues & { namespace?: string } = {};
  if (!rawYaml) return out;
  const wanted: Record<string, Record<string, 'registry' | 'namespace' | 'nfsServer' | 'nfsBasePath'>> = {
    image: { registry: 'registry' },
    k8s: { namespace: 'namespace' },
    nfs: { server: 'nfsServer', basePath: 'nfsBasePath' },
  };
  let section: string | null = null;
  for (const line of rawYaml.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (top) {
      section = top[1];
      continue;
    }
    if (!section || !line.match(/^\s/) || !(section in wanted)) continue;
    const child = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!child) continue;
    const field = wanted[section][child[1]];
    if (!field || out[field]) continue;
    let value = child[2].replace(/\s+#.*$/, '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[field] = value;
  }
  return out;
}
