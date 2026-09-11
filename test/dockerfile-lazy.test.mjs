import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression test: `deploy`/`validate`/`ssh` in global mode must not require
// a Dockerfile on disk. Only the build path (buildImage, used by `build`,
// custom-mode `create` and `system create`) needs one. This covers the
// failure where a stale absolute dockerfile path in the global config
// (left over from the ~/.config/esuyo-coding-container -> ~/.config/
// coding-container rename) broke every command with
// "config: dockerfile not found: ...esuyo-coding-container\Dockerfile".
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const REAL_DOCKERFILE = path.join(PROJECT_ROOT, "Dockerfile");

// Fresh, empty global-config layer per test (only DEFAULTS + local merge).
beforeEach(() => {
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-lazy-xdg-"));
});

const { loadConfig } = await import("../src/config.js");
const { buildImage } = await import("../src/commands/build.js");

function writeLocal(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-lazy-cfg-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yamlText);
  return file;
}

function writeGlobal(yamlText) {
  const dir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yamlText);
}

const GLOBAL_LAYER = `image:
  registry: reg.example.com/you
nfs:
  server: 10.0.0.5
  basePath: /workspaces
`;

test("global-mode loadConfig succeeds with no Dockerfile anywhere on disk", () => {
  const cfg = loadConfig(
    writeLocal("project: my-project\n" + GLOBAL_LAYER)
  );
  assert.equal(cfg.imageMode, "global");
  assert.equal(cfg.project, "my-project");
});

test("stale absolute dockerfile path in the global layer does not break loadConfig", () => {
  // The exact shape left behind by the old setup: absolute Windows paths
  // pointing at the pre-rename config folder.
  writeGlobal(
    "image:\n" +
      "  registry: reg.example.com/you\n" +
      "  dockerfile: C:\\Users\\miguel\\.config\\esuyo-coding-container\\Dockerfile\n" +
      "  context: C:\\Users\\miguel\\.config\\esuyo-coding-container\n" +
      "nfs:\n" +
      "  server: 10.0.0.5\n" +
      "  basePath: /workspaces\n"
  );
  const cfg = loadConfig(writeLocal("project: esuyo-gateway\nk8s:\n  nodePort: 30029\n"));
  assert.equal(cfg.imageMode, "global");
  assert.equal(cfg.project, "esuyo-gateway");
});

test("buildImage fails fast on a missing Dockerfile", async () => {
  const cfg = loadConfig(writeLocal("project: my-project\n" + GLOBAL_LAYER));
  await assert.rejects(() => buildImage(cfg), /dockerfile not found/);
});

test("buildImage fails fast on a missing build context", async () => {
  const dockerfile = REAL_DOCKERFILE.replaceAll("\\", "/");
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
  assert.equal(cfg.imageMode, "custom");
  await assert.rejects(() => buildImage(cfg), /build context not found/);
});
