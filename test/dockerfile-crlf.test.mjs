import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the devzone-test CrashLoopBackOff:
// `exec /entrypoint.sh: no such file or directory` (exit 255).
// The repo Dockerfile builds /entrypoint.sh via a heredoc; a Windows (CRLF)
// checkout bakes '\r' into the script, so the kernel looks for the
// interpreter `/bin/bash\r`. The Dockerfile strips CR itself, setup
// provisions an LF copy, and build/setup automatically normalize a CRLF
// Dockerfile in place instead of failing and asking the user to hand-edit
// the file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const REPO_DOCKERFILE = path.join(PROJECT_ROOT, "Dockerfile");

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-xdg-"));
});

const { loadConfig } = await import("../src/config.js");
const { buildImage } = await import("../src/commands/build.js");
const { setup } = await import("../src/commands/setup.js");

function writeLocal(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-cfg-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yamlText);
  return file;
}

function writeCrlfDockerfile(dir, text = "FROM scratch\nRUN echo hi\n") {
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, text.replaceAll("\n", "\r\n"));
  return file;
}

function writeDockerStub(dir) {
  const log = path.join(dir, "docker.log");
  let stub;
  if (process.platform === "win32") {
    stub = path.join(dir, "docker-stub.cmd");
    fs.writeFileSync(stub, `@echo off\r\necho docker %* >> "${log}"\r\n`);
  } else {
    stub = path.join(dir, "docker-stub.sh");
    fs.writeFileSync(stub, `#!/bin/sh\necho "docker $@" >> "${log}"\n`);
    fs.chmodSync(stub, 0o755);
  }
  return { stub, log };
}

function customConfig(dockerfile, context) {
  return loadConfig(
    writeLocal(
      "project: myproj\n" +
        "image:\n" +
        "  registry: reg.example.com/you\n" +
        `  dockerfile: ${JSON.stringify(dockerfile)}\n` +
        `  context: ${JSON.stringify(context)}\n` +
        "  tag: v1.0.0\n" +
        "nfs:\n" +
        "  server: 10.0.0.5\n" +
        "  basePath: /workspaces\n"
    )
  );
}

test("repo Dockerfile strips CR from the generated /entrypoint.sh", () => {
  const content = fs.readFileSync(REPO_DOCKERFILE, "utf8");
  assert.ok(
    content.includes("cat > /entrypoint.sh <<'ENTRYPOINT'"),
    "expected the /entrypoint.sh heredoc to still exist"
  );
  assert.ok(
    content.includes("sed -i 's/\\r$//' /entrypoint.sh"),
    "expected the entrypoint step to strip carriage returns (CRLF-proof)"
  );
});

test("the strip step repairs a CRLF-checked-out heredoc body", () => {
  const content = fs.readFileSync(REPO_DOCKERFILE, "utf8").replaceAll("\r\n", "\n");
  const body = content.split("<<'ENTRYPOINT'")[1].split("ENTRYPOINT")[0];
  const crlfBody = body.replaceAll("\n", "\r\n");
  assert.ok(crlfBody.includes("\r\n"), "simulated Windows checkout should contain CRLF");
  const repaired = crlfBody.replaceAll("\r\n", "\n");
  assert.ok(!repaired.includes("\r"), "CRLF->LF normalization must clear all CR");
  assert.ok(repaired.includes("#!/bin/bash\n"), "shebang must be LF-only after repair");
});

