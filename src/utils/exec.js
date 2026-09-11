import { spawn, spawnSync } from "node:child_process";

/**
 * Which docker to run. DOCKER_BIN lets tests (and users with a wrapper)
 * point at a specific binary. On Windows an explicit script stub (.cmd)
 * needs a shell to spawn.
 */
export function dockerExec() {
  const overridden = Boolean(process.env.DOCKER_BIN);
  const cmd = process.env.DOCKER_BIN || "docker";
  const opts = overridden && process.platform === "win32" ? { shell: true } : {};
  return { cmd, opts };
}

/**
 * Run a command and return its stdout (trimmed). Throws on non-zero exit.
 */
export function exec(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "").trim();
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}\n${msg}`);
  }
  return (res.stdout || "").trim();
}

/**
 * Run a command with output streamed to the console. Resolves on exit 0.
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command exited with code ${code}: ${cmd} ${args.join(" ")}`));
    });
  });
}

/**
 * Run a command, writing `input` to its stdin. Streams stdout/stderr to console.
 */
export function runWithInput(cmd, args = [], input = "", opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "inherit", "inherit"],
      ...opts,
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.write(input);
    child.stdin.end();
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command exited with code ${code}: ${cmd} ${args.join(" ")}`));
    });
  });
}

/**
 * Spawn a long-running command, returning the child handle.
 */
export function start(cmd, args = [], opts = {}) {
  return spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
}
