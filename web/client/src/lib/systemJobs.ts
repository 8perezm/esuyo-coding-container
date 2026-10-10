/**
 * Pure arg builders for the global system-image jobs.
 *
 * No React, no DOM — safe to unit-test with the repo's `node --test` runner.
 * Shapes must match web/server/server.js buildJobArgv:
 *   system-create   { tag? }
 *   system-rollback { tag? }        (omitted = previous)
 *   system-gc       { keep?, dryRun? }
 *   system-init     { tag, keep? }  (tag required)
 */

export type JobArgs = Record<string, unknown>;

export function trimTagValue(raw: string): string {
  return raw.trim();
}

/** system-create / system-rollback: omit the tag when empty (server auto-resolves). */
export function buildOptionalTagArgs(rawTag: string): JobArgs {
  const tag = trimTagValue(rawTag);
  return tag ? { tag } : {};
}

export interface KeepParse {
  keep?: number;
  error?: string;
}

export function parseKeepInput(raw: string): KeepParse {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return { error: 'Keep must be a positive integer.' };
  return { keep: n };
}

const IMAGE_SEMVER_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Strict vMAJOR.MINOR.PATCH check (mirrors src/utils/semver.js isSemver). */
export function isImageVersionTag(tag: string): boolean {
  return typeof tag === 'string' && IMAGE_SEMVER_RE.test(tag);
}

/** Numeric comparison of two semver tags (assumes both are semver). */
export function compareImageVersionTags(a: string, b: string): number {
  const pa = a.match(IMAGE_SEMVER_RE)!.slice(1).map(Number);
  const pb = b.match(IMAGE_SEMVER_RE)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Sort image tags newest-first for the Versions table.
 * Semver tags come first (numerically descending), then non-semver tags
 * (lexicographically ascending — they are not part of the version history).
 * Mirrors the CLI `system list` display order (semver descending).
 */
export function sortTagsNewestFirst(tags: string[]): string[] {
  const semver = tags.filter(isImageVersionTag).sort(compareImageVersionTags).reverse();
  const other = tags.filter((t) => !isImageVersionTag(t)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...semver, ...other];
}

/** system-gc args: keep omitted => server default; preview forces dryRun. */
export function buildSystemGcArgs(
  keepRaw: string,
  dryRun: boolean,
  preview: boolean,
): { args?: JobArgs; error?: string } {
  const parsed = parseKeepInput(keepRaw);
  if (parsed.error) return { error: parsed.error };
  const args: JobArgs = {};
  if (parsed.keep !== undefined) args.keep = parsed.keep;
  if (preview || dryRun) args.dryRun = true;
  return { args };
}

/** system-init args: tag required, keep optional (empty => server default). */
export function buildSystemInitArgs(
  rawTag: string,
  keepRaw: string,
): { args?: JobArgs; error?: string } {
  const tag = trimTagValue(rawTag);
  if (!tag) return { error: 'Tag is required (e.g. v1.0.0).' };
  const parsed = parseKeepInput(keepRaw);
  if (parsed.error) return { error: parsed.error };
  const args: JobArgs = { tag };
  if (parsed.keep !== undefined) args.keep = parsed.keep;
  return { args };
}
