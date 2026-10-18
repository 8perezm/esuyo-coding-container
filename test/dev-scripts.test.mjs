import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.scripts ?? {};
}

test("dev-stop script kills the running Vite dev server", () => {
  const scripts = readPackageScripts();
  assert.ok(scripts["dev-stop"], "package.json must define a dev-stop script");
  assert.equal(scripts["dev-stop"], "node web/kill-dev.js");
});

test("dev-stop stays in sync with dev:kill", () => {
  const scripts = readPackageScripts();
  assert.ok(scripts["dev:kill"], "package.json must still define dev:kill");
  assert.equal(scripts["dev-stop"], scripts["dev:kill"]);
});

test("kill-dev script targets the Vite port by default", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "web", "kill-dev.js"), "utf8");
  assert.match(src, /VITE_PORT\s*=\s*3400/);
  assert.match(src, /readApiPort\(\)/);
});
