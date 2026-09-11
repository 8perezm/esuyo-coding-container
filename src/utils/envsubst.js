/**
 * Minimal `${VAR}` expansion for env-ish config values.
 *
 * Only the braced form is expanded (bare `$VAR` is left alone), there are no
 * defaults (`${VAR:-fallback}` is not supported), and there is no escape
 * hatch: a literal `${...}` in one of these fields always expands. This keeps
 * existing values without a `${...}` substring byte-identical.
 */

/**
 * Expand `${VAR}` references in a string from process.env.
 * @param {string} value the raw config value
 * @param {string} what human-readable label for error messages (e.g. "k8s.secretEnv 'OPENAI_API_KEY'")
 */
export function expandEnvRefs(value, what = "value") {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (!(name in process.env)) {
      throw new Error(
        `config: ${what} needs $${name} (not set in the local environment)`
      );
    }
    return process.env[name];
  });
}

/**
 * Expand `${VAR}` in every string value of a flat env map. Non-string scalars
 * pass through untouched (renderers coerce with String() later). Non-maps
 * pass through untouched so validate() can reject them with a clear error.
 */
export function expandEnvMap(map, what = "value") {
  if (map == null || typeof map !== "object" || Array.isArray(map)) return map;
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] =
      typeof value === "string" ? expandEnvRefs(value, `${what} '${key}'`) : value;
  }
  return out;
}
