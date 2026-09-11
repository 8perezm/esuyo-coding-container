import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// End-to-end for the `system` group and the global-mode deploy float, run
// against an in-process mock registry with kubectl and docker stubbed
// (KUBECTL_BIN + DOCKER_BIN), so the test is hermetic (no cluster, no
// registry, no network, no real docker builds).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "src", "index.js");

let server, PORT, host, tmp, home, xdg, stubDir, configPath, customConfigPath, kubectlStub, dockerStub, dockerLog;
let globalTags = [];
const registryDeletes = [];

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const m = url.pathname.match(/^\/v2\/(.+)\/tags\/list$/);
      if (req.method === "GET" && m) {
        if (m[1] !== "foo/coding-container") {
          res.writeHead(404);
          return res.end(JSON.stringify({ errors: [{ code: "NAME_UNKNOWN" }] }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ name: "foo/coding-container", tags: globalTags }));
      }
      const d = url.pathname.match(/^\/v2\/foo\/coding-container\/tags\/(.+)$/);
      if (req.method === "DELETE" && d) {
        const tag = decodeURIComponent(d[1]);
        registryDeletes.push(tag);
        globalTags = globalTags.filter((t) => t !== tag);
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

function writeStubs() {
  stubDir = path.join(tmp, "stub");
  fs.mkdirSync(stubDir, { recursive: true });

  fs.writeFileSync(
    path.join(stubDir, "kubectl-stub.js"),
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.env.KUBECTL_STUB_DIR;',
      'const joined = process.argv.slice(2).join(" ");',
      'fs.appendFileSync(path.join(dir, "kubectl.log"), joined + "\\n");',
      'function out(s) { process.stdout.write(s + "\\n"); }',
      'function die(msg) { process.stderr.write(msg + "\\n"); process.exit(1); }',
      'if (joined.startsWith("get cm coding-system")) {',
      '  const f = path.join(dir, "cm.json");',
      '  if (fs.existsSync(f)) out(fs.readFileSync(f, "utf8"));',
      '  else die(\'Error from server (NotFound): configmaps "coding-system" not found\');',
      '} else if (joined.startsWith("get namespace")) {',
      '  out("namespace/coding");',
      '} else if (joined.startsWith("create namespace")) {',
      '  out("namespace/coding created");',
      '} else if (joined.startsWith("get svc")) {',
      '  out(JSON.stringify({ items: [] }));',
      '} else if (joined.startsWith("get deploy")) {',
      '  const f = path.join(dir, "deploys.json");',
      '  out(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : JSON.stringify({ items: [] }));',
      '} else if (joined.startsWith("get secret")) {',
      '  die(\'Error from server (NotFound): secrets "coding-127-0-0-1" not found\');',
      '} else if (joined.startsWith("apply -f -")) {',
      '  let data = "";',
      '  process.stdin.setEncoding("utf8");',
      '  process.stdin.on("data", (d) => (data += d));',
      '  process.stdin.on("end", () => {',
      '    fs.appendFileSync(path.join(dir, "applied.log"), data + "\\n---\\n");',
      '    try {',
      '      const obj = JSON.parse(data);',
      '      if (obj && obj.kind === "ConfigMap" && obj.metadata && obj.metadata.name === "coding-system")',
      '        fs.writeFileSync(path.join(dir, "cm.json"), data);',
      '    } catch (e) {}',
      '    out("configured");',
      '    process.exit(0);',
      '  });',
      '} else if (joined.startsWith("rollout status")) {',
      '  out("deployment complete");',
      '} else if (joined.startsWith("get nodes")) {',
      '  out("10.0.0.9");',
      '} else if (joined.startsWith("delete")) {',
      '  out("deleted");',
      '} else {',
      '  die("unexpected kubectl args: " + joined);',
      '}',
    ].join("\n")
  );

  // kubectlExec runs a .js KUBECTL_BIN directly via node (no shell), so the
  // stub can be the node script itself on every platform.
  kubectlStub = path.join(stubDir, "kubectl-stub.js");
  dockerLog = path.join(tmp, "docker.log");
  if (process.platform === "win32") {
    dockerStub = path.join(stubDir, "docker.cmd");
    fs.writeFileSync(dockerStub, `@echo off\r\necho docker %* >> "${dockerLog}"\r\n`);
  } else {
    dockerStub = path.join(stubDir, "docker.sh");
    fs.writeFileSync(dockerStub, `#!/bin/sh\necho "docker $@" >> "${dockerLog}"\n`);
    fs.chmodSync(dockerStub, 0o755);
  }
}

function runCli(args, config = configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX, "-c", config, ...args], {
      env: {
        ...process.env,
        KUBECTL_BIN: kubectlStub,
        KUBECTL_STUB_DIR: stubDir,
        DOCKER_BIN: dockerStub,
        USERPROFILE: home,
        HOME: home,
        XDG_CONFIG_HOME: xdg,
      },
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI timed out")); }, 30000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function readCm() {
  return JSON.parse(fs.readFileSync(path.join(stubDir, "cm.json"), "utf8"));
}

