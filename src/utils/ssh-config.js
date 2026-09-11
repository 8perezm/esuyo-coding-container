import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The CLI owns the block between these markers in the user's ~/.ssh/config.
// Everything outside the markers is never touched.
const BEGIN = "# BEGIN coding-container (managed - do not edit between markers)";
const END = "# END coding-container";

export function sshConfigPath() {
  return path.join(os.homedir(), ".ssh", "config");
}

/**
 * Alias convention for container hosts: coding-<project>.
 */
export function sshAlias(project) {
  return `coding-${project}`;
}

function readManaged(file) {
  if (!fs.existsSync(file)) return { before: "", entries: {}, after: "" };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const bi = lines.findIndex((l) => l.trim() === BEGIN);
  if (bi === -1) return { before: lines.join("\n"), entries: {}, after: "" };
  let ei = lines.findIndex((l, i) => i > bi && l.trim() === END);
  if (ei === -1) ei = lines.length;
  const before = lines.slice(0, bi).join("\n");
  const after = lines.slice(ei + 1).join("\n");
  const entries = {};
  let current = null;
  for (const line of lines.slice(bi + 1, ei)) {
    const m = line.match(/^Host (coding-[a-z0-9-]+)\s*$/);
    if (m) {
      current = m[1];
      entries[current] = [line];
    } else if (current && line.trim() !== "") {
      entries[current].push(line);
    } else {
      current = null;
    }
  }
  return { before, entries, after };
}

function writeManaged(file, before, entries, after) {
  const parts = [];
  if (before.trim() !== "") parts.push(before.replace(/\n+$/, ""));
  parts.push(
    [BEGIN, ...Object.values(entries).flat(), END].join("\n")
  );
  if (after.trim() !== "") parts.push(after.replace(/^\n+/, "").replace(/\n+$/, ""));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, parts.join("\n") + "\n");
}

/**
 * Add or update a container host entry in the managed section.
 */
export function addHostEntry(entry, file = sshConfigPath()) {
  const { before, entries, after } = readManaged(file);
  entries[entry.alias] = [
    `Host ${entry.alias}`,
    `    HostName ${entry.hostName}`,
    `    Port ${entry.port}`,
    `    User ${entry.user}`,
    `    IdentityFile ${entry.identityFile}`,
    `    StrictHostKeyChecking no`,
    `    UserKnownHostsFile ${entry.knownHostsFile}`,
  ];
  writeManaged(file, before, entries, after);
}

/**
 * Remove a container host entry. Returns true if an entry was removed.
 */
export function removeHostEntry(alias, file = sshConfigPath()) {
  const { before, entries, after } = readManaged(file);
  if (!(alias in entries)) return false;
  delete entries[alias];
  writeManaged(file, before, entries, after);
  return true;
}
