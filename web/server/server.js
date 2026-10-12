#!/usr/bin/env node
/**
 * Web GUI backend for coding-container.
 *
 * Single-file Node ESM HTTP server (plus web/server/ssh-terminal.js, the
 * browser-terminal WebSocket transport). Only node: builtins + js-yaml and
 * ssh2 (both dependencies).
 *
 *   node web/server/server.js          # reads .env (root), serves the API + SPA
 *
 * Sections:
 *   1. paths & .env handling
 *   2. auth (in-memory sessions, HttpOnly cookie)
 *   3. projects registry (JSON file)
 *   4. structured read endpoints (import src/* directly, never mutate)
 *   5. job runner (spawns `node src/index.js` per op)
 *   6. static SPA serving + CORS
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { loadConfig, imageRef, globalConfigDir, globalConfigPath } from "../../src/config.js";
import { validate } from "../../src/commands/validate.js";
import { listHostEntries } from "../../src/utils/ssh-config.js";
import { ensureKeyPair, readPublicKey } from "../../src/utils/keys.js";
import {
  getSystemConfig,
  kubectlExec,
  resolveDeployTag,
} from "../../src/utils/system-config.js";
import { exec } from "../../src/utils/exec.js";
import { allocateNodePort } from "../../src/utils/project.js";
import { sidecarNodePorts, webPorts } from "../../src/utils/manifest.js";
import { listTags } from "../../src/utils/registry-api.js";
import {
  defaultProjectConfigPath as sharedDefaultProjectConfigPath,
  isManagedConfigPath as sharedIsManagedConfigPath,
  managedProjectsDir as sharedManagedProjectsDir,
  readProjects as sharedReadProjects,
  resolveProjectsFile as sharedResolveProjectsFile,
  resolveStoredConfigPath as sharedResolveStoredConfigPath,
  slugifyProjectName as sharedSlugifyProjectName,
  uniqueManagedConfigPath as sharedUniqueManagedConfigPath,
  writeProjects as sharedWriteProjects,
} from "../../src/utils/projects.js";
import { attachSshTerminal } from "./ssh-terminal.js";

// ---------------------------------------------------------------- paths ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const WEB_DIR = path.join(REPO_ROOT, "web");
export const DIST_DIR = path.join(WEB_DIR, "client", "dist");
// Single environment file (root .env). A legacy web/.env still works as a
// read-only fallback so existing checkouts keep working after the move.
export const ROOT_ENV_FILE = path.join(REPO_ROOT, ".env");
export const LEGACY_WEB_ENV_FILE = path.join(WEB_DIR, ".env");
const CLI_INDEX = path.join(REPO_ROOT, "src", "index.js");

// --------------------------------------------------------------- constants ---

export const SESSION_COOKIE = "gui_session";
const SESSION_TTL_MS = 12 * 3600 * 1000; // 12h
const MAX_JOB_LOG = 200 * 1024; // last 200KB of output per job
const REDACTED = "***REDACTED***";

export const ALLOWED_OPS = [
  "setup",
  "create",
  "build",
  "push",
  "deploy",
  "delete",
  "gc",
  "system-init",
  "system-create",
  "system-rollback",
  "system-gc",
  "list-update",
  "key-rotate",
];

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

// ------------------------------------------------------------ .env parsing ---

/**
 * Minimal KEY=VALUE parser. Ignores empty lines and lines whose first
 * non-space character is '#'. Strips one layer of surrounding single or
 * double quotes from values. Inline '#' is kept (passwords may contain it).
 */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Registry location: an explicit PROJECTS_FILE wins (absolute, or relative
// to the repo root for dev checkouts); otherwise the registry lives next to
// the global config, so every GUI on this machine (dev server, desktop app)
// shares one store. Shared with the CLI (src/utils/projects.js).
function resolveProjectsFile(raw) {
  return sharedResolveProjectsFile(raw);
}

/**
 * Persist a new ADMIN_PASSWORD to the .env file, preserving all other
 * lines and comments. Returns { persisted, warning } — persisted is false
 * when a real ADMIN_PASSWORD environment variable overrides the file (the
 * file is still updated, but a restart would restore the env value).
 */
export function updateEnvFilePassword(envFile, newPassword) {
  const target = envFile || ROOT_ENV_FILE;
  let raw = "";
  try {
    raw = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  } catch (err) {
    throw new Error(`cannot read env file: ${err.message}`);
  }
  const lines = String(raw).split(/\r?\n/);
  let updated = false;
  const next = lines.map((line) => {
    if (/^\s*ADMIN_PASSWORD\s*=/.test(line)) {
      updated = true;
      return `ADMIN_PASSWORD=${newPassword}`;
    }
    return line;
  });
  if (!updated) {
    if (next.length === 1 && next[0] === "") next[0] = `ADMIN_PASSWORD=${newPassword}`;
    else next.push(`ADMIN_PASSWORD=${newPassword}`);
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${next.join("\n").replace(/\n+$/, "\n")}`);
  } catch (err) {
    throw new Error(`cannot write env file: ${err.message}`);
  }
  if (process.env.ADMIN_PASSWORD !== undefined && process.env.ADMIN_PASSWORD !== "") {
    return {
      persisted: false,
      warning: "ADMIN_PASSWORD environment variable overrides .env — change applies until restart",
    };
  }
  return { persisted: true };
}

/** Validate a password change; returns an error message or null when OK. */
export function validatePasswordChange(currentPassword, newPassword) {
  if (typeof currentPassword !== "string" || !currentPassword) return "current password is required";
  if (typeof newPassword !== "string" || !newPassword) return "new password is required";
  if (newPassword.length < 8) return "new password must be at least 8 characters";
  if (newPassword === currentPassword) return "new password must be different";
  return null;
}

/**
 * Server config: .env file values, with real environment variables
 * taking precedence (so containers can override without editing the file).
 * A legacy web/.env fills in keys missing from the root .env.
 */
export function loadEnvConfig() {
  const readFile = (p) => {
    if (!fs.existsSync(p)) return {};
    try {
      return parseDotEnv(fs.readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  };
  const fromFile = { ...readFile(LEGACY_WEB_ENV_FILE), ...readFile(ROOT_ENV_FILE) };
  const get = (key, fallback = "") => process.env[key] ?? fromFile[key] ?? fallback;
  const port = Number.parseInt(get("PORT", "3401"), 10);
  const projectsFile = resolveProjectsFile(get("PROJECTS_FILE", ""));
  const authRaw = get("AUTH_FILE", "").trim();
  return {
    adminEmail: get("ADMIN_EMAIL", ""),
    adminPassword: get("ADMIN_PASSWORD", ""),
    port: Number.isInteger(port) && port > 0 ? port : 3401,
    projectsFile,
    authFile: authRaw
      ? path.isAbsolute(authRaw)
        ? authRaw
        : path.join(REPO_ROOT, authRaw)
      : defaultAuthFile(projectsFile),
    allowedOrigin: get("ALLOWED_ORIGIN", "").trim(),
    envFile: ROOT_ENV_FILE,
  };
}

// ------------------------------------------------------------------ sessions ---

// token -> { email, expiresAt }
const sessions = new Map();

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function issueSession(email) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { email, expiresAt: Date.now() + SESSION_TTL_MS });
  if (sessions.size % 50 === 0) pruneSessions();
  return token;
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, sess] of sessions) {
    if (sess.expiresAt <= now) sessions.delete(token);
  }
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  if (sess.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { ...sess, token };
}

function sessionCookieHeader(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

// ------------------------------------------------------------ auth store ---
// Single-user credential, hash at rest. Lives next to the projects registry
// (per-machine, gitignored): <dir-of-projectsFile>/auth.json by default,
// AUTH_FILE overrides. Shape: { email, salt, hash, N, r, p, keylen } with
// node:crypto scrypt. Deleting the file resets to unregistered.

export const AUTH_SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function defaultAuthFile(projectsFile) {
  const base = projectsFile ? path.dirname(projectsFile) : os.tmpdir();
  return path.join(base, "auth.json");
}

/** Validate registration / email+password input; returns an error or null. */
export function validateAuthInput(email, password) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return "Enter a valid email address.";
  }
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  return null;
}

export function hashAuthPassword(password, saltHex) {
  const salt = saltHex ?? crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), Buffer.from(salt, "hex"), AUTH_SCRYPT.keylen, {
    N: AUTH_SCRYPT.N,
    r: AUTH_SCRYPT.r,
    p: AUTH_SCRYPT.p,
  });
  return {
    salt,
    hash: derived.toString("hex"),
    N: AUTH_SCRYPT.N,
    r: AUTH_SCRYPT.r,
    p: AUTH_SCRYPT.p,
    keylen: AUTH_SCRYPT.keylen,
  };
}

export function verifyAuthPassword(record, password) {
  try {
    if (!record || typeof record.salt !== "string" || typeof record.hash !== "string") return false;
    if (typeof password !== "string" || !password) return false;
    const N = Number(record.N) || AUTH_SCRYPT.N;
    const r = Number(record.r) || AUTH_SCRYPT.r;
    const p = Number(record.p) || AUTH_SCRYPT.p;
    const keylen = Number(record.keylen) || AUTH_SCRYPT.keylen;
    const derived = crypto.scryptSync(String(password), Buffer.from(record.salt, "hex"), keylen, {
      N,
      r,
      p,
    });
    const expected = Buffer.from(record.hash, "hex");
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function readAuthRecord(authFile) {
  try {
    if (!authFile || !fs.existsSync(authFile)) return null;
    const data = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (!data || typeof data.email !== "string" || !data.email.trim()) return null;
    if (typeof data.salt !== "string" || typeof data.hash !== "string") return null;
    return { ...data, email: data.email.trim() };
  } catch {
    return null;
  }
}

export function writeAuthRecord(authFile, email, password) {
  const invalid = validateAuthInput(email, password);
  if (invalid) throw new Error(invalid);
  const cleanEmail = String(email).trim();
  const sealed = { email: cleanEmail, ...hashAuthPassword(password) };
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(authFile, 0o600);
  } catch {
    // Best effort (Windows ACLs may ignore mode bits).
  }
  return sealed;
}

/** Remove plaintext ADMIN_PASSWORD lines from a .env file (migration cleanup). */
export function stripEnvPasswordLine(envFile) {
  try {
    if (!envFile || !fs.existsSync(envFile)) return false;
    const raw = fs.readFileSync(envFile, "utf8");
    const lines = String(raw).split(/\r?\n/);
    const next = lines.filter((line) => !/^\s*ADMIN_PASSWORD\s*=/.test(line));
    if (next.length === lines.length) return false;
    fs.writeFileSync(envFile, `${next.join("\n").replace(/\n+$/, "\n")}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective credential: the auth file wins; otherwise legacy
 * ADMIN_EMAIL/ADMIN_PASSWORD from env/.env. Returns
 * { type: "file", record } | { type: "legacy", email } | { type: "none" }.
 */
export function getEffectiveAuth(env) {
  const record = readAuthRecord(env?.authFile);
  if (record) return { type: "file", record };
  const email = String(env?.adminEmail ?? "").trim();
  const password = env?.adminPassword ?? "";
  if (email && typeof password === "string" && password) return { type: "legacy", email };
  return { type: "none" };
}

/** True when the request arrived over loopback (registration allowed). */
export function isLoopbackReq(req) {
  const raw = req?.socket?.remoteAddress ?? "";
  const normalized = String(raw).replace(/^::ffff:/i, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function clearAllSessions() {
  sessions.clear();
}

/**
 * One-time migration: legacy ADMIN_EMAIL/ADMIN_PASSWORD -> hashed auth file.
 * Strips the plaintext password line from .env on success (best effort).
 * Returns true when a record now exists (already had one or just migrated).
 */
export function migrateLegacyToAuthFile(env) {
  try {
    if (readAuthRecord(env?.authFile)) return true;
    const email = String(env?.adminEmail ?? "").trim();
    const password = env?.adminPassword ?? "";
    if (!email || typeof password !== "string" || !password) return false;
    if (validateAuthInput(email, password)) return false;
    writeAuthRecord(env.authFile, email, password);
    stripEnvPasswordLine(env.envFile);
    if (env) env.adminPassword = "";
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- projects registry ---

export function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

export function readProjects(projectsFile) {
  return sharedReadProjects(projectsFile);
}

export function writeProjects(projectsFile, projects) {
  return sharedWriteProjects(projectsFile, projects);
}

/**
 * One-time carry-over from the legacy dev registry (web/projects.json) into
 * the shared store. Copies entries verbatim, resolving relative config paths
 * against the repo root they were stored from. Best effort: any failure (or
 * an empty legacy file) leaves the target untouched. Returns true when
 * entries were migrated.
 */
export function migrateProjectsFile(targetFile, legacyFile) {
  try {
    if (fs.existsSync(targetFile)) return false;
    if (!fs.existsSync(legacyFile)) return false;
    const data = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    if (!Array.isArray(data) || data.length === 0) return false;
    const migrated = data
      .filter((p) => p && typeof p === "object" && !Array.isArray(p))
      .map((p) => {
        const entry = { ...p };
        const raw = typeof entry.configPath === "string" ? entry.configPath.trim() : "";
        if (raw && !path.isAbsolute(raw)) entry.configPath = path.resolve(REPO_ROOT, raw);
        return entry;
      });
    if (migrated.length === 0) return false;
    writeProjects(targetFile, migrated);
    return true;
  } catch {
    return false;
  }
}

/** On startup, an empty registry auto-registers a starter project. The
 * config is a personal copy under the global dir — never the repo/bundle
 * template, whose path is neither writable nor stable in installs. */
export function ensureDefaultProject(projectsFile) {
  const projects = readProjects(projectsFile);
  if (projects.length === 0) {
    let configPath = path.join(REPO_ROOT, "config.yaml");
    try {
      const seed = path.join(globalConfigDir(), "projects", "my-project", "config.yaml");
      if (!fs.existsSync(seed)) {
        fs.mkdirSync(path.dirname(seed), { recursive: true });
        fs.copyFileSync(configPath, seed);
      }
      configPath = seed;
    } catch {
      // Fall back to the template itself.
    }
    projects.push({
      id: newId(),
      name: "my-project",
      configPath,
    });
    writeProjects(projectsFile, projects);
  }
  return projects;
}

function findProject(projectsFile, projectId) {
  return readProjects(projectsFile).find((p) => p.id === projectId) ?? null;
}

function resolveStoredConfigPath(configPath) {
  return sharedResolveStoredConfigPath(configPath);
}

/**
 * Filesystem + k8s-safe slug from a display name (DNS-1123 label style).
 * Mirrors deriveProjectName(): lowercase, non [a-z0-9-] -> "-", collapse,
 * trim dashes, cap at 63 chars, fallback to "project".
 * Shared with the CLI (src/utils/projects.js).
 */
export function slugifyProjectName(name) {
  return sharedSlugifyProjectName(name);
}

/** Folder holding auto-managed per-project configs: <globalDir>/projects. */
export function managedProjectsDir() {
  return sharedManagedProjectsDir();
}

/** Default config file for an auto-managed project slug. */
export function defaultProjectConfigPath(slug) {
  return sharedDefaultProjectConfigPath(slug);
}

/**
 * True when configPath lives inside the managed projects dir (i.e. it was
 * auto-assigned, not a user-supplied custom path). Such paths follow renames.
 */
export function isManagedConfigPath(configPath) {
  return sharedIsManagedConfigPath(configPath);
}

/**
 * Unique managed config path for a base slug. Suffixes -2, -3, ... while the
 * candidate is taken by another registry entry (excluding excludeId) or an
 * existing file on disk (e.g. leftovers from a removed entry).
 */
export function uniqueManagedConfigPath(projects, baseSlug, excludeId = null) {
  return sharedUniqueManagedConfigPath(projects, baseSlug, excludeId);
}

/**
 * Starter YAML for a new project, modelled on a realistic app + postgres
 * sidecar setup. Interpolated values (slug + free NodePorts) validate;
 * hosts/password are clearly-marked placeholders the user must edit.
 */
export function buildStarterYaml({ slug, mainNodePort, dbNodePort }) {
  const safeSlug = slugifyProjectName(slug);
  const main = Number.isInteger(mainNodePort) ? mainNodePort : 30022;
  const db = Number.isInteger(dbNodePort) && dbNodePort !== main ? dbNodePort : 30432;
  return `# Starter config for "${safeSlug}". Edit hosts/passwords, then Save.
# Shared settings (registry, image build, k8s, nfs, ssh) come from the
# global config; add keys here only for values that differ per project.

project: ${safeSlug}

k8s:
  nodePort: ${main}
  sidecars:
    - name: postgres
      image: postgres:18.6
      env:
        POSTGRES_USER: ${safeSlug}
        POSTGRES_DB: ${safeSlug}
        POSTGRES_PASSWORD: ${safeSlug}
        POSTGRES_HOST_AUTH_METHOD: trust
      ports:
        - { containerPort: 5432, name: postgres, nodePort: ${db} }
      volumeMounts: # persist the data on the NAS workspace
        - name: workspace
          mountPath: /var/lib/postgresql
          subPath: postgres/${safeSlug}
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits: { cpu: "1", memory: 1Gi }

# One Ingress rule per host, each routing to that port on this project's
# service. Hosts must resolve (DNS) to your Traefik LoadBalancer IP.
# These are placeholders — replace example.com with your own domain.
web:
  ports:
    - { port: 3000, host: app-${safeSlug}.example.com }
    - { port: 3001, host: api-${safeSlug}.example.com }
`;
}

// ------------------------------------------------------ config redaction ---

/** Clone a loaded config with every k8s.secretEnv value redacted. */
export function redactConfig(cfg) {
  const copy = structuredClone(cfg);
  const secretEnv = copy?.k8s?.secretEnv;
  if (secretEnv && typeof secretEnv === "object" && !Array.isArray(secretEnv)) {
    for (const key of Object.keys(secretEnv)) {
      if (secretEnv[key] != null) secretEnv[key] = REDACTED;
    }
  }
  return copy;
}

// ----------------------------------------------------------- ssh sorting ---
// Same ordering as `list` in src/commands/list.js: host (IPv4-aware), then
// port, then alias. Missing values sort last.

function compareIpv4(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function compareHost(a, b) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (IPV4.test(a) && IPV4.test(b)) {
    const diff = compareIpv4(a, b);
    if (diff !== 0) return diff;
  } else {
    const diff = String(a).localeCompare(String(b));
    if (diff !== 0) return diff;
  }
  return 0;
}

function comparePort(a, b) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isInteger(na) && Number.isInteger(nb) && na !== nb) return na - nb;
  if (a !== b) return String(a).localeCompare(String(b));
  return 0;
}

function compareByHostPort(a, b) {
  const ha = a.host ?? a.hostName;
  const hb = b.host ?? b.hostName;
  return (
    compareHost(ha, hb) || comparePort(a.port, b.port) || String(a.alias).localeCompare(String(b.alias))
  );
}

export function sortSshEntries(entries) {
  return [...entries].sort(compareByHostPort);
}

// ------------------------------------------------------------ cluster live ---

/** Run kubectl with JSON output and parse it. Throws on kubectl failure. */
export function kubectlJson(kubectlArgs) {
  const { cmd, args, opts } = kubectlExec();
  const out = exec(cmd, [...args, ...kubectlArgs], opts);
  return JSON.parse(out || "{}");
}

// ------------------------------------------------------- cluster cache ---
// Short-TTL in-memory cache so the dashboard's parallel page requests
// (nodes + ports + workloads fired at once, polling every 15s) share one
// set of kubectl results instead of spawning dozens of processes per load.
// Only successful snapshots are cached; kubectl failures retry next time.

export const CLUSTER_CACHE_TTL_MS = (() => {
  const raw = Number.parseInt(process.env.CLUSTER_CACHE_TTL_MS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 5000;
})();

const clusterCache = new Map();

export function clearClusterCache() {
  clusterCache.clear();
}

function readClusterCache(key) {
  const hit = clusterCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    clusterCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeClusterCache(key, value) {
  clusterCache.set(key, { expiresAt: Date.now() + CLUSTER_CACHE_TTL_MS, value });
}

/** Cache a cluster snapshot loader. Loader must return (not throw). */
export function getCachedCluster(key, loader) {
  const hit = readClusterCache(key);
  if (hit !== null) return hit;
  const value = loader();
  writeClusterCache(key, value);
  return value;
}

function projectsFingerprint(projects) {
  try {
    return (projects ?? []).map((p) => `${p?.id ?? ""}:${p?.configPath ?? ""}`).join("|");
  } catch {
    return "";
  }
}

/**
 * Parse `kubectl top nodes --no-headers` output.
 * Each line: NAME CPU(cores) CPU% MEMORY(bytes) MEMORY%.
 * Returns Map name -> { cpu, cpuPercent, memory, memoryPercent }.
 */
export function parseTopNodes(text) {
  const map = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 5) continue;
    const [name, cpu, cpuPct, memory, memPct] = parts;
    map.set(name, {
      cpu,
      cpuPercent: Number.parseInt(cpuPct, 10),
      memory,
      memoryPercent: Number.parseInt(memPct, 10),
    });
  }
  return map;
}

/**
 * Parse `kubectl top pods --no-headers` output.
 * Each line: NAME CPU(cores) MEMORY(bytes).
 * Returns Map name -> { cpu, memory }.
 */
export function parseTopPods(text) {
  const map = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) continue;
    const [name, cpu, memory] = parts;
    map.set(name, { cpu, memory });
  }
  return map;
}

/**
 * Parse `kubectl top pods -A --no-headers` output.
 * Each line: NAMESPACE NAME CPU(cores) MEMORY(bytes).
 * Returns Map "namespace/name" -> { cpu, memory }. Also accepts the
 * 3-column single-namespace form (handled by parseTopPods callers).
 */
export function parseTopPodsAll(text) {
  const map = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) continue;
    if (parts.length >= 4) {
      const [ns, name, cpu, memory] = parts;
      if (ns && name) map.set(`${ns}/${name}`, { cpu, memory });
    } else {
      const [name, cpu, memory] = parts;
      map.set(name, { cpu, memory });
    }
  }
  return map;
}

/**
 * One batched snapshot for the whole dashboard: ~5 kubectl calls total no
 * matter how many projects/nodes exist. Each list degrades to empty on
 * failure so one missing API (e.g. metrics-server) never blanks the rest.
 */
function fetchClusterSnapshot() {
  const snap = {
    nodesJson: null,
    nodesError: null,
    servicesJson: null,
    servicesError: null,
    deploymentsJson: null,
    deploymentsError: null,
    podsJson: null,
    podsError: null,
    topNodes: new Map(),
    metricsAvailable: true,
    topPodsAll: new Map(),
    podMetricsAvailable: true,
  };
  try {
    snap.nodesJson = kubectlJson(["get", "nodes", "-o", "json"]);
  } catch (err) {
    snap.nodesError = err?.message ?? "nodes query failed";
  }
  try {
    snap.servicesJson = kubectlJson(["get", "svc", "-A", "-o", "json"]);
  } catch (err) {
    snap.servicesError = err?.message ?? "services query failed";
  }
  try {
    snap.deploymentsJson = kubectlJson([
      "get",
      "deploy",
      "-A",
      "-l",
      "coding-container=true",
      "-o",
      "json",
    ]);
  } catch (err) {
    snap.deploymentsError = err?.message ?? "deployments query failed";
  }
  try {
    snap.podsJson = kubectlJson(["get", "pods", "-A", "-l", "coding-container=true", "-o", "json"]);
  } catch (err) {
    snap.podsError = err?.message ?? "pods query failed";
  }
  try {
    const { cmd, args, opts } = kubectlExec();
    const out = exec(cmd, [...args, "top", "nodes", "--no-headers"], opts);
    snap.topNodes = parseTopNodes(out);
  } catch {
    snap.metricsAvailable = false;
  }
  try {
    const { cmd, args, opts } = kubectlExec();
    const out = exec(cmd, [...args, "top", "pods", "-A", "--no-headers"], opts);
    snap.topPodsAll = parseTopPodsAll(out);
  } catch {
    snap.podMetricsAvailable = false;
  }
  return snap;
}

function nodeReady(node) {
  const conds = node?.status?.conditions ?? [];
  const ready = conds.find((c) => c.type === "Ready");
  return ready?.status === "True";
}

function countPodsByNode(podsJson) {
  const counts = new Map();
  for (const pod of podsJson?.items ?? []) {
    const node = pod?.spec?.nodeName;
    if (!node) continue;
    counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return counts;
}

function buildNodesList(nodesJson, usage, podCounts) {
  const items = Array.isArray(nodesJson?.items) ? nodesJson.items : [];
  return items.map((n) => {
    const name = n?.metadata?.name ?? "";
    const live = usage.get(name) ?? null;
    return {
      name,
      ready: nodeReady(n),
      cpuCapacity: n?.status?.capacity?.cpu ?? null,
      cpuAllocatable: n?.status?.allocatable?.cpu ?? null,
      memoryCapacity: n?.status?.capacity?.memory ?? null,
      memoryAllocatable: n?.status?.allocatable?.memory ?? null,
      pods: podCounts !== null ? (podCounts.get(name) ?? 0) : null,
      kubelet: n?.status?.nodeInfo?.kubeletVersion ?? null,
      osImage: n?.status?.nodeInfo?.osImage ?? null,
      arch: n?.status?.nodeInfo?.architecture ?? null,
      createdAt: n?.metadata?.creationTimestamp ?? null,
      cpu: live?.cpu ?? null,
      cpuPercent: live?.cpuPercent ?? null,
      memory: live?.memory ?? null,
      memoryPercent: live?.memoryPercent ?? null,
    };
  });
}

function queryPodCountForNode(name) {
  try {
    const { cmd, args, opts } = kubectlExec();
    const out = exec(
      cmd,
      [...args, "get", "pods", "--all-namespaces", "--field-selector", `spec.nodeName=${name}`, "-o", "json"],
      opts
    );
    return (JSON.parse(out || "{}").items ?? []).length;
  } catch {
    return null;
  }
}

/** Cluster nodes with capacity + live usage (when metrics-server exists). */
export function getClusterNodes() {
  const data = kubectlJson(["get", "nodes", "-o", "json"]);
  let usage = new Map();
  let metricsAvailable = true;
  try {
    const { cmd, args, opts } = kubectlExec();
    const out = exec(cmd, [...args, "top", "nodes", "--no-headers"], opts);
    usage = parseTopNodes(out);
  } catch {
    metricsAvailable = false;
  }
  // One batched pod list for all node counts (was N per-node queries).
  let podCounts = null;
  try {
    const podsJson = kubectlJson(["get", "pods", "-A", "-o", "json"]);
    podCounts = countPodsByNode(podsJson);
  } catch {
    podCounts = null;
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  const nodes = buildNodesList(data, usage, podCounts).map((n) => {
    if (n.pods !== null) return n;
    // Fallback for clusters/stubs where the batched list is unavailable.
    return { ...n, pods: queryPodCountForNode(n.name) };
  });
  void items;
  return { nodes, metricsAvailable };
}

export function buildNodesFromSnapshot(snap) {
  if (snap.nodesError) throw new Error(snap.nodesError);
  const podCounts = snap.podsError ? null : countPodsByNode(snap.podsJson ?? { items: [] });
  // Snapshot pod list is label-filtered; fall back to per-node counts only
  // when the snapshot has no usable pod data at all.
  const nodes = buildNodesList(snap.nodesJson, snap.topNodes, podCounts);
  if (podCounts === null) {
    return {
      nodes: nodes.map((n) => ({ ...n, pods: queryPodCountForNode(n.name) })),
      metricsAvailable: snap.metricsAvailable,
    };
  }
  return { nodes, metricsAvailable: snap.metricsAvailable };
}

/** Every NodePort allocated cluster-wide (ports in use). */
export function getClusterPorts() {
  const data = kubectlJson(["get", "svc", "-A", "-o", "json"]);
  return buildPortsFromJson(data);
}

export function buildPortsFromJson(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const ports = [];
  for (const svc of items) {
    const namespace = svc?.metadata?.namespace ?? "";
    const service = svc?.metadata?.name ?? "";
    for (const p of svc?.spec?.ports ?? []) {
      if (p?.nodePort === undefined || p?.nodePort === null) continue;
      ports.push({
        namespace,
        service,
        name: p.name ?? "",
        port: p.port ?? null,
        targetPort: p.targetPort ?? null,
        nodePort: p.nodePort,
        protocol: p.protocol ?? "TCP",
      });
    }
  }
  ports.sort((a, b) => a.nodePort - b.nodePort);
  return { ports };
}

export function buildPortsFromSnapshot(snap) {
  if (snap.servicesError) throw new Error(snap.servicesError);
  return buildPortsFromJson(snap.servicesJson);
}

/**
 * Configured ports for one loaded project config (what the dashboard shows
 * per project even when nothing is deployed yet).
 */
export function configuredPorts(cfg) {
  return {
    sshNodePort: cfg?.k8s?.nodePort ?? null,
    sshPort: cfg?.ssh?.port ?? null,
    web: webPorts(cfg).map((p) => ({
      name: p.name,
      port: p.port,
      hosts: p.hosts,
      nodePort: p.nodePort ?? null,
    })),
    sidecars: sidecarNodePorts(cfg).map((p) => ({
      name: p.name,
      port: p.port,
      nodePort: p.nodePort,
    })),
    nodeName: cfg?.k8s?.nodeName || null,
  };
}

/**
 * Every NodePort this config wants: [{ nodePort, label }].
 * Label says which setting it comes from (ssh / web port / sidecar).
 */
export function wantedNodePorts(cfg) {
  const ports = configuredPorts(cfg);
  const wanted = [];
  if (Number.isInteger(ports.sshNodePort)) wanted.push({ nodePort: ports.sshNodePort, label: "ssh" });
  for (const w of ports.web ?? []) {
    if (Number.isInteger(w.nodePort)) wanted.push({ nodePort: w.nodePort, label: `web port ${w.port}` });
  }
  for (const s of ports.sidecars ?? []) {
    if (Number.isInteger(s.nodePort)) wanted.push({ nodePort: s.nodePort, label: `sidecar ${s.name}` });
  }
  return wanted;
}

/**
 * NodePorts this config wants that are already held by *other* services on
 * the cluster. Ports held by the project's own Service (<project> in
 * <namespace>) are ignored, so re-validating a deployed project doesn't flag
 * itself. Pure: `live` is the result of getClusterPorts().
 * Returns [{ nodePort, label, service, namespace }].
 */
export function findTakenNodePorts(cfg, live) {
  const namespace = cfg?.k8s?.namespace;
  const ownService = cfg?.project;
  const livePorts = Array.isArray(live?.ports) ? live.ports : [];
  const taken = [];
  for (const w of wantedNodePorts(cfg)) {
    const holder = livePorts.find(
      (p) => p.nodePort === w.nodePort && !(p.namespace === namespace && p.service === ownService)
    );
    if (holder) taken.push({ ...w, service: holder.service, namespace: holder.namespace });
  }
  return taken;
}

/**
 * NodePorts in `wanted` that are also claimed by other projects' saved
 * configs (even inactive ones with nothing on the cluster).
 * `others` is [{ name, wanted: [{ nodePort, label }] }].
 * Returns [{ nodePort, label, project, projectLabel }].
 */
export function findClaimedNodePorts(wanted, others) {
  const claimed = [];
  for (const w of wanted ?? []) {
    for (const o of others ?? []) {
      const hit = (o.wanted ?? []).find((x) => x.nodePort === w.nodePort);
      if (hit) claimed.push({ ...w, project: o.name, projectLabel: hit.label });
    }
  }
  return claimed;
}

function blankWorkloadEntry(p) {
  return {
    projectId: p?.id ?? null,
    name: p?.name ?? "",
    namespace: null,
    project: null,
    deployed: false,
    ready: null,
    replicas: null,
    pods: [],
    servicePorts: [],
    configuredPorts: null,
    resources: null,
    image: null,
    nodeName: null,
    metricsAvailable: true,
    error: null,
  };
}

function loadWorkloadConfig(p, entry, tagCache) {
  const resolved = resolveStoredConfigPath(p?.configPath);
  const cfg = loadConfig(resolved);
  entry.namespace = cfg.k8s.namespace;
  entry.project = cfg.project;
  entry.configuredPorts = configuredPorts(cfg);
  entry.resources = cfg.k8s.resources ?? null;
  entry.nodeName = cfg.k8s.nodeName || null;
  try {
    // System ConfigMap read is per namespace; namespaces usually repeat, so
    // cache the tag within one dashboard refresh (was 1 kubectl per project).
    const ns = cfg.k8s.namespace;
    if (!tagCache.has(ns)) {
      try {
        tagCache.set(ns, resolveDeployTag(cfg));
      } catch {
        tagCache.set(ns, null);
      }
    }
    const tag = tagCache.get(ns);
    // resolveDeployTag used the cfg instance above; reuse its tag only when
    // it matches this project's namespace cache. Fall back per project when
    // namespaces differ (cheap: no kubectl, tag already resolved or null).
    if (tag) {
      cfg.image.tag = tag;
      entry.image = imageRef(cfg);
    } else {
      try {
        cfg.image.tag = resolveDeployTag(cfg);
        entry.image = imageRef(cfg);
      } catch {
        entry.image = null;
      }
    }
  } catch {
    entry.image = null;
  }
  return cfg;
}

function fillWorkloadFromObjects(entry, cfg, { deploy, pods, podUsage, svc, metricsAvailable }) {
  if (!deploy) return entry;
  entry.deployed = true;
  entry.replicas = {
    replicas: deploy?.spec?.replicas ?? null,
    ready: deploy?.status?.readyReplicas ?? 0,
    updated: deploy?.status?.updatedReplicas ?? 0,
    available: deploy?.status?.availableReplicas ?? 0,
  };
  entry.ready =
    (deploy?.status?.readyReplicas ?? 0) > 0 &&
    (deploy?.status?.readyReplicas ?? 0) >= (deploy?.spec?.replicas ?? 1);
  entry.metricsAvailable = metricsAvailable;
  const ns = cfg.k8s.namespace;
  entry.pods = (pods ?? []).map((pod) => {
    const podName = pod?.metadata?.name ?? "";
    const podNs = pod?.metadata?.namespace ?? ns;
    const live =
      podUsage.get(`${podNs}/${podName}`) ?? podUsage.get(podName) ?? null;
    const statuses = pod?.status?.containerStatuses ?? [];
    const restarts = statuses.reduce((sum, s) => sum + (s?.restartCount ?? 0), 0);
    return {
      name: podName,
      phase: pod?.status?.phase ?? null,
      ready: (statuses.filter((s) => s?.ready).length ?? 0) + "/" + (statuses.length ?? 0),
      restarts,
      node: pod?.spec?.nodeName ?? null,
      cpu: live?.cpu ?? null,
      memory: live?.memory ?? null,
      createdAt: pod?.metadata?.creationTimestamp ?? null,
    };
  });
  try {
    entry.servicePorts = (svc?.spec?.ports ?? []).map((sp) => ({
      name: sp?.name ?? "",
      port: sp?.port ?? null,
      targetPort: sp?.targetPort ?? null,
      nodePort: sp?.nodePort ?? null,
      protocol: sp?.protocol ?? "TCP",
    }));
  } catch {
    entry.servicePorts = [];
  }
  return entry;
}

function querySingleWorkload(entry, cfg) {
  const ns = cfg.k8s.namespace;
  const name = cfg.project;
  let deploy = null;
  try {
    deploy = kubectlJson(["get", "deployment", name, "-n", ns, "-o", "json"]);
  } catch {
    return entry;
  }
  let podUsage = new Map();
  let metricsAvailable = true;
  try {
    const { cmd, args, opts } = kubectlExec();
    const top = exec(
      cmd,
      [...args, "top", "pods", "-l", `app=${name}`, "-n", ns, "--no-headers"],
      opts
    );
    podUsage = parseTopPods(top);
  } catch {
    metricsAvailable = false;
  }
  let pods = [];
  try {
    const data = kubectlJson(["get", "pods", "-l", `app=${name}`, "-n", ns, "-o", "json"]);
    pods = Array.isArray(data?.items) ? data.items : [];
  } catch {
    pods = [];
  }
  let svc = null;
  try {
    svc = kubectlJson(["get", "svc", name, "-n", ns, "-o", "json"]);
  } catch {
    svc = null;
  }
  return fillWorkloadFromObjects(entry, cfg, { deploy, pods, podUsage, svc, metricsAvailable });
}

/**
 * Live per-project workload status for every registered project.
 * Never throws for a single project: failures degrade to { deployed: false }.
 * Batched: 3 list calls shared across projects (+ metrics), with per-project
 * fallback when the batch list is unavailable (old stubs, RBAC).
 */
export function getWorkloadsStatus(projects) {
  const list = projects ?? [];
  const entries = list.map(blankWorkloadEntry);
  const cfgs = new Array(list.length).fill(null);
  const tagCache = new Map();
  for (let i = 0; i < list.length; i++) {
    try {
      cfgs[i] = loadWorkloadConfig(list[i], entries[i], tagCache);
    } catch (err) {
      entries[i].error = err?.message ?? "cannot load config";
    }
  }
  const needCluster = cfgs.some(Boolean);
  if (!needCluster) return { workloads: entries };

  let batchUsable = true;
  let deploysByKey = new Map();
  let podsByKey = new Map();
  let svcsByKey = new Map();
  let topAll = new Map();
  let podMetricsAvailable = true;
  try {
    const deploys = kubectlJson(["get", "deploy", "-A", "-l", "coding-container=true", "-o", "json"]);
    for (const d of deploys?.items ?? []) {
      deploysByKey.set(`${d?.metadata?.namespace ?? ""}/${d?.metadata?.name ?? ""}`, d);
    }
  } catch {
    batchUsable = false;
  }
  try {
    const podsJson = kubectlJson(["get", "pods", "-A", "-l", "coding-container=true", "-o", "json"]);
    for (const pod of podsJson?.items ?? []) {
      const app = pod?.metadata?.labels?.app ?? "";
      const key = `${pod?.metadata?.namespace ?? ""}/${app}`;
      if (!podsByKey.has(key)) podsByKey.set(key, []);
      podsByKey.get(key).push(pod);
    }
  } catch {
    batchUsable = false;
  }
  try {
    const svcs = kubectlJson(["get", "svc", "-A", "-o", "json"]);
    for (const s of svcs?.items ?? []) {
      svcsByKey.set(`${s?.metadata?.namespace ?? ""}/${s?.metadata?.name ?? ""}`, s);
    }
  } catch {
    batchUsable = false;
  }
  try {
    const { cmd, args, opts } = kubectlExec();
    const out = exec(cmd, [...args, "top", "pods", "-A", "--no-headers"], opts);
    topAll = parseTopPodsAll(out);
  } catch {
    podMetricsAvailable = false;
  }

  for (let i = 0; i < list.length; i++) {
    const cfg = cfgs[i];
    if (!cfg) continue;
    try {
      const ns = cfg.k8s.namespace;
      const name = cfg.project;
      if (batchUsable) {
        fillWorkloadFromObjects(entries[i], cfg, {
          deploy: deploysByKey.get(`${ns}/${name}`) ?? null,
          pods: podsByKey.get(`${ns}/${name}`) ?? [],
          podUsage: topAll,
          svc: svcsByKey.get(`${ns}/${name}`) ?? null,
          metricsAvailable: podMetricsAvailable,
        });
        // Batch listed nothing for this project while the cluster answered:
        // fall back to the direct per-project query (e.g. objects without
        // the shared label, or a stub pretending empty lists).
        if (!entries[i].deployed) {
          const direct = querySingleWorkload(blankWorkloadEntry(list[i]), cfg);
          // Preserve config-derived fields already loaded above.
          entries[i].deployed = direct.deployed;
          entries[i].replicas = direct.replicas;
          entries[i].ready = direct.ready;
          entries[i].pods = direct.pods;
          entries[i].servicePorts = direct.servicePorts;
          entries[i].metricsAvailable = direct.metricsAvailable;
        }
      } else {
        querySingleWorkload(entries[i], cfg);
      }
    } catch (err) {
      entries[i].error = err?.message ?? "cluster query failed";
    }
  }
  return { workloads: entries };
}

export function buildWorkloadsFromSnapshot(projects, snap) {
  const list = projects ?? [];
  const entries = list.map(blankWorkloadEntry);
  const cfgs = new Array(list.length).fill(null);
  const tagCache = new Map();
  for (let i = 0; i < list.length; i++) {
    try {
      cfgs[i] = loadWorkloadConfig(list[i], entries[i], tagCache);
    } catch (err) {
      entries[i].error = err?.message ?? "cannot load config";
    }
  }
  const deploysByKey = new Map();
  for (const d of snap.deploymentsJson?.items ?? []) {
    deploysByKey.set(`${d?.metadata?.namespace ?? ""}/${d?.metadata?.name ?? ""}`, d);
  }
  const podsByKey = new Map();
  for (const pod of snap.podsJson?.items ?? []) {
    const app = pod?.metadata?.labels?.app ?? "";
    const key = `${pod?.metadata?.namespace ?? ""}/${app}`;
    if (!podsByKey.has(key)) podsByKey.set(key, []);
    podsByKey.get(key).push(pod);
  }
  const svcsByKey = new Map();
  for (const s of snap.servicesJson?.items ?? []) {
    svcsByKey.set(`${s?.metadata?.namespace ?? ""}/${s?.metadata?.name ?? ""}`, s);
  }
  for (let i = 0; i < list.length; i++) {
    const cfg = cfgs[i];
    if (!cfg) continue;
    try {
      const ns = cfg.k8s.namespace;
      const name = cfg.project;
      fillWorkloadFromObjects(entries[i], cfg, {
        deploy: deploysByKey.get(`${ns}/${name}`) ?? null,
        pods: podsByKey.get(`${ns}/${name}`) ?? [],
        podUsage: snap.topPodsAll,
        svc: svcsByKey.get(`${ns}/${name}`) ?? null,
        metricsAvailable: snap.podMetricsAvailable,
      });
    } catch (err) {
      entries[i].error = err?.message ?? "cluster query failed";
    }
  }
  return entries;
}

/**
 * One shared snapshot for the dashboard: nodes + ports + workloads from a
 * single set of kubectl lists. Individual endpoints delegate to this so
 * parallel page requests share results via the short-TTL cache.
 */
export function getClusterSummary(projects) {
  const key = `summary:${projectsFingerprint(projects)}`;
  return getCachedCluster(key, () => {
    const snap = fetchClusterSnapshot();
    let nodes = [];
    let metricsAvailable = false;
    let nodesError = null;
    try {
      ({ nodes, metricsAvailable } = buildNodesFromSnapshot(snap));
    } catch (err) {
      nodesError = err?.message ?? "nodes query failed";
    }
    let ports = [];
    let portsError = null;
    try {
      ({ ports } = buildPortsFromSnapshot(snap));
    } catch (err) {
      portsError = err?.message ?? "services query failed";
    }
    // Workloads need config loading even when lists failed; never throws.
    let workloads = [];
    try {
      if (snap.deploymentsError && snap.podsError && snap.servicesError) {
        ({ workloads } = getWorkloadsStatus(projects));
      } else {
        workloads = buildWorkloadsFromSnapshot(projects, snap);
      }
    } catch (err) {
      workloads = [{ error: err?.message ?? "cluster query failed", deployed: false }];
    }
    const ok = !nodesError && !portsError;
    return { ok, nodes, metricsAvailable, nodesError, ports, portsError, workloads };
  });
}

// ---------------------------------------------------------- output capture ---

/**
 * Run fn while capturing console.log/warn/error lines plus raw
 * process.stdout.write output (validate --manifest writes via stdout).
 */
export function captureOutput(fn) {
  const lines = [];
  let stdout = "";
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origWrite = process.stdout.write;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  console.warn = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  process.stdout.write = (chunk, encoding, callback) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    process.stdout.write = origWrite;
  }
  return { lines, stdout };
}

// ------------------------------------------------------------ job argv map ---
// Pure mapping of {op, args} to CLI argv for `node src/index.js [...]`.
// Global flags (-c/--project-name/--tag) precede the subcommand (positional options).

export function buildJobArgv(op, args = {}, opts = {}) {
  const a = args ?? {};
  const has = (v) => v !== undefined && v !== null && v !== "";
  const configPath = opts.configPath ?? null;
  const tagOpt = a.tag ?? a.tagOverride;
  const pre = [];
  if (configPath) pre.push("-c", configPath);
  if (has(a.project ?? a.projectOverride)) pre.push("--project-name", a.project ?? a.projectOverride);

  switch (op) {
    case "setup": {
      const argv = ["setup"];
      if (has(a.registry)) argv.push("--registry", String(a.registry));
      if (has(a.nfsServer)) argv.push("--nfs-server", String(a.nfsServer));
      if (has(a.nfsBasePath)) argv.push("--nfs-base-path", String(a.nfsBasePath));
      return argv;
    }
    case "create":
      return [
        ...pre,
        ...(has(tagOpt) ? ["--tag", String(tagOpt)] : []),
        "create",
        ...(a.skipBuild ? ["--skip-build"] : []),
        ...(a.skipPush ? ["--skip-push"] : []),
      ];
    case "build":
      return [...pre, ...(has(tagOpt) ? ["--tag", String(tagOpt)] : []), "build"];
    case "push":
      return [...pre, ...(has(tagOpt) ? ["--tag", String(tagOpt)] : []), "push"];
    case "deploy":
      return [
        ...pre,
        ...(has(tagOpt) ? ["--tag", String(tagOpt)] : []),
        "deploy",
        ...(a.noWait || a.wait === false ? ["--no-wait"] : []),
      ];
    case "delete":
      return [
        ...pre,
        ...(has(tagOpt) ? ["--tag", String(tagOpt)] : []),
        "delete",
        ...(a.keepSecrets ? ["--keep-secrets"] : []),
      ];
    case "gc": {
      const argv = [...pre, ...(has(tagOpt) ? ["--tag", String(tagOpt)] : []), "gc"];
      if (has(a.keep)) argv.push("--keep", String(a.keep));
      if (a.dryRun) argv.push("--dry-run");
      return argv;
    }
    case "system-init": {
      if (!has(tagOpt)) throw new Error("system-init requires args.tag (semver vX.Y.Z)");
      const argv = [...pre, "system", "init", "--tag", String(tagOpt)];
      if (has(a.keep)) argv.push("--keep", String(a.keep));
      return argv;
    }
    case "system-create": {
      const argv = [...pre, "system", "create"];
      if (has(tagOpt)) argv.push("--tag", String(tagOpt));
      return argv;
    }
    case "system-rollback": {
      const argv = [...pre, "system", "rollback"];
      if (has(tagOpt)) argv.push(String(tagOpt));
      return argv;
    }
    case "system-gc": {
      const argv = [...pre, "system", "gc"];
      if (has(a.keep)) argv.push("--keep", String(a.keep));
      if (a.dryRun) argv.push("--dry-run");
      return argv;
    }
    case "list-update":
      return ["list", "update", ...(a.dryRun ? ["--dry-run"] : [])];
    case "key-rotate":
      return [...pre, ...(has(tagOpt) ? ["--tag", String(tagOpt)] : []), "key", ...(a.force === false ? [] : ["--force"])];
    default:
      throw new Error(`unknown op: ${op} (allowed: ${ALLOWED_OPS.join(", ")})`);
  }
}

/** Keep only the trailing window of a job log. */
export function trimLogs(logs) {
  const text = String(logs ?? "");
  return text.length > MAX_JOB_LOG ? text.slice(-MAX_JOB_LOG) : text;
}

// ------------------------------------------------------------------ jobs ---
// In-memory store: id -> { id, op, projectId, argv, status, exitCode, logs,
// startedAt, finishedAt }. running | done | error.

const jobs = new Map();

function appendJobLog(job, chunk) {
  job.logs = trimLogs(`${job.logs}${chunk}`);
}

function pruneJobs() {
  if (jobs.size <= 200) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  while (jobs.size > 200 && finished.length) jobs.delete(finished.shift().id);
}

export function startJob(op, projectId, argv, cwd) {
  const job = {
    id: newId(),
    op,
    projectId: projectId ?? null,
    argv,
    status: "running",
    exitCode: null,
    logs: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  pruneJobs();

  let child;
  try {
    // Full environment passthrough (includes KUBECTL_BIN / DOCKER_BIN).
    child = spawn(process.execPath, [CLI_INDEX, ...argv], { cwd, env: process.env });
  } catch (err) {
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    appendJobLog(job, `failed to spawn: ${err.message}\n`);
    return job;
  }
  appendJobLog(job, `$ node src/index.js ${argv.join(" ")}\n(cwd: ${cwd})\n\n`);
  child.stdout.on("data", (d) => appendJobLog(job, d.toString("utf8")));
  child.stderr.on("data", (d) => appendJobLog(job, d.toString("utf8")));
  child.on("error", (err) => {
    appendJobLog(job, `\nspawn error: ${err.message}\n`);
    job.status = "error";
    job.finishedAt = new Date().toISOString();
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.status = code === 0 ? "done" : "error";
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1)).slice(0, 50);
}

function jobSummary(job) {
  return {
    id: job.id,
    op: job.op,
    projectId: job.projectId,
    argv: job.argv,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    logTail: job.logs.slice(-500),
  };
}

// ------------------------------------------------------------ http helpers ---

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = `${JSON.stringify(obj)}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(body);
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function applyCors(req, res, env) {
  if (env.allowedOrigin && req.headers.origin === env.allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", env.allowedOrigin);
    res.setHeader("Vary", "Origin");
    return true;
  }
  return false;
}

/**
 * Write content to a uniquely-named temp file next to `realPath`, so relative
 * config paths (dockerfile/context/keyDir) resolve exactly as they would for
 * the real file. Callers must delete the temp file when done.
 */
function writeSiblingTemp(realPath, content, prefix) {
  const dir = path.dirname(path.resolve(realPath));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${prefix}-${crypto.randomBytes(8).toString("hex")}.yaml`);
  fs.writeFileSync(tmp, content);
  return tmp;
}

/**
 * Load + validate a project config for the read endpoints. Throws Error.
 *
 * `yamlOverride` / `globalYamlOverride` validate unsaved editor drafts
 * without touching the real files on disk: each draft is written to a hidden
 * temp sibling file and removed via the returned `cleanup()` (also run
 * automatically when loading itself throws).
 */
function loadProjectConfig(projectsFile, { projectId, configOverride, projectOverride, tagOverride, yamlOverride, globalYamlOverride }) {
  let configPath = configOverride ? String(configOverride) : null;
  if (projectId) {
    const project = findProject(projectsFile, projectId);
    if (!project) {
      const err = new Error(`unknown project: ${projectId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    configPath = configPath ?? project.configPath;
  }
  if (!configPath) throw Object.assign(new Error("projectId or configOverride is required"), { code: "BAD_REQUEST" });
  const resolved = resolveStoredConfigPath(configPath);
  const temps = [];
  const cleanup = () => {
    for (const tmp of temps) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  };
  let effectivePath = resolved;
  if (yamlOverride !== undefined) {
    if (typeof yamlOverride !== "string" || !yamlOverride.trim()) {
      throw Object.assign(new Error("config draft is empty"), { code: "BAD_REQUEST" });
    }
    effectivePath = writeSiblingTemp(resolved, yamlOverride, "gui-project-draft");
    temps.push(effectivePath);
  }
  const loadOpts = {};
  if (globalYamlOverride !== undefined) {
    if (typeof globalYamlOverride !== "string" || !globalYamlOverride.trim()) {
      cleanup();
      throw Object.assign(new Error("global config draft is empty"), { code: "BAD_REQUEST" });
    }
    const tmpGlobal = writeSiblingTemp(globalConfigPath(), globalYamlOverride, "gui-global-draft");
    temps.push(tmpGlobal);
    loadOpts.globalConfigPath = tmpGlobal;
  }
  const overrides = {};
  if (projectOverride) overrides.project = projectOverride;
  if (tagOverride) overrides.image = { tag: tagOverride };
  let cfg;
  try {
    cfg = loadConfig(effectivePath, overrides, loadOpts);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { cfg, configPath: resolved, cleanup };
}

/** Read validate/manifest params from the query string (GET, saved files) or
 *  the JSON body (POST, unsaved editor drafts). Throws on a bad body. */
async function readValidateParams(req, url) {
  if ((req.method ?? "GET").toUpperCase() === "GET") {
    return {
      projectId: url.searchParams.get("projectId"),
      tagOverride: url.searchParams.get("tagOverride"),
    };
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    throw Object.assign(new Error(err.message), { code: "BAD_REQUEST" });
  }
  return {
    projectId: body?.projectId ?? null,
    tagOverride: body?.tagOverride ?? null,
    yamlOverride: body?.yaml,
    globalYamlOverride: body?.globalYaml,
  };
}

// ------------------------------------------------------------------ router ---

const PUBLIC_API = new Set(["/api/login", "/api/register", "/api/auth-status", "/api/health"]);

export function createServer(env) {
  const projectsFile = env.projectsFile;
  if (!env.authFile && projectsFile) {
    try {
      env.authFile = defaultAuthFile(projectsFile);
    } catch {
      // Leave unset: requests fall back to legacy credentials.
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, env, projectsFile).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err?.message ?? "internal error" });
      else res.end();
    });
  });
  // Browser terminal sessions: ws(s)://<host>/api/ssh/<projectId>.
  // Same session-cookie auth as the REST API; the target (namespace,
  // service, key) comes from the project's saved config.
  attachSshTerminal(server, {
    isAuthenticated: (req) => Boolean(getSession(req)),
    loadTarget: (projectId) => loadSshTarget(projectsFile, projectId),
  });
  return server;
}

/**
 * Resolve everything a browser terminal session needs for one project:
 * the service to forward to plus the user/key to connect with.
 * Throws (code NOT_FOUND for an unknown project).
 */
export function loadSshTarget(projectsFile, projectId) {
  const project = findProject(projectsFile, projectId);
  if (!project) {
    throw Object.assign(new Error(`unknown project: ${projectId}`), { code: "NOT_FOUND" });
  }
  const loaded = loadProjectConfig(projectsFile, { projectId });
  try {
    const cfg = loaded.cfg;
    const pair = ensureKeyPair(cfg.ssh.keyDirPath, cfg.ssh.keyName);
    return {
      name: project.name,
      namespace: cfg.k8s.namespace,
      service: cfg.project,
      sshPort: cfg.ssh.port,
      nodePort: cfg.k8s.nodePort,
      user: cfg.ssh.user,
      privateKey: pair.private,
    };
  } finally {
    loaded.cleanup();
  }
}

async function handleRequest(req, res, env, projectsFile) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const corsAllowed = applyCors(req, res, env);

  if (method === "OPTIONS") {
    if (corsAllowed && pathname.startsWith("/api/")) {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, env, projectsFile, url, pathname, method);
    return;
  }

  // Static SPA (GET/HEAD only).
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  serveStatic(req, res, method);
}

async function handleApi(req, res, env, projectsFile, url, pathname, method) {
  // Public endpoints.
  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/api/auth-status") {
    const effective = getEffectiveAuth(env);
    sendJson(res, 200, {
      registered: effective.type !== "none",
      canRegister: isLoopbackReq(req),
    });
    return;
  }
  if (method === "POST" && pathname === "/api/register") {
    const effective = getEffectiveAuth(env);
    if (effective.type !== "none") {
      sendJson(res, 409, { error: "an account already exists — please sign in" });
      return;
    }
    if (!isLoopbackReq(req)) {
      sendJson(res, 403, {
        error: "No sign-in exists yet. Open the app on the computer where it is running to create it — registration is not allowed over the network.",
      });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const { email, password } = body ?? {};
    const invalid = validateAuthInput(email, password);
    if (invalid) {
      sendJson(res, 400, { error: invalid });
      return;
    }
    try {
      writeAuthRecord(env.authFile, email, password);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    clearAllSessions();
    if (env) {
      env.adminEmail = String(email).trim();
      env.adminPassword = "";
    }
    const token = issueSession(String(email).trim());
    sendJson(res, 201, { ok: true, email: String(email).trim() }, {
      "Set-Cookie": sessionCookieHeader(token, 12 * 3600),
    });
    return;
  }
  if (method === "POST" && pathname === "/api/login") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const { email, password } = body ?? {};
    const effective = getEffectiveAuth(env);
    if (effective.type === "none") {
      sendJson(res, 401, {
        error: isLoopbackReq(req)
          ? "No sign-in exists yet — create one to continue."
          : "No sign-in exists yet. Open the app on the computer where it is running to create it.",
      });
      return;
    }
    if (effective.type === "file") {
      const cleanEmail = String(email ?? "").trim();
      if (
        cleanEmail.toLowerCase() === effective.record.email.toLowerCase() &&
        verifyAuthPassword(effective.record, password)
      ) {
        const token = issueSession(effective.record.email);
        sendJson(res, 200, { ok: true, email: effective.record.email }, {
          "Set-Cookie": sessionCookieHeader(token, 12 * 3600),
        });
        return;
      }
      sendJson(res, 401, { error: "invalid credentials" });
      return;
    }
    // Legacy fallback: plaintext ADMIN_EMAIL/ADMIN_PASSWORD (pre-migration,
    // kept for existing tests and checkouts until migrated on startup).
    if (
      env.adminPassword &&
      email === env.adminEmail &&
      typeof password === "string" &&
      password === env.adminPassword
    ) {
      const token = issueSession(env.adminEmail);
      sendJson(res, 200, { ok: true, email: env.adminEmail }, {
        "Set-Cookie": sessionCookieHeader(token, 12 * 3600),
      });
      return;
    }
    sendJson(res, 401, { error: "invalid credentials" });
    return;
  }

  // Delete-to-reset: the credential file is gone (and no legacy fallback),
  // so every session is void. Frontends fall back to register/blocked.
  if (getEffectiveAuth(env).type === "none") {
    clearAllSessions();
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  // Everything else under /api/* requires a session.
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  // A re-registration with a different email voids older sessions.
  const current = getEffectiveAuth(env);
  if (current.type === "file" && session.email.toLowerCase() !== current.record.email.toLowerCase()) {
    sessions.delete(session.token);
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && pathname === "/api/me") {
    sendJson(res, 200, { email: session.email });
    return;
  }
  if (method === "GET" && pathname === "/api/auth-info") {
    sendJson(res, 200, { email: session.email, authFile: env.authFile ?? null });
    return;
  }
  if (method === "POST" && pathname === "/api/logout") {
    sessions.delete(session.token);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookieHeader("", 0) });
    return;
  }
  if (method === "POST" && pathname === "/api/change-password") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const { currentPassword, newPassword } = body ?? {};
    const invalid = validatePasswordChange(currentPassword, newPassword);
    if (invalid) {
      sendJson(res, 400, { error: invalid });
      return;
    }
    const live = getEffectiveAuth(env);
    if (live.type === "file") {
      if (!verifyAuthPassword(live.record, currentPassword)) {
        sendJson(res, 401, { error: "current password is incorrect" });
        return;
      }
      try {
        writeAuthRecord(env.authFile, live.record.email, newPassword);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
        return;
      }
      stripEnvPasswordLine(env.envFile);
      // Keep only this session: a password change logs out other browsers.
      for (const [token, sess] of sessions) {
        if (sess.email === session.email && token !== session.token) sessions.delete(token);
      }
      sendJson(res, 200, { ok: true, persisted: true });
      return;
    }
    if (currentPassword !== env.adminPassword) {
      sendJson(res, 401, { error: "current password is incorrect" });
      return;
    }
    env.adminPassword = newPassword;
    let persist;
    try {
      persist = updateEnvFilePassword(env.envFile, newPassword);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    // Migrate the freshly changed legacy password to the hash file so the
    // plaintext does not linger.
    migrateLegacyToAuthFile(env);
    // Keep only this session: a password change logs out other browsers.
    for (const [token, sess] of sessions) {
      if (sess.email === session.email && token !== session.token) sessions.delete(token);
    }
    sendJson(res, 200, { ok: true, persisted: persist.persisted, ...(persist.warning ? { warning: persist.warning } : {}) });
    return;
  }

  // ------------------------------------------------------- projects CRUD ---
  if (pathname === "/api/projects") {
    if (method === "GET") {
      sendJson(res, 200, { projects: readProjects(projectsFile) });
      return;
    }
    if (method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const name = String(body?.name ?? "").trim();
      const rawConfigPath = String(body?.configPath ?? "").trim();
      if (!name) {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      const projects = readProjects(projectsFile);
      let configPath;
      if (rawConfigPath) {
        // Explicit custom path (advanced / backwards-compatible). The file
        // itself may not exist yet — the user can create it via the Edit
        // page textarea.
        configPath = resolveStoredConfigPath(rawConfigPath);
      } else {
        // Name-only creation: auto-assign a unique managed path under the
        // global projects dir. No file is created until the first config save.
        const baseSlug = slugifyProjectName(name);
        configPath = uniqueManagedConfigPath(projects, baseSlug).configPath;
      }
      const project = { id: newId(), name, configPath };
      projects.push(project);
      writeProjects(projectsFile, projects);
      sendJson(res, 201, { project });
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const projectById = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectById) {
    const id = decodeURIComponent(projectById[1]);
    if (method === "GET") {
      const project = findProject(projectsFile, id);
      if (!project) {
        sendJson(res, 404, { error: `unknown project: ${id}` });
        return;
      }
      sendJson(res, 200, { project });
      return;
    }
    if (method === "PUT") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const projects = readProjects(projectsFile);
      const idx = projects.findIndex((p) => p.id === id);
      if (idx === -1) {
        sendJson(res, 404, { error: `unknown project: ${id}` });
        return;
      }
      const hasName = body?.name !== undefined;
      const hasConfigPath = body?.configPath !== undefined;
      if (!hasName && !hasConfigPath) {
        sendJson(res, 400, { error: "name or configPath is required" });
        return;
      }
      if (hasName) {
        const name = String(body.name ?? "").trim();
        if (!name) {
          sendJson(res, 400, { error: "name must not be empty" });
          return;
        }
        projects[idx].name = name;
      }
      if (hasConfigPath) {
        const rawConfigPath = String(body.configPath ?? "").trim();
        if (!rawConfigPath) {
          sendJson(res, 400, { error: "configPath must not be empty" });
          return;
        }
        // Explicit path change wins — no auto-move. The file itself may not
        // exist yet (created via the Edit page textarea).
        projects[idx].configPath = resolveStoredConfigPath(rawConfigPath);
      } else if (hasName) {
        // Rename without an explicit path: managed configs follow the new
        // slug. Custom paths stay put. Moves never overwrite.
        const oldPath = projects[idx].configPath;
        if (isManagedConfigPath(oldPath)) {
          const baseSlug = slugifyProjectName(projects[idx].name);
          const { configPath: nextPath } = uniqueManagedConfigPath(projects, baseSlug, projects[idx].id);
          if (path.resolve(nextPath) !== path.resolve(oldPath)) {
            if (fs.existsSync(nextPath)) {
              sendJson(res, 400, { error: `config file already exists: ${nextPath}` });
              return;
            }
            if (fs.existsSync(oldPath)) {
              try {
                fs.mkdirSync(path.dirname(nextPath), { recursive: true });
                fs.renameSync(oldPath, nextPath);
              } catch (err) {
                sendJson(res, 500, { error: `cannot move config file: ${err.message}` });
                return;
              }
            }
            projects[idx].configPath = nextPath;
          }
        }
      }
      writeProjects(projectsFile, projects);
      sendJson(res, 200, { project: projects[idx] });
      return;
    }
    if (method === "DELETE") {
      const projects = readProjects(projectsFile);
      const idx = projects.findIndex((p) => p.id === id);
      if (idx === -1) {
        sendJson(res, 404, { error: `unknown project: ${id}` });
        return;
      }
      projects.splice(idx, 1);
      writeProjects(projectsFile, projects);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  // ---------------------------------------------------- project starter ----
  if (method === "GET" && pathname === "/api/project-starter") {
    const projectId = url.searchParams.get("projectId");
    const rawName = url.searchParams.get("projectName");
    let name = String(rawName ?? "").trim();
    if (projectId) {
      const project = findProject(projectsFile, projectId);
      if (!project) {
        sendJson(res, 404, { error: `unknown project: ${projectId}` });
        return;
      }
      name = project.name;
    }
    if (!name) {
      sendJson(res, 400, { error: "projectId or projectName is required" });
      return;
    }
    const slug = slugifyProjectName(name);
    let mainNodePort;
    let dbNodePort;
    try {
      mainNodePort = allocateNodePort(30022);
      dbNodePort = allocateNodePort(30432);
      if (dbNodePort === mainNodePort) dbNodePort = allocateNodePort(mainNodePort + 1);
    } catch (err) {
      sendJson(res, 500, { error: `no free NodePort: ${err.message}` });
      return;
    }
    sendJson(res, 200, {
      slug,
      mainNodePort,
      dbNodePort,
      yaml: buildStarterYaml({ slug, mainNodePort, dbNodePort }),
    });
    return;
  }

  // ------------------------------------------------------------ config ------
  if (pathname === "/api/config") {
    if (method === "GET") {
      let loaded;
      try {
        loaded = loadProjectConfig(projectsFile, {
          projectId: url.searchParams.get("projectId"),
          configOverride: url.searchParams.get("configOverride"),
          projectOverride: url.searchParams.get("projectOverride"),
          tagOverride: url.searchParams.get("tagOverride"),
        });
      } catch (err) {
        sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { error: err.message });
        return;
      }
      let rawYaml;
      try {
        rawYaml = fs.readFileSync(loaded.configPath, "utf8");
      } catch (err) {
        sendJson(res, 400, { error: `cannot read config file: ${err.message}` });
        return;
      }
      sendJson(res, 200, {
        merged: redactConfig(loaded.cfg),
        rawYaml,
        imageMode: loaded.cfg.imageMode,
        configPath: loaded.configPath,
      });
      return;
    }
    if (method === "PUT") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const project = body?.projectId ? findProject(projectsFile, body.projectId) : null;
      if (!project) {
        sendJson(res, 404, { error: `unknown project: ${body?.projectId ?? "(missing projectId)"}` });
        return;
      }
      if (typeof body?.yaml !== "string" || !body.yaml.trim()) {
        sendJson(res, 400, { error: "yaml is required" });
        return;
      }
      // Validate by loading a temp copy first; overwrite the real file only
      // when the candidate parses and validates.
      const tmp = path.join(os.tmpdir(), `gui-config-${crypto.randomBytes(8).toString("hex")}.yaml`);
      try {
        fs.writeFileSync(tmp, body.yaml);
        loadConfig(tmp);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        sendJson(res, 400, { error: `invalid config: ${err.message}` });
        return;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      try {
        fs.mkdirSync(path.dirname(project.configPath), { recursive: true });
        fs.writeFileSync(project.configPath, body.yaml);
      } catch (err) {
        sendJson(res, 500, { error: `cannot write config file: ${err.message}` });
        return;
      }
      sendJson(res, 200, { ok: true, configPath: project.configPath });
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  // ------------------------------------------------------ global config ----
  if (pathname === "/api/global-config") {
    const globalPath = globalConfigPath();
    if (method === "GET") {
      const exists = fs.existsSync(globalPath);
      // Effective system Dockerfile: image.dockerfile from the global layer
      // (default "Dockerfile") resolved against the global dir.
      let dockerfilePath = path.join(path.dirname(globalPath), "Dockerfile");
      if (exists) {
        try {
          const parsed = yaml.load(fs.readFileSync(globalPath, "utf8")) ?? {};
          const rel = parsed?.image?.dockerfile;
          if (typeof rel === "string" && rel.trim()) {
            dockerfilePath = path.isAbsolute(rel.trim())
              ? rel.trim()
              : path.join(path.dirname(globalPath), rel.trim());
          }
        } catch {
          /* keep the default location */
        }
      }
      sendJson(res, 200, {
        exists,
        path: globalPath,
        rawYaml: exists ? fs.readFileSync(globalPath, "utf8") : null,
        dockerfile: { path: dockerfilePath, exists: fs.existsSync(dockerfilePath) },
      });
      return;
    }
    if (method === "PUT") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (typeof body?.yaml !== "string") {
        sendJson(res, 400, { error: "yaml is required" });
        return;
      }
      try {
        yaml.load(body.yaml);
      } catch (err) {
        sendJson(res, 400, { error: `invalid YAML: ${err.message}` });
        return;
      }
      try {
        fs.mkdirSync(path.dirname(globalPath), { recursive: true });
        fs.writeFileSync(globalPath, body.yaml);
      } catch (err) {
        sendJson(res, 500, { error: `cannot write global config: ${err.message}` });
        return;
      }
      sendJson(res, 200, { ok: true, path: globalPath });
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  // --------------------------------------- validate (+ draft via POST) ---
  // GET validates the saved files; POST accepts { projectId, tagOverride,
  // yaml?, globalYaml? } and validates the unsaved editor drafts instead,
  // via temp sibling files that never touch the real files on disk.
  if ((method === "GET" || method === "POST") && pathname === "/api/validate") {
    let params;
    try {
      params = await readValidateParams(req, url);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message, lines: [] });
      return;
    }
    let loaded;
    try {
      loaded = loadProjectConfig(projectsFile, params);
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { ok: false, error: err.message, lines: [] });
      return;
    }
    try {
      const { lines } = captureOutput(() => validate(loaded.cfg, { manifest: false }));
      // Mention NodePorts already held by other services (warning only —
      // validation still passes). Silent when the cluster is unreachable, so
      // validation stays usable offline.
      let portConflicts = [];
      try {
        portConflicts = findTakenNodePorts(loaded.cfg, getClusterPorts()).map((c) => ({
          ...c,
          source: "cluster",
        }));
      } catch {
        portConflicts = [];
      }
      // Mention NodePorts claimed by other projects' saved configs, even when
      // those projects are inactive (nothing on the cluster). Ports already
      // reported as cluster-held are skipped to avoid double warnings.
      const wanted = wantedNodePorts(loaded.cfg);
      const others = [];
      for (const p of readProjects(projectsFile)) {
        if (p.id === params.projectId || !p.configPath) continue;
        try {
          const otherCfg = loadConfig(resolveStoredConfigPath(p.configPath));
          others.push({ name: p.name, wanted: wantedNodePorts(otherCfg) });
        } catch {
          /* missing/unreadable/invalid file — its own page will flag it */
        }
      }
      const claimedPorts = findClaimedNodePorts(wanted, others)
        .filter((c) => !portConflicts.some((t) => t.nodePort === c.nodePort))
        .map((c) => ({ ...c, source: "project" }));
      lines.unshift(
        ...portConflicts.map(
          (c) =>
            `warning: nodePort ${c.nodePort} (${c.label}) is already in use by service "${c.service}" in namespace "${c.namespace}"`
        ),
        ...claimedPorts.map(
          (c) =>
            `warning: nodePort ${c.nodePort} (${c.label}) is also claimed by project "${c.project}" in its saved config (for ${c.projectLabel})`
        )
      );
      sendJson(res, 200, {
        ok: true,
        lines,
        summary: lines.join("\n"),
        portConflicts: [...portConflicts, ...claimedPorts],
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message, lines: [], summary: "" });
    } finally {
      loaded.cleanup();
    }
    return;
  }

  // --------------------------------------- manifest (+ draft via POST) ---
  if ((method === "GET" || method === "POST") && pathname === "/api/manifest") {
    let params;
    try {
      params = await readValidateParams(req, url);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    let loaded;
    try {
      loaded = loadProjectConfig(projectsFile, params);
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { error: err.message });
      return;
    }
    try {
      const { lines, stdout } = captureOutput(() => validate(loaded.cfg, { manifest: true }));
      sendJson(res, 200, { manifest: stdout, warnings: lines });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    } finally {
      loaded.cleanup();
    }
    return;
  }

  // ------------------------------------------------------------- ssh list ---
  if (method === "GET" && pathname === "/api/ssh-list") {
    const entries = sortSshEntries(listHostEntries()).map((e) => ({
      alias: e.alias,
      host: e.hostName ?? null,
      port: e.port ?? null,
      user: e.user ?? null,
      identityFile: e.identityFile ?? null,
    }));
    sendJson(res, 200, { entries });
    return;
  }

  // -------------------------------------------------------- ssh terminal ----
  // Connection summary for the browser terminal page. The live session
  // itself runs over ws(s)://<host>/api/ssh/<projectId> (see ssh-terminal.js).
  if (method === "GET" && pathname === "/api/ssh/info") {
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      sendJson(res, 400, { error: "projectId is required" });
      return;
    }
    try {
      const target = loadSshTarget(projectsFile, projectId);
      sendJson(res, 200, {
        project: { id: projectId, name: target.name },
        user: target.user,
        namespace: target.namespace,
        service: target.service,
        sshPort: target.sshPort,
        nodePort: target.nodePort,
      });
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { error: err.message });
      return;
    }
    return;
  }

  // ------------------------------------------------------------------ key ---
  if (method === "GET" && pathname === "/api/key") {
    let cfg;
    try {
      ({ cfg } = loadProjectConfig(projectsFile, {
        projectId: url.searchParams.get("projectId"),
      }));
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { error: err.message });
      return;
    }
    let pair;
    try {
      // Same as CLI `key`: generate the pair when missing, never delete.
      pair = ensureKeyPair(cfg.ssh.keyDirPath, cfg.ssh.keyName);
    } catch (err) {
      sendJson(res, 500, { error: `cannot ensure key pair: ${err.message}` });
      return;
    }
    let publicKey = "";
    try {
      publicKey = readPublicKey(pair.public);
    } catch (err) {
      sendJson(res, 500, { error: `cannot read public key: ${err.message}` });
      return;
    }
    let image;
    try {
      cfg.image.tag = resolveDeployTag(cfg);
      image = imageRef(cfg);
    } catch (err) {
      image = `unresolved: ${String(err.message).split("\n")[0]}`;
    }
    sendJson(res, 200, {
      private: pair.private,
      public: pair.public,
      image,
      publicKey,
      preview: publicKey.slice(0, 80),
      fingerprint: `SHA256:${crypto.createHash("sha256").update(publicKey).digest("base64")}`,
    });
    return;
  }

  // ---------------------------------------------------------- system state ---
  // System image is global: projectId is optional. Without it the repo-root
  // default config is used (same as `coding-container system ...` with no -c).
  if (method === "GET" && pathname === "/api/system/state") {
    let cfg;
    const stateProjectId = url.searchParams.get("projectId");
    try {
      if (stateProjectId) {
        ({ cfg } = loadProjectConfig(projectsFile, {
          projectId: stateProjectId,
        }));
      } else {
        cfg = loadConfig(path.join(REPO_ROOT, "config.yaml"));
      }
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { ok: false, error: err.message });
      return;
    }
    try {
      const sys = getSystemConfig(cfg.k8s.namespace);
      sendJson(res, 200, {
        ok: true,
        state: {
          current: sys.current,
          previous: sys.previous ?? null,
          maxEver: sys.maxEver,
          keep: sys.keep,
        },
        image: `${cfg.image.registry}/${cfg.image.name}:${sys.current}`,
      });
    } catch (err) {
      // Missing ConfigMap etc: surface the message (INIT_HINT text included).
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  // ----------------------------------------------------------- system tags ---
  // Same project-optional rule as /api/system/state above.
  if (method === "GET" && pathname === "/api/system/tags") {
    let cfg;
    const tagsProjectId = url.searchParams.get("projectId");
    try {
      if (tagsProjectId) {
        ({ cfg } = loadProjectConfig(projectsFile, {
          projectId: tagsProjectId,
        }));
      } else {
        cfg = loadConfig(path.join(REPO_ROOT, "config.yaml"));
      }
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { error: err.message });
      return;
    }
    try {
      const tags = await listTags(cfg);
      sendJson(res, 200, { tags });
    } catch (err) {
      // Mirror globalTags: empty array when the repo does not exist yet.
      if (/was not found/i.test(err.message)) {
        sendJson(res, 200, { tags: [] });
        return;
      }
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ------------------------------------------------------- cluster live ---
  // Read-only live cluster state for the dashboard. Failures degrade to
  // { ok: false, error } so the UI can render config data without the
  // cluster (e.g. metrics-server missing, kubectl offline).
  // Results share a short-TTL cache so parallel page requests reuse one set
  // of kubectl lists instead of spawning dozens of processes per load.
  if (method === "GET" && pathname === "/api/cluster/nodes") {
    const body = getCachedCluster("nodes", () => {
      try {
        const { nodes, metricsAvailable } = getClusterNodes();
        return { ok: true, nodes, metricsAvailable };
      } catch (err) {
        return { ok: false, nodes: [], metricsAvailable: false, error: err.message };
      }
    });
    sendJson(res, 200, body);
    return;
  }

  if (method === "GET" && pathname === "/api/cluster/ports") {
    const body = getCachedCluster("ports", () => {
      try {
        const { ports } = getClusterPorts();
        return { ok: true, ports };
      } catch (err) {
        return { ok: false, ports: [], error: err.message };
      }
    });
    sendJson(res, 200, body);
    return;
  }

  if (method === "GET" && pathname === "/api/cluster/workloads") {
    const body = getCachedCluster(`workloads:${projectsFingerprint(readProjects(projectsFile))}`, () => {
      try {
        const { workloads } = getWorkloadsStatus(readProjects(projectsFile));
        return { ok: true, workloads };
      } catch (err) {
        return { ok: false, workloads: [], error: err.message };
      }
    });
    sendJson(res, 200, body);
    return;
  }

  if (method === "GET" && pathname === "/api/cluster/summary") {
    try {
      const summary = getClusterSummary(readProjects(projectsFile));
      sendJson(res, 200, {
        ok: summary.ok,
        nodes: summary.nodes,
        metricsAvailable: summary.metricsAvailable,
        ...(summary.nodesError ? { nodesError: summary.nodesError } : {}),
        ports: summary.ports,
        ...(summary.portsError ? { portsError: summary.portsError } : {}),
        workloads: summary.workloads,
      });
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        nodes: [],
        metricsAvailable: false,
        ports: [],
        workloads: [],
        error: err.message,
      });
    }
    return;
  }

  // ----------------------------------------------------------------- jobs ---
  if (pathname === "/api/jobs" && method === "GET") {
    sendJson(res, 200, { jobs: listJobs().map(jobSummary) });
    return;
  }

  const jobById = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobById && method === "GET") {
    const job = getJob(decodeURIComponent(jobById[1]));
    if (!job) {
      sendJson(res, 404, { error: "unknown job" });
      return;
    }
    sendJson(res, 200, { job });
    return;
  }

  if (pathname === "/api/jobs" && method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const { op, projectId, args } = body ?? {};
    if (!op || !ALLOWED_OPS.includes(op)) {
      sendJson(res, 400, { error: `unknown op: ${op} (allowed: ${ALLOWED_OPS.join(", ")})` });
      return;
    }
    // System image ops are global (like setup/list-update): they run against
    // the repo-root default config when no projectId is given, exactly like
    // `coding-container system ...` with no -c flag.
    const SYSTEM_NO_PROJECT_OPS = new Set([
      "system-init",
      "system-create",
      "system-rollback",
      "system-gc",
    ]);
    const needsProject =
      op !== "setup" && op !== "list-update" && !SYSTEM_NO_PROJECT_OPS.has(op);
    let project = null;
    if (projectId) {
      project = findProject(projectsFile, projectId);
      if (!project) {
        sendJson(res, 404, { error: `unknown project: ${projectId}` });
        return;
      }
    } else if (needsProject) {
      sendJson(res, 400, { error: `projectId is required for op "${op}"` });
      return;
    }
    const configPath = project ? resolveStoredConfigPath(project.configPath) : null;
    let argv;
    try {
      argv = buildJobArgv(op, args ?? {}, { configPath });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const cwd = configPath ? path.dirname(configPath) : REPO_ROOT;
    const job = startJob(op, project?.id ?? null, argv, cwd);
    sendJson(res, 202, { id: job.id, op: job.op, status: job.status, startedAt: job.startedAt });
    return;
  }

  // -------------------------------------------------------------- fallback ---
  if (PUBLIC_API.has(pathname)) {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------- static ---

function serveStatic(req, res, method) {
  if (!fs.existsSync(DIST_DIR)) {
    sendJson(res, 200, { message: "GUI not built" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!rel) rel = "index.html";
  const resolved = path.normalize(path.join(DIST_DIR, rel));
  if (!resolved.startsWith(DIST_DIR)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  let file = resolved;
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = null;
  }
  if (!file || !fs.existsSync(file)) {
    // SPA fallback.
    const index = path.join(DIST_DIR, "index.html");
    if (!fs.existsSync(index)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    file = index;
  }
  const type = STATIC_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  try {
    const stat = fs.statSync(file);
    res.writeHead(200, { "content-type": type, "content-length": stat.size });
    if (method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
}

// ----------------------------------------------------------------- start ---

export function startServer(env = loadEnvConfig()) {
  if (!env.authFile) env.authFile = defaultAuthFile(env.projectsFile);
  migrateLegacyToAuthFile(env);
  migrateProjectsFile(env.projectsFile, path.join(REPO_ROOT, "web", "projects.json"));
  ensureDefaultProject(env.projectsFile);
  const server = createServer(env);
  server.listen(env.port, () => {
    console.log(`GUI server listening on http://localhost:${env.port}`);
  });
  return server;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startServer();
}
