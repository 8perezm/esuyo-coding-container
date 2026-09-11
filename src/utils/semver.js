// Strict vMAJOR.MINOR.PATCH semver (with a leading 'v'). No pre-release or
// build metadata: the global image's versions are human-picked and immutable.
const SEMVER_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function isSemver(tag) {
  return typeof tag === "string" && SEMVER_RE.test(tag);
}

/**
 * Numeric comparison of two semver tags (assumes both are semver).
 * Returns -1, 0 or 1. Orders numerically, so v1.10.0 > v1.9.9.
 */
export function compareSemver(a, b) {
  const pa = a.match(SEMVER_RE).slice(1).map(Number);
  const pb = b.match(SEMVER_RE).slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The semver tags of a list, sorted ascending (oldest first). Non-semver
 * tags (e.g. legacy timestamp tags) are excluded.
 */
export function semverSortAsc(tags) {
  return [...tags].filter(isSemver).sort(compareSemver);
}

/**
 * All tags oldest-first: semver tags numerically ascending, non-semver tags
 * after them (lexicographically). Display order for kept tags.
 */
export function allTagsSortAsc(tags) {
  return [...tags].sort((a, b) => {
    const as = isSemver(a);
    const bs = isSemver(b);
    if (as && bs) return compareSemver(a, b);
    if (as !== bs) return as ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
