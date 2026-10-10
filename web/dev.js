#!/usr/bin/env node
/**
 * GUI dev launcher: runs the backend API and the Vite frontend together.
 *
 *   npm run dev          # backend (:3000, from web/.env PORT) + Vite (:5173)
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
const ENV_PATH = path.join(WEB_DIR, ".env");
const CLIENT_DIR = path.join(WEB_DIR, "client");

if (!fs.existsSync(ENV_PATH)) {
  console.warn(
    `warning: ${ENV_PATH} not found — copy web/.env.example to web/.env and set ` +
      `ADMIN_EMAIL + ADMIN_PASSWORD, or login will always fail.`
  );
}

if (!fs.existsSync(path.join(CLIENT_DIR, "node_modules"))) {
  console.error(
    `web/client dependencies are not installed. Run once:\n` +
      `  npm --prefix web/client install`
  );
  process.exit(1);
}

function launch(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
