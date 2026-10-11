#!/usr/bin/env node
/**
 * Kill leftover GUI dev servers by port.
 *
 *   npm run dev:kill
 *
 * `npm run dev` already stops its children on Ctrl+C, but orphaned servers
 * (closed terminal, crashed launcher) keep holding their ports and the next
 * `npm run dev` fails with EADDRINUSE. This kills whatever is LISTENING on
 * the Vite port (:3000) and the API port (:PORT from .env, default 3001).
 *
 *   node web/kill-dev.js --dry-run    # only list what would be killed
 *   node web/kill-dev.js --ports=3000 # only check the given port(s)
 *
 * Zero dependencies (node: builtins only). Windows-first (netstat/taskkill),
 * with an lsof/kill fallback for macOS/Linux.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(WEB_DIR, "..", ".env");
const LEGACY_ENV_PATH = path.join(WEB_DIR, ".env");
const VITE_PORT = 3000;
const DEFAULT_API_PORT = 3001;

function readApiPort() {
  for (const p of [ENV_PATH, LEGACY_ENV_PATH]) {
    try {
      const env = fs.readFileSync(p, "utf8");
      const match = env.match(/^PORT=(\d+)\s*$/m);
      if (match) return Number(match[1]);
    } catch {
      /* missing/unreadable .env — try the next candidate */
    }
  }
  return DEFAULT_API_PORT;
}

function readPortsArg(argv) {
  const flag = argv.find((a) => a.startsWith("--ports="));
  if (!flag) return null;
  const ports = flag
    .slice("--ports=".length)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return ports.length > 0 ? ports : null;
}

function isDryRun(argv) {
  return argv.includes("--dry-run");
}

async function pidsListeningOnPort(port) {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
      windowsHide: true,
    });
    const pids = new Set();
    for (const line of stdout.split("\n")) {
      // e.g. "  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234"
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || !/^TCP$/i.test(parts[0])) continue;
      const [, local, , state, pidText] = parts;
      if (!/^LISTENING$/i.test(state)) continue;
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid !== process.pid) pids.add(pid);
    }
    return [...pids];
  }
  // macOS / Linux: lsof prints one PID per line; exits non-zero when empty.
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`]);
    return stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

async function pidExists(pid) {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
        windowsHide: true,
      });
      return stdout.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPids(pids) {
  if (pids.length === 0) return [];
  if (process.platform === "win32") {
    // One taskkill per PID: a PID that exits mid-run must not fail the rest,
    // and "process not found" just means it already exited.
    const killed = [];
    const failed = [];
    for (const pid of pids) {
      try {
        await execFileAsync("taskkill", ["/F", "/PID", String(pid)], {
          windowsHide: true,
        });
        killed.push(pid);
      } catch {
        if (await pidExists(pid)) failed.push(pid);
        else killed.push(pid);
      }
    }
    if (failed.length > 0) {
      throw new Error(`could not kill PID(s) ${failed.join(", ")}`);
    }
    return killed;
  }
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      /* already gone or not ours — skip */
    }
  }
  // Escalate survivors to SIGKILL after a short grace period.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const pid of killed) {
    try {
      process.kill(pid, 0);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* went away between checks */
      }
    } catch {
      /* exited after SIGTERM — done */
    }
  }
  return killed;
}

const argv = process.argv.slice(2);
const ports = readPortsArg(argv) ?? [VITE_PORT, readApiPort()];
const dryRun = isDryRun(argv);
let failures = 0;

for (const port of ports) {
  let pids;
  try {
    pids = await pidsListeningOnPort(port);
  } catch (err) {
    console.error(`port ${port}: could not list listeners (${err.message})`);
    failures += 1;
    continue;
  }
  if (pids.length === 0) {
    console.log(`port ${port}: nothing listening`);
    continue;
  }
  if (dryRun) {
    console.log(`port ${port}: would kill PID(s) ${pids.join(", ")}`);
    continue;
  }
  try {
    const killed = await killPids(pids);
    console.log(`port ${port}: killed PID(s) ${killed.join(", ")}`);
  } catch (err) {
    console.error(`port ${port}: failed to kill PID(s) ${pids.join(", ")} (${err.message})`);
    failures += 1;
  }
}

process.exit(failures > 0 ? 1 : 0);