function resetApplied() {
  fs.rmSync(path.join(stubDir, "applied.log"), { force: true });
}

function resetDocker() {
  fs.rmSync(dockerLog, { force: true });
}

function appliedLog() {
  return fs.readFileSync(path.join(stubDir, "applied.log"), "utf8");
}

function dockerLogLines() {
  if (!fs.existsSync(dockerLog)) return [];
  return fs.readFileSync(dockerLog, "utf8").split("\n").filter(Boolean);
}

before(async () => {
  await startServer();
  host = `127.0.0.1:${PORT}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sys-cli-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  xdg = path.join(tmp, "xdg");
  fs.mkdirSync(xdg, { recursive: true });
  writeStubs();
  // Global-mode project config: no image.* keys. Only `system create`
  // (the image build) needs a Dockerfile, so copy the repo's one here.
  fs.copyFileSync(path.join(ROOT, "Dockerfile"), path.join(tmp, "Dockerfile"));
  configPath = path.join(tmp, "config.yaml");
  fs.writeFileSync(
    configPath,
    [
      "project: myproject",
      "image:",
      `  registry: ${host}/foo`,
      "nfs:",
      "  server: 1.2.3.4",
      "  basePath: /workspaces",
    ].join("\n")
  );
  // Custom-mode project config: own Dockerfile + pin -> coding-myproj repo.
  customConfigPath = path.join(tmp, "custom-config.yaml");
  fs.writeFileSync(
    customConfigPath,
    [
      "project: myproj",
      "image:",
      `  registry: ${host}/foo`,
      `  dockerfile: ${path.join(ROOT, "Dockerfile")}`,
      `  context: ${ROOT}`,
      "  tag: v1.0.0",
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

test("deploy without the coding-system ConfigMap fails with the init hint", async () => {
  const { code, stderr } = await runCli(["deploy"]);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /coding-container system init --tag v1\.0\.0 --keep 10/);
});

test("system init creates the ConfigMap", async () => {
  const { code, stdout } = await runCli(["system", "init", "--tag", "v1.0.0", "--keep", "10"]);
  assert.equal(code, 0, stdout);
  const cm = readCm();
  assert.equal(cm.metadata.name, "coding-system");
  assert.equal(cm.metadata.namespace, "coding");
  assert.equal(cm.data.current, "v1.0.0");
  assert.equal(cm.data.maxEver, "v1.0.0");
  assert.equal(cm.data.keep, "10");
  assert.equal(cm.data.previous, undefined);
});

test("system init fails when the ConfigMap already exists", async () => {
  const { code, stderr } = await runCli(["system", "init", "--tag", "v9.9.9"]);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /already exists/);
});

test("deploy floats on the ConfigMap's current version", async () => {
  resetApplied();
  const { code, stdout } = await runCli(["deploy"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Global image mode: deploying version v1\.0\.0/);
  assert.match(appliedLog(), new RegExp(`image: ${host}/foo/coding-container:v1\\.0\\.0`));
});

test("system create publishes a new version and repoints", async () => {
  resetDocker();
  const { code, stdout } = await runCli(["system", "create", "--tag", "v1.1.0"]);
  assert.equal(code, 0, stdout);
  const lines = dockerLogLines();
  assert.ok(lines.some((l) => l.includes(`build -t ${host}/foo/coding-container:v1.1.0`)), `docker log: ${lines}`);
  assert.ok(lines.some((l) => l.includes(`push ${host}/foo/coding-container:v1.1.0`)), `docker log: ${lines}`);
  const cm = readCm();
  assert.equal(cm.data.current, "v1.1.0");
  assert.equal(cm.data.previous, "v1.0.0");
  assert.equal(cm.data.maxEver, "v1.1.0");
  globalTags = ["v1.0.0", "v1.1.0"];
});

test("the next deploy floats to the new version without any config edit", async () => {
  resetApplied();
  const { code, stdout } = await runCli(["deploy"]);
  assert.equal(code, 0, stdout);
  assert.match(appliedLog(), new RegExp(`image: ${host}/foo/coding-container:v1\\.1\\.0`));
});

test("system rollback repoints only (no docker, no delete)", async () => {
  resetDocker();
  const { code, stdout } = await runCli(["system", "rollback"]);
  assert.equal(code, 0, stdout);
  assert.deepEqual(dockerLogLines(), []);
  assert.deepEqual(registryDeletes, []);
  const cm = readCm();
  assert.equal(cm.data.current, "v1.0.0");
  assert.equal(cm.data.previous, "v1.1.0");
  assert.equal(cm.data.maxEver, "v1.1.0");
});

test("system create refuses to reuse a rolled-back tag (<= maxEver)", async () => {
  const { code, stderr } = await runCli(["system", "create", "--tag", "v1.1.0"]);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /not greater than maxEver v1\.1\.0/);
});

test("system create refuses a tag that already exists in the registry", async () => {
  globalTags = ["v1.0.0", "v1.1.0", "v2.0.0"];
  const { code, stderr } = await runCli(["system", "create", "--tag", "v2.0.0"]);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /already exists/);
  globalTags = ["v1.0.0", "v1.1.0"];
});

test("system create of a fresh higher version succeeds after rollback", async () => {
  resetDocker();
  const { code, stdout } = await runCli(["system", "create", "--tag", "v1.2.0"]);
  assert.equal(code, 0, stdout);
  const cm = readCm();
  assert.equal(cm.data.current, "v1.2.0");
  assert.equal(cm.data.previous, "v1.0.0");
  assert.equal(cm.data.maxEver, "v1.2.0");
  globalTags = ["v1.0.0", "v1.1.0", "v1.2.0"];
});

test("project create in global mode spawns zero docker calls", async () => {
  resetDocker();
  resetApplied();
  const { code, stdout } = await runCli(["create"]);
  assert.equal(code, 0, stdout);
  assert.deepEqual(dockerLogLines(), []);
  assert.match(appliedLog(), new RegExp(`image: ${host}/foo/coding-container:v1\\.2\\.0`));
});

test("build/push refuse in global mode", async () => {
  const b = await runCli(["build"]);
  assert.equal(b.code, 1, b.stdout);
  assert.match(b.stderr, /system create --tag vX\.Y\.Z/);
  const p = await runCli(["push"]);
  assert.equal(p.code, 1, p.stdout);
  assert.match(p.stderr, /system create --tag vX\.Y\.Z/);
});

test("system gc --dry-run keeps current + previous + in-use + 10 back", async () => {
  globalTags = Array.from({ length: 15 }, (_, i) => `v1.${i + 1}.0`);
  fs.writeFileSync(
    path.join(stubDir, "cm.json"),
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "coding-system", namespace: "coding", labels: { "coding-container": "true" } },
      data: { current: "v1.15.0", previous: "v1.14.0", maxEver: "v1.15.0", keep: "10" },
    })
  );
  // A deployment pins v1.2.0 — outside the 10-back window of v1.15.0.
  fs.writeFileSync(
    path.join(stubDir, "deploys.json"),
    JSON.stringify({
      items: [
        {
          spec: {
            template: {
              spec: { containers: [{ image: `${host}/foo/coding-container:v1.2.0` }] },
            },
          },
        },
      ],
    })
  );
  const { code, stdout } = await runCli(["system", "gc", "--dry-run"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Found 15 tag\(s\); in use: v1\.2\.0; keeping 12, would delete 3\./);
  assert.match(stdout, /would delete v1\.1\.0/);
  assert.match(stdout, /would delete v1\.3\.0/);
  assert.match(stdout, /would delete v1\.4\.0/);
  assert.doesNotMatch(stdout, /would delete v1\.15\.0/);
  assert.doesNotMatch(stdout, /would delete v1\.14\.0/);
  assert.doesNotMatch(stdout, /would delete v1\.5\.0/);
  assert.doesNotMatch(stdout, /would delete v1\.2\.0/);
  assert.deepEqual(registryDeletes, []);
});

test("system gc --dry-run reports legacy non-semver tags without counting them", async () => {
  globalTags = ["v1.0.0", "v1.1.0", "20260901000000"];
  fs.writeFileSync(
    path.join(stubDir, "cm.json"),
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "coding-system", namespace: "coding", labels: { "coding-container": "true" } },
      data: { current: "v1.1.0", previous: "v1.0.0", maxEver: "v1.1.0", keep: "10" },
    })
  );
  fs.rmSync(path.join(stubDir, "deploys.json"), { force: true });
  const { code, stdout } = await runCli(["system", "gc", "--dry-run"]);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /1 non-semver tag\(s\) \(20260901000000\)/);
  assert.match(stdout, /would delete 20260901000000/);
  assert.doesNotMatch(stdout, /would delete v1\.0\.0/);
});

test("custom project create builds+pushes only coding-<project>, never the global repo", async () => {
  resetDocker();
  resetApplied();
  const { code, stdout } = await runCli(["create"], customConfigPath);
  assert.equal(code, 0, stdout);
  const lines = dockerLogLines();
  assert.ok(lines.some((l) => l.includes(`build -t ${host}/foo/coding-myproj:v1.0.0`)), `docker log: ${lines}`);
  assert.ok(lines.some((l) => l.includes(`push ${host}/foo/coding-myproj:v1.0.0`)), `docker log: ${lines}`);
  assert.ok(!lines.some((l) => l.includes("/coding-container:")), `docker log: ${lines}`);
  assert.match(appliedLog(), new RegExp(`image: ${host}/foo/coding-myproj:v1\\.0\\.0`));
});
