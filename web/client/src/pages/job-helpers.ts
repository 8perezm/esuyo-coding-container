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
}

/** Build `setup` job args, dropping blank (whitespace-only) fields. */
export function buildSetupArgs(registry: string, nfsServer: string, nfsBasePath: string): SetupArgs {
  const args: SetupArgs = {};
  const r = registry.trim();
  const s = nfsServer.trim();
  const b = nfsBasePath.trim();
  if (r) args.registry = r;
  if (s) args.nfsServer = s;
  if (b) args.nfsBasePath = b;
  return args;
}
