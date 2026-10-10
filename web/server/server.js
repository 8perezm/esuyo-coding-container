#!/usr/bin/env node
/**
 * Web GUI backend for coding-container.
 *
 * Single-file Node ESM HTTP server. Only node: builtins + js-yaml (already
 * a dependency). No other npm packages.
 *
 *   node web/server/server.js          # reads web/.env, serves the API + SPA
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

import { loadConfig, imageRef, globalConfigPath } from "../../src/config.js";
import { validate } from "../../src/commands/validate.js";
import { listHostEntries } from "../../src/utils/ssh-config.js";
import { ensureKeyPair, readPublicKey } from "../../src/utils/keys.js";
import { getSystemConfig, resolveDeployTag } from "../../src/utils/system-config.js";
import { listTags } from "../../src/utils/registry-api.js";

// ---------------------------------------------------------------- paths ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const WEB_DIR = path.join(REPO_ROOT, "web");
export const DIST_DIR = path.join(WEB_DIR, "client", "dist");
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

function resolveProjectsFile(raw) {
  const value = raw && String(raw).trim() ? String(raw).trim() : "web/projects.json";
  return path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
}

/**
 * Server config: web/.env file values, with real environment variables
 * taking precedence (so containers can override without editing the file).
 */
export function loadEnvConfig() {
  let fromFile = {};
  const envPath = path.join(WEB_DIR, ".env");
  if (fs.existsSync(envPath)) {
    try {
      fromFile = parseDotEnv(fs.readFileSync(envPath, "utf8"));
    } catch {
      fromFile = {};
    }
  }
  const get = (key, fallback = "") => process.env[key] ?? fromFile[key] ?? fallback;
  const port = Number.parseInt(get("PORT", "3000"), 10);
  return {
    adminEmail: get("ADMIN_EMAIL", ""),
    adminPassword: get("ADMIN_PASSWORD", ""),
    port: Number.isInteger(port) && port > 0 ? port : 3000,
    projectsFile: resolveProjectsFile(get("PROJECTS_FILE", "web/projects.json")),
    allowedOrigin: get("ALLOWED_ORIGIN", "").trim(),
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

// ------------------------------------------------------- projects registry ---

export function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

export function readProjects(projectsFile) {
  try {
    if (!fs.existsSync(projectsFile)) return [];
    const data = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function writeProjects(projectsFile, projects) {
  fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
  fs.writeFileSync(projectsFile, `${JSON.stringify(projects, null, 2)}\n`);
}

/** On startup, an empty registry auto-registers the repo's own config. */
export function ensureDefaultProject(projectsFile) {
  const projects = readProjects(projectsFile);
  if (projects.length === 0) {
    projects.push({
      id: newId(),
      name: "my-project",
      configPath: path.join(REPO_ROOT, "config.yaml"),
    });
    writeProjects(projectsFile, projects);
  }
  return projects;
}

function findProject(projectsFile, projectId) {
  return readProjects(projectsFile).find((p) => p.id === projectId) ?? null;
}

function resolveStoredConfigPath(configPath) {
  const raw = String(configPath ?? "").trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(REPO_ROOT, raw);
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
// Global flags (-c/-p/--tag) precede the subcommand (positional options).

export function buildJobArgv(op, args = {}, opts = {}) {
  const a = args ?? {};
  const has = (v) => v !== undefined && v !== null && v !== "";
  const configPath = opts.configPath ?? null;
  const tagOpt = a.tag ?? a.tagOverride;
  const pre = [];
  if (configPath) pre.push("-c", configPath);
  if (has(a.project ?? a.projectOverride)) pre.push("-p", a.project ?? a.projectOverride);

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

/** Load + validate a project config for the read endpoints. Throws Error. */
function loadProjectConfig(projectsFile, { projectId, configOverride, projectOverride, tagOverride }) {
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
  const overrides = {};
  if (projectOverride) overrides.project = projectOverride;
  if (tagOverride) overrides.image = { tag: tagOverride };
  const cfg = loadConfig(resolved, overrides);
  return { cfg, configPath: resolved };
}

// ------------------------------------------------------------------ router ---

const PUBLIC_API = new Set(["/api/login", "/api/health"]);

export function createServer(env) {
  const projectsFile = env.projectsFile;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, env, projectsFile).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err?.message ?? "internal error" });
      else res.end();
    });
  });
  return server;
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
  if (method === "POST" && pathname === "/api/login") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const { email, password } = body ?? {};
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

  // Everything else under /api/* requires a session.
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && pathname === "/api/me") {
    sendJson(res, 200, { email: session.email });
    return;
  }
  if (method === "POST" && pathname === "/api/logout") {
    sessions.delete(session.token);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookieHeader("", 0) });
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
      if (!rawConfigPath) {
        sendJson(res, 400, { error: "configPath is required" });
        return;
      }
      const resolved = resolveStoredConfigPath(rawConfigPath);
      if (!fs.existsSync(resolved)) {
        sendJson(res, 400, { error: `config file not found: ${resolved}` });
        return;
      }
      const projects = readProjects(projectsFile);
      const project = { id: newId(), name, configPath: resolved };
      projects.push(project);
      writeProjects(projectsFile, projects);
      sendJson(res, 201, { project });
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const projectDelete = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectDelete) {
    if (method !== "DELETE") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const id = decodeURIComponent(projectDelete[1]);
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
        fs.writeFileSync(project.configPath, body.yaml);
      } catch (err) {
        sendJson(res, 500, { error: `cannot write config file: ${err.message}` });
        return;
      }
      sendJson(res, 200, { ok: true });
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
      sendJson(res, 200, {
        exists,
        path: globalPath,
        rawYaml: exists ? fs.readFileSync(globalPath, "utf8") : null,
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

  // ------------------------------------------------------------- validate ---
  if (method === "GET" && pathname === "/api/validate") {
    let cfg;
    try {
      ({ cfg } = loadProjectConfig(projectsFile, {
        projectId: url.searchParams.get("projectId"),
        tagOverride: url.searchParams.get("tagOverride"),
      }));
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { ok: false, error: err.message, lines: [] });
      return;
    }
    try {
      const { lines } = captureOutput(() => validate(cfg, { manifest: false }));
      sendJson(res, 200, { ok: true, lines, summary: lines.join("\n") });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message, lines: [], summary: "" });
    }
    return;
  }

  // ------------------------------------------------------------- manifest ---
  if (method === "GET" && pathname === "/api/manifest") {
    let cfg;
    try {
      ({ cfg } = loadProjectConfig(projectsFile, {
        projectId: url.searchParams.get("projectId"),
        tagOverride: url.searchParams.get("tagOverride"),
      }));
    } catch (err) {
      sendJson(res, err.code === "NOT_FOUND" ? 404 : 400, { error: err.message });
      return;
    }
    try {
      const { lines, stdout } = captureOutput(() => validate(cfg, { manifest: true }));
      sendJson(res, 200, { manifest: stdout, warnings: lines });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
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
  if (method === "GET" && pathname === "/api/system/state") {
    let cfg;
    try {
      ({ cfg } = loadProjectConfig(projectsFile, {
        projectId: url.searchParams.get("projectId"),
      }));
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
  if (method === "GET" && pathname === "/api/system/tags") {
    let cfg;
    try {
      ({ cfg } = loadProjectConfig(projectsFile, {
        projectId: url.searchParams.get("projectId"),
      }));
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
    const needsProject = op !== "setup" && op !== "list-update";
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
