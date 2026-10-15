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
 * True when a docker failure looks like the daemon isn't reachable
 * (Docker Desktop stopped, engine pipe missing, connection refused).
 */
export function isDockerDaemonError(text) {
  const s = String(text ?? "");
  return (
    /failed to connect to the docker api/i.test(s) ||
    /cannot connect to the docker daemon/i.test(s) ||
    /docker.*daemon.*(not running|unreachable|refused)/i.test(s) ||
    /npipe/i.test(s) ||
    /dockerDesktopLinuxEngine/i.test(s) ||
    /\/\/\.\/pipe\/docker/i.test(s) ||
    /open \/\/\.\/pipe\/docker/i.test(s) ||
    /The system cannot find the file specified/i.test(s) ||
    /error during connect/i.test(s)
  );
}

/**
 * Friendly wrapper for docker-daemon failures. Keeps the original detail
 * so the underlying cause isn't lost, but leads with what to do.
 */
export function dockerUnavailableMessage(cause) {
  const detail = String(cause?.message ?? cause ?? "").trim();
  const lines = [
    "Docker isn't running or can't be reached.",
    "Start Docker Desktop (Windows/macOS) or start the Docker daemon (Linux), wait until it reports healthy, then try again.",
  ];
  if (detail) lines.push(`Details: ${detail}`);
  return lines.join("\n");
}

/**
 * Pre-flight check: fail fast with an actionable message when the docker
 * daemon isn't reachable, instead of a raw `docker build` API error.
 * Throws with a "Docker isn't running" message; resolves otherwise.
 */
export function ensureDockerAvailable() {
  const { cmd, opts } = dockerExec();
  try {
    exec(cmd, ["info"], opts);
  } catch (err) {
    throw new Error(dockerUnavailableMessage(err.message ?? err));
  }
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
