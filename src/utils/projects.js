import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, globalConfigDir } from "../config.js";

/**
 * Shared projects registry (the GUI datastore), reused by the CLI.
 *
 * Store shape: JSON array of { id, name, configPath } at
 *   <globalConfigDir()>/projects.json
 * unless PROJECTS_FILE overrides it (absolute, or relative to the repo root).
 * Managed per-project configs live under <globalConfigDir()>/projects/<slug>/.
 */

/** Resolve an explicit PROJECTS_FILE value to an absolute path. */
export function resolveProjectsFile(raw) {
  const value = raw && String(raw).trim() ? String(raw).trim() : "";
  if (!value) return path.join(globalConfigDir(), "projects.json");
  return path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value);
}

/** Default registry path: PROJECTS_FILE env wins, else next to global config. */
export function defaultProjectsFile() {
  // Touch the global dir first so a PROJECTS_FILE set in the checkout's .env
  // is loaded into process.env before reading it — matching the GUI server,
  // which reads the same .env file directly.
  globalConfigDir();
  return resolveProjectsFile(process.env.PROJECTS_FILE ?? "");
}

export function readProjects(projectsFile) {
  const file = projectsFile ?? defaultProjectsFile();
  try {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function writeProjects(projectsFile, projects) {
  fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
  fs.writeFileSync(projectsFile, `${JSON.stringify(projects, null, 2)}\n`);
}

export function resolveStoredConfigPath(configPath) {
  const raw = String(configPath ?? "").trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
}

/**
 * Filesystem + k8s-safe slug from a display name (DNS-1123 label style).
 * Mirrors deriveProjectName(): lowercase, non [a-z0-9-] -> "-", collapse,
 * trim dashes, cap at 63 chars, fallback to "project".
 */
export function slugifyProjectName(name) {
  let slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "project";
  if (slug.length > 63) slug = slug.slice(0, 63).replace(/-+$/g, "") || "project";
  return slug;
}

/**
 * Display slugs for every registry entry, in registry order. The slug tracks
 * the current name; collisions get -2, -3, ... suffixes.
 * Returns [{ project, slug }].
 */
export function computeProjectSlugs(projects) {
  const used = new Set();
  const out = [];
  for (const project of projects ?? []) {
    const base = slugifyProjectName(project?.name);
    let slug = base;
    let n = 1;
    while (used.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    used.add(slug);
    out.push({ project, slug });
  }
  return out;
}

/** Folder holding auto-managed per-project configs: <globalDir>/projects. */
export function managedProjectsDir() {
  return path.join(globalConfigDir(), "projects");
}

/** Default config file for an auto-managed project slug. */
export function defaultProjectConfigPath(slug) {
  return path.join(managedProjectsDir(), slug, "config.yaml");
}

/**
 * True when configPath lives inside the managed projects dir (i.e. it was
 * auto-assigned, not a user-supplied custom path). Such paths follow renames.
 */
export function isManagedConfigPath(configPath) {
  const resolved = path.resolve(String(configPath ?? ""));
  const base = path.resolve(managedProjectsDir());
  const rel = path.relative(base, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Unique managed config path for a base slug. Suffixes -2, -3, ... while the
 * candidate is taken by another registry entry (excluding excludeId) or an
 * existing file on disk (e.g. leftovers from a removed entry).
 */
export function uniqueManagedConfigPath(projects, baseSlug, excludeId = null) {
  const takenPaths = new Set(
    (projects ?? [])
      .filter((p) => p.id !== excludeId)
      .map((p) => path.resolve(String(p.configPath ?? "")))
  );
  let slug = baseSlug;
  let n = 1;
  while (true) {
    const candidate = defaultProjectConfigPath(slug);
    const resolved = path.resolve(candidate);
    if (!takenPaths.has(resolved) && !fs.existsSync(candidate)) return { slug, configPath: candidate };
    n += 1;
    slug = `${baseSlug}-${n}`;
  }
}

/**
 * One-line summary used in "unknown project" errors.
 * `entries` is the result of computeProjectSlugs().
 */
function availableProjectsHint(entries, projectsFile) {
  if (!entries || entries.length === 0) {
    return `No projects registered in ${projectsFile}.`;
  }
  const lines = entries.map(({ project, slug }) => `  ${slug} ("${project?.name ?? ""}")`);
  return `Available projects (slug, name or id):\n${lines.join("\n")}`;
}

/**
 * Match a user-supplied ref against the registry. Ref may be a display slug,
 * a name, or an id (exact or unique prefix >= 4 chars).
 * Returns { project, slug } or null when nothing matches.
 * Throws on ambiguous names/prefixes.
 */
export function findProjectByRef(projects, ref) {
  const needle = String(ref ?? "").trim();
  if (!needle) return null;
  const list = projects ?? [];
  const entries = computeProjectSlugs(list);

  const byId = list.find((p) => p?.id === needle);
  if (byId) {
    const slug = entries.find((e) => e.project === byId)?.slug ?? slugifyProjectName(byId.name);
    return { project: byId, slug };
  }

  const lowered = needle.toLowerCase();
  const slugHits = entries.filter((e) => e.slug.toLowerCase() === lowered);
  if (slugHits.length === 1) return slugHits[0];
  if (slugHits.length > 1) {
    throw new Error(
      `Ambiguous project "${needle}" matches several slugs: ${slugHits.map((e) => e.slug).join(", ")}`
    );
  }

  const exactName = entries.filter((e) => String(e.project?.name ?? "") === needle);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) {
    throw new Error(
      `Ambiguous project name "${needle}" matches ${exactName.length} projects; use the slug or id instead.`
    );
  }

  const ciName = entries.filter(
    (e) => String(e.project?.name ?? "").toLowerCase() === lowered
  );
  if (ciName.length === 1) return ciName[0];
  if (ciName.length > 1) {
    throw new Error(
      `Ambiguous project name "${needle}" matches ${ciName.length} projects; use the slug or id instead.`
    );
  }

  if (needle.length >= 4) {
    const prefix = list.filter((p) => typeof p?.id === "string" && p.id.startsWith(needle));
    if (prefix.length === 1) {
      const project = prefix[0];
      const slug = entries.find((e) => e.project === project)?.slug ?? slugifyProjectName(project.name);
      return { project, slug };
    }
    if (prefix.length > 1) {
      throw new Error(
        `Ambiguous project id prefix "${needle}" matches ${prefix.length} projects; use the full id.`
      );
    }
  }

  return null;
}

/**
 * Like findProjectByRef, but throws a copy-paste friendly error naming the
 * registry file and every available slug when nothing matches.
 */
export function resolveProjectRefOrThrow(projects, ref, projectsFile) {
  const match = findProjectByRef(projects, ref);
  if (match) return match;
  const entries = computeProjectSlugs(projects ?? []);
  throw new Error(
    `Unknown project "${String(ref ?? "").trim()}".\n${availableProjectsHint(entries, projectsFile)}\nRun "coding-container projects list" to see all projects.`
  );
}
