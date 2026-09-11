import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// End-to-end: runs the real `index.js gc` (bare, custom-repo path) against an
// in-process mock registry, with kubectl stubbed via KUBECTL_BIN so the test
// is hermetic (no cluster, no real registry, no network).
//
// The registry holds semver versions v0.1.0..v0.5.0 plus one legacy
// timestamp tag. The project pins v0.5.0 and a deployment runs v0.1.0.
// With --keep 2 the safe keep set is {v0.5.0, v0.4.0, v0.3.0, v0.1.0}.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "src", "index.js");
const SEMVER = ["v0.1.0", "v0.2.0", "v0.3.0", "v0.4.0", "v0.5.0"];
const LEGACY = "20260101000000";

let server, PORT, host, tmp, home, xdg, configPath, kubectlStub;
const deleted = [];
let registryTags = [...SEMVER, LEGACY];

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const auth = req.headers.authorization || "";
      if (req.method === "GET" && url.pathname === "/token") {
        const expected = "Basic " + Buffer.from("user:pass").toString("base64");
        if (auth !== expected) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mock"' }); return res.end(); }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ token: "tok" }));
      }
      const ok = auth === "Bearer tok";
      const challenge = `Bearer realm="http://127.0.0.1:${PORT}/token",service="mock",scope="repository:foo/bar:pull,push"`;
      if (req.method === "GET" && url.pathname === "/v2/foo/bar/tags/list") {
        if (!ok) { res.writeHead(401, { "WWW-Authenticate": challenge }); return res.end(); }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ name: "foo/bar", tags: registryTags }));
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/v2/foo/bar/tags/")) {
        if (!ok) { res.writeHead(401, { "WWW-Authenticate": challenge }); return res.end(); }
        const tag = decodeURIComponent(url.pathname.split("/").pop());
        deleted.push(tag);
        registryTags = registryTags.filter((t) => t !== tag);
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
    server.on("clientError", (err, sock) => sock.destroy()); // drop the TLS scheme probe
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { PORT = server.address().port; resolve(); });
  });
}

function writeKubectlStub() {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const json = JSON.stringify({
    items: [{ spec: { template: { spec: { containers: [{ image: `${host}/foo/bar:v0.1.0` }] } } } }],
  });
  if (process.platform === "win32") {
    kubectlStub = path.join(bin, "kubectl.cmd");
    fs.writeFileSync(kubectlStub, `@echo off\r\necho ${json}\r\n`);
  } else {
    kubectlStub = path.join(bin, "kubectl.sh");
    fs.writeFileSync(kubectlStub, `#!/bin/sh\necho '${json}'\n`);
    fs.chmodSync(kubectlStub, 0o755);
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX, "-c", configPath, ...args], {
      env: { ...process.env, KUBECTL_BIN: kubectlStub, USERPROFILE: home, HOME: home, XDG_CONFIG_HOME: xdg },
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error("gc CLI timed out")); }, 20000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

before(async () => {
  await startServer();
  host = `127.0.0.1:${PORT}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gc-cli-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".docker"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".docker", "config.json"),
    JSON.stringify({ auths: { [host]: { auth: Buffer.from("user:pass").toString("base64") } } })
  );
  xdg = path.join(tmp, "xdg");
  fs.mkdirSync(xdg, { recursive: true });
  writeKubectlStub();
  configPath = path.join(tmp, "config.yaml");
  fs.writeFileSync(
    configPath,
    [
      "image:",
      `  registry: ${host}/foo`,
      "  name: bar",
      `  dockerfile: ${path.join(ROOT, "Dockerfile")}`,
      `  context: ${ROOT}`,
      "  tag: v0.5.0",
      "nfs:",
      "  server: 1.2.3.4",
      "  basePath: /workspaces",
    ].join("\n")
  );
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("gc deletes tags beyond the keep window, keeping pin + predecessors + in-use", async () => {
  const { code, stdout } = await runCli(["gc", "--keep", "2"]);
  assert.equal(code, 0, stdout);
  // kept = pin v0.5.0 + 2 predecessors (v0.4.0, v0.3.0) + in-use v0.1.0
  assert.match(stdout, /Found 6 tag\(s\); in use: v0\.1\.0; keeping 4, deleting 2\./);
  // oldest first: v0.2.0 (semver) then the legacy timestamp tag
  assert.deepEqual(deleted, ["v0.2.0", LEGACY]);
});

test("gc --dry-run plans deletions but deletes nothing", async () => {
  // Re-add the previously deleted tags so the plan is non-empty again.
  registryTags = [...SEMVER, LEGACY];
  const beforeCount = deleted.length;
  const { code, stdout } = await runCli(["gc", "--keep", "2", "--dry-run"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /would delete 2/);
  assert.match(stdout, /\(dry run — nothing was deleted\)/);
  assert.equal(deleted.length, beforeCount);
});