test("buildImage normalizes a CRLF Dockerfile in place and builds", async () => {
  // The user-facing case: an older setup provisioned a CRLF Dockerfile.
  // The build must repair it automatically (with a warning) instead of
  // failing and asking the user to hand-edit the file.
  const prevDockerBin = process.env.DOCKER_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-"));
  try {
    const dockerfile = writeCrlfDockerfile(dir);
    const { stub, log } = writeDockerStub(dir);
    process.env.DOCKER_BIN = stub;
    await buildImage(customConfig(dockerfile, dir));
    const content = fs.readFileSync(dockerfile, "utf8");
    assert.ok(!content.includes("\r"), "Dockerfile must be LF-only after the build");
    assert.equal(content, "FROM scratch\nRUN echo hi\n", "only line endings may change");
    assert.match(fs.readFileSync(log, "utf8"), /build/, "docker build must have run");
  } finally {
    if (prevDockerBin === undefined) delete process.env.DOCKER_BIN;
    else process.env.DOCKER_BIN = prevDockerBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildImage leaves an LF Dockerfile untouched", async () => {
  const prevDockerBin = process.env.DOCKER_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-"));
  try {
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM scratch\nRUN echo hi\n");
    const { stub } = writeDockerStub(dir);
    process.env.DOCKER_BIN = stub;
    await buildImage(customConfig(dockerfile, dir));
    assert.equal(fs.readFileSync(dockerfile, "utf8"), "FROM scratch\nRUN echo hi\n");
  } finally {
    if (prevDockerBin === undefined) delete process.env.DOCKER_BIN;
    else process.env.DOCKER_BIN = prevDockerBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildImage still reports a missing build context before normalizing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-"));
  const dockerfile = writeCrlfDockerfile(dir);
  const before = fs.readFileSync(dockerfile, "utf8");
  const cfg = loadConfig(
    writeLocal(
      "project: myproj\n" +
        "image:\n" +
        "  registry: reg.example.com/you\n" +
        `  dockerfile: ${JSON.stringify(dockerfile)}\n` +
        "  context: /nonexistent-context-dir\n" +
        "  tag: v1.0.0\n" +
        "nfs:\n" +
        "  server: 10.0.0.5\n" +
        "  basePath: /workspaces\n"
    )
  );
  await assert.rejects(() => buildImage(cfg), /build context not found/);
  assert.equal(fs.readFileSync(dockerfile, "utf8"), before, "failed builds must not touch the file");
});

test("setup normalizes an existing CRLF Dockerfile in place", async () => {
  const prevKubectl = process.env.KUBECTL_BIN;
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-stub-"));
  try {
    const stub = path.join(stubDir, "kubectl-stub.js");
    fs.writeFileSync(stub, "process.exit(0);\n");
    process.env.KUBECTL_BIN = stub;
    // Pre-seed the key pair so setup() never shells out to ssh-keygen.
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
    const keysDir = path.join(globalDir, "keys");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, "id_ed25519"), "dummy-private");
    fs.writeFileSync(path.join(keysDir, "id_ed25519.pub"), "dummy-public");
    // An older setup provisioned a CRLF Dockerfile (old template, no
    // CR-strip safeguard): setup must repair it instead of leaving a file
    // that can only produce a broken image.
    const existing = path.join(globalDir, "Dockerfile");
    fs.writeFileSync(existing, "FROM scratch\nRUN echo hi\n".replaceAll("\n", "\r\n"));

    await setup({
      registry: "reg.example.com/you",
      nfsServer: "10.0.0.5",
      nfsBasePath: "/workspaces",
      namespace: "coding",
    });

    const content = fs.readFileSync(existing, "utf8");
    assert.equal(content, "FROM scratch\nRUN echo hi\n", "only line endings may change");
  } finally {
    if (prevKubectl === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = prevKubectl;
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});
test("setup provisions an LF-only Dockerfile", async () => {
  const prevKubectl = process.env.KUBECTL_BIN;
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-stub-"));
  try {
    const stub = path.join(stubDir, "kubectl-stub.js");
    fs.writeFileSync(stub, "process.exit(0);\n");
    process.env.KUBECTL_BIN = stub;
    // Pre-seed the key pair so setup() never shells out to ssh-keygen.
    const keysDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container", "keys");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, "id_ed25519"), "dummy-private");
    fs.writeFileSync(path.join(keysDir, "id_ed25519.pub"), "dummy-public");

    await setup({
      registry: "reg.example.com/you",
      nfsServer: "10.0.0.5",
      nfsBasePath: "/workspaces",
      namespace: "coding",
    });

    const provisioned = path.join(process.env.XDG_CONFIG_HOME, "coding-container", "Dockerfile");
    assert.ok(fs.existsSync(provisioned), "setup must provision a Dockerfile");
    const content = fs.readFileSync(provisioned, "utf8");
    assert.ok(!content.includes("\r"), "provisioned Dockerfile must be LF-only");
    assert.ok(
      content.includes("sed -i 's/\\r$//' /entrypoint.sh"),
      "provisioned Dockerfile must carry the CRLF-proof entrypoint step"
    );
  } finally {
    if (prevKubectl === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = prevKubectl;
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test("repo Dockerfile defaults to Node 26 with npm-installed corepack", () => {
  // Regression test: Node 25+ no longer ships corepack, so a bare
  // `corepack enable` fails with exit 127 (seen on the Node 26 bump).
  const content = fs.readFileSync(REPO_DOCKERFILE, "utf8");
  assert.ok(
    content.includes("ARG NODE_VERSION=26"),
    "expected the default Node version to be 26"
  );
  assert.ok(
    content.includes("npm install -g corepack@latest"),
    "expected corepack to be installed via npm before `corepack enable`"
  );
});

test("setup renders NODE_VERSION 26 and provisions opencode defaults", async () => {
  const prevKubectl = process.env.KUBECTL_BIN;
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-opencode-stub-"));
  try {
    const stub = path.join(stubDir, "kubectl-stub.js");
    fs.writeFileSync(stub, "process.exit(0);\n");
    process.env.KUBECTL_BIN = stub;
    // Pre-seed the key pair so setup() never shells out to ssh-keygen.
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
    const keysDir = path.join(globalDir, "keys");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, "id_ed25519"), "dummy-private");
    fs.writeFileSync(path.join(keysDir, "id_ed25519.pub"), "dummy-public");

    await setup({
      registry: "reg.example.com/you",
      nfsServer: "10.0.0.5",
      nfsBasePath: "/workspaces",
      namespace: "coding",
    });

    const cfgText = fs.readFileSync(path.join(globalDir, "config.yaml"), "utf8");
    assert.ok(
      cfgText.includes('NODE_VERSION: "26"'),
      "fresh global config must default to Node 26"
    );
    for (const rel of [
      "opencode/opencode.json",
      "opencode/cli.json",
      "opencode/esuyo-opencode-custom-provider.json",
    ]) {
      const file = path.join(globalDir, rel);
      assert.ok(fs.existsSync(file), `setup must provision ${rel}`);
      const text = fs.readFileSync(file, "utf8");
      assert.ok(!text.includes("\r"), `${rel} must be LF-only`);
    }
    const agentDir = path.join(globalDir, "opencode", "agent");
    assert.ok(
      fs.existsSync(path.join(agentDir, "orchestrator.md")),
      "setup must provision the default opencode agents"
    );

    // Re-running setup must not overwrite user edits to opencode files.
    const cliFile = path.join(globalDir, "opencode", "cli.json");
    fs.writeFileSync(cliFile, '{"edited":true}\n');
    await setup({
      registry: "reg.example.com/you",
      nfsServer: "10.0.0.5",
      nfsBasePath: "/workspaces",
      namespace: "coding",
    });
    assert.equal(
      fs.readFileSync(cliFile, "utf8"),
      '{"edited":true}\n',
      "existing opencode files must be left untouched"
    );
  } finally {
    if (prevKubectl === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = prevKubectl;
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});
