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
// interpreter `/bin/bash\r`. The Dockerfile must strip CR itself, setup
// must provision an LF copy, and build must fail fast on a CRLF Dockerfile
// instead of pushing a broken image.
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

test("buildImage fails fast on a CRLF Dockerfile without a CR-strip safeguard", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-"));
  const dockerfile = writeCrlfDockerfile(dir);
  const cfg = loadConfig(
    writeLocal(
      "project: myproj\n" +
        "image:\n" +
        "  registry: reg.example.com/you\n" +
        `  dockerfile: ${JSON.stringify(dockerfile)}\n` +
        `  context: ${JSON.stringify(dir)}\n` +
        "  tag: v1.0.0\n" +
        "nfs:\n" +
        "  server: 10.0.0.5\n" +
        "  basePath: /workspaces\n"
    )
  );
  await assert.rejects(() => buildImage(cfg), /CRLF.*line endings/);
});

test("buildImage allows a CRLF Dockerfile that strips CR itself", async () => {
  // The shipped template repairs the heredoc at build time, so CRLF is
  // harmless there: the build must proceed past the line-ending gate.
  // Point DOCKER_BIN at a missing binary so the build then fails at the
  // docker-availability check (proving the gate was passed, without needing
  // a real daemon).
  const prevDockerBin = process.env.DOCKER_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-"));
  try {
    const dockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      "FROM scratch\nRUN cat > /entrypoint.sh <<'ENTRYPOINT' && sed -i 's/\\r$//' /entrypoint.sh && chmod +x /entrypoint.sh\n".replaceAll(
        "\n",
        "\r\n"
      )
    );
    process.env.DOCKER_BIN = path.join(dir, "no-such-docker");
    const cfg = loadConfig(
      writeLocal(
        "project: myproj\n" +
          "image:\n" +
          "  registry: reg.example.com/you\n" +
          `  dockerfile: ${JSON.stringify(dockerfile)}\n` +
          `  context: ${JSON.stringify(dir)}\n` +
          "  tag: v1.0.0\n" +
          "nfs:\n" +
          "  server: 10.0.0.5\n" +
          "  basePath: /workspaces\n"
      )
    );
    await assert.rejects(() => buildImage(cfg), /Docker isn't running/);
  } finally {
    if (prevDockerBin === undefined) delete process.env.DOCKER_BIN;
    else process.env.DOCKER_BIN = prevDockerBin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildImage still reports a missing build context before the CRLF check", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-crlf-"));
  const dockerfile = writeCrlfDockerfile(dir);
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
