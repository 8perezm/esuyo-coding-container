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

/**
 * Pod host keys are ephemeral (regenerated on every image build), so there
 * is no point in persisting them. Pointing UserKnownHostsFile at the OS null
 * device means a rebuilt image can never leave a stale key behind to break
 * clients that need forwarding (VS Code Remote-SSH disables forwarding after
 * a host-key change even with StrictHostKeyChecking=no).
 */
export function ephemeralKnownHostsFile() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * Pre-null-device location of a project's host keys. Kept only so commands
 * can clean up the legacy file once.
 */
export function legacyKnownHostsFile(keyDirPath, project) {
  return path.join(keyDirPath, `${project}-known_hosts`);
}

/**
 * Delete the legacy per-project known_hosts file if it exists.
 * Returns true when a file was removed.
 */
export function removeLegacyKnownHostsFile(keyDirPath, project) {
  const file = legacyKnownHostsFile(keyDirPath, project);
  try {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
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

/**
 * Parse one managed Host block (array of raw lines, first is `Host <alias>`)
 * into a structured entry. Unknown keys are ignored; missing keys stay undefined.
 */
function parseHostBlock(alias, lines) {
  const entry = { alias };
  for (const line of lines.slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(.*\S)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "hostname") entry.hostName = value;
    else if (key === "port") entry.port = value;
    else if (key === "user") entry.user = value;
    else if (key === "identityfile") entry.identityFile = value;
    else if (key === "userknownhostsfile") entry.knownHostsFile = value;
    else if (key === "stricthostkeychecking") entry.strictHostKeyChecking = value;
  }
  return entry;
}

/**
 * List the container host entries in the managed section, sorted by alias.
 * Returns [] when the ssh config (or the managed block) is missing.
 * Each entry is { alias, hostName?, port?, user?, identityFile?, ... }.
 */
export function listHostEntries(file = sshConfigPath()) {
  const { entries } = readManaged(file);
  return Object.entries(entries)
    .map(([alias, lines]) => parseHostBlock(alias, lines))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}
