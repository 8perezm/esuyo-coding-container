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
