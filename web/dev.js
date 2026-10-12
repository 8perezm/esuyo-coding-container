#!/usr/bin/env node
/**
 * GUI dev launcher: runs the backend API and the Vite frontend together.
 *
 *   npm run dev          # backend (:3401, from .env PORT) + Vite (:3400)
 *   npm run dev:kill     # kill orphaned dev servers still holding those ports
 *
 * Zero dependencies (node: builtins only). `npm --prefix` is not used so the
 * client keeps its own lockfile/install; the client must be installed once:
 *   npm --prefix web/client install
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(REPO_ROOT, "web");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const LEGACY_ENV_PATH = path.join(WEB_DIR, ".env");
const CLIENT_DIR = path.join(WEB_DIR, "client");

if (!fs.existsSync(ENV_PATH) && !fs.existsSync(LEGACY_ENV_PATH)) {
  console.warn(
    `warning: ${ENV_PATH} not found — copy .env.example to .env. ` +
      `The first launch migrates a legacy ADMIN_EMAIL + ADMIN_PASSWORD into the hashed credential file; ` +
      `otherwise the pages ask to create the sign-in on the local machine.`
  );
}

if (!fs.existsSync(path.join(CLIENT_DIR, "node_modules"))) {
  console.error(
    `web/client dependencies are not installed. Run once:\n` +
      `  npm --prefix web/client install`
  );
  process.exit(1);
}

const VITE_PORT = 3400;
const DEFAULT_API_PORT = 3401;

function readApiPort() {
  if (process.env.PORT && Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) > 0) {
    return Number(process.env.PORT);
  }
  for (const p of [ENV_PATH, LEGACY_ENV_PATH]) {
    try {
      const match = fs.readFileSync(p, "utf8").match(/^PORT=(\d+)\s*$/m);
      if (match) return Number(match[1]);
    } catch {
      /* missing/unreadable .env — try the next candidate */
    }
  }
  return DEFAULT_API_PORT;
}

console.log(`GUI dev servers: pages http://localhost:${VITE_PORT}, API http://localhost:${readApiPort()}`);

function launch(name, cmd, args, cwd) {
  // On Windows `npm` is npm.cmd, which Node can only spawn via a shell —
  // plain spawn("npm") fails with ENOENT. Only the npm child gets a shell;
  // the node child (process.execPath, often "C:\Program Files\...") must
  // NOT use one or its space-containing path breaks.
  const useShell = process.platform === "win32" && cmd === "npm";
  const child = spawn(cmd, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(useShell ? { shell: true } : {}),
  });
  child.on("error", (err) => {
    console.error(`[${name}] failed to start "${cmd} ${args.join(" ")}": ${err.message}`);
  });
  const tag = (chunk, out) => {
    for (const line of String(chunk).split(/\n/)) {
      if (line.trim()) out.write(`[${name}] ${line}\n`);
    }
  };
  child.stdout.on("data", (d) => tag(d, process.stdout));
  child.stderr.on("data", (d) => tag(d, process.stderr));
  return child;
}

const api = launch("api", process.execPath, [path.join(WEB_DIR, "server", "server.js")], REPO_ROOT);
const web = launch("web", "npm", ["run", "dev"], CLIENT_DIR);

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [api, web]) {
    try {
      child.kill("SIGINT");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}

api.on("exit", (code) => {
  console.error(`[api] exited with code ${code ?? "?"} — stopping dev servers`);
  shutdown(code ?? 1);
});
web.on("exit", (code) => {
  console.error(`[web] exited with code ${code ?? "?"} — stopping dev servers`);
  shutdown(code ?? 1);
});
