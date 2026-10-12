import fs from "node:fs";
import {
  computeProjectSlugs,
  defaultProjectsFile,
  readProjects,
} from "../utils/projects.js";

/**
 * `projects list`: tabular view of the shared registry
 * (<globalConfigDir()>/projects.json unless PROJECTS_FILE overrides it).
 * Every value in SLUG/NAME/ID can be passed to `-p, --project` to run any
 * config-dependent command against that project, e.g.
 * `coding-container --project esuyo-mapping deploy`.
 */
export function listProjects({ projectsFile, json = false } = {}) {
  const file = projectsFile ?? defaultProjectsFile();
  const projects = readProjects(file);
  const entries = computeProjectSlugs(projects);

  if (json) {
    console.log(
      JSON.stringify(
        entries.map(({ project, slug }) => {
          const configPath = String(project?.configPath ?? "");
          let exists = false;
          try {
            exists = configPath ? fs.existsSync(configPath) : false;
          } catch {
            exists = false;
          }
          return {
            slug,
            name: project?.name ?? "",
            id: project?.id ?? "",
            configPath,
            exists,
          };
        }),
        null,
        2
      )
    );
    return;
  }

  if (entries.length === 0) {
    console.log(`No projects registered in ${file}.`);
    return;
  }

  const rows = entries.map(({ project, slug }) => {
    const configPath = String(project?.configPath ?? "-");
    let display = configPath;
    try {
      if (configPath !== "-" && !fs.existsSync(configPath)) display = `${configPath} (missing)`;
    } catch {
      /* keep raw path */
    }
    return {
      slug,
      name: String(project?.name ?? "-"),
      id: String(project?.id ?? "-"),
      config: display,
    };
  });
  const widths = {
    slug: Math.max("SLUG".length, ...rows.map((r) => r.slug.length)),
    name: Math.max("NAME".length, ...rows.map((r) => r.name.length)),
    id: Math.max("ID".length, ...rows.map((r) => r.id.length)),
  };
  const pad = (s, w) => s.padEnd(w, " ");
  console.log(
    `${pad("SLUG", widths.slug)}  ${pad("NAME", widths.name)}  ${pad("ID", widths.id)}  CONFIG`
  );
  for (const r of rows) {
    console.log(`${pad(r.slug, widths.slug)}  ${pad(r.name, widths.name)}  ${pad(r.id, widths.id)}  ${r.config}`);
  }
  console.log(
    `\n${entries.length} project(s) from ${file} (run: coding-container --project <slug|name|id> <command>)`
  );
}
