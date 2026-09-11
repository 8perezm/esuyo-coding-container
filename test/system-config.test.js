import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSystemData,
  getSystemConfig,
  patchSystemConfig,
  systemConfigManifest,
} from "../src/utils/system-config.js";

test("parseSystemData: valid full data", () => {
  const sys = parseSystemData({
    current: "v1.2.0",
    previous: "v1.1.0",
    maxEver: "v1.2.0",
    keep: "10",
  });
  assert.deepEqual(sys, { current: "v1.2.0", previous: "v1.1.0", maxEver: "v1.2.0", keep: 10 });
});

test("parseSystemData: previous may be absent or empty", () => {
  assert.equal(parseSystemData({ current: "v1.0.0", maxEver: "v1.0.0", keep: "0" }).previous, undefined);
  assert.equal(
    parseSystemData({ current: "v1.0.0", previous: "", maxEver: "v1.0.0", keep: "0" }).previous,
    undefined
  );
});

test("parseSystemData: bad current semver throws", () => {
  for (const bad of ["1.2.0", "v1.2", "latest", "v1.2.3-beta", 5, null, undefined]) {
    assert.throws(
      () => parseSystemData({ current: bad, maxEver: "v1.2.0", keep: "10" }),
      /current/
    );
  }
});

test("parseSystemData: bad previous semver throws", () => {
  assert.throws(
    () => parseSystemData({ current: "v1.0.0", previous: "latest", maxEver: "v1.0.0", keep: "10" }),
    /previous/
  );
});

test("parseSystemData: bad maxEver semver throws", () => {
  assert.throws(
    () => parseSystemData({ current: "v1.0.0", maxEver: "nope", keep: "10" }),
    /maxEver/
  );
});

test("parseSystemData: bad keep throws", () => {
  for (const bad of ["10x", "-1", "1.5", 10, null, undefined, ""]) {
    assert.throws(
      () => parseSystemData({ current: "v1.0.0", maxEver: "v1.0.0", keep: bad }),
      /keep/
    );
  }
});

test("parseSystemData: current newer than maxEver is corruption", () => {
  assert.throws(
    () => parseSystemData({ current: "v2.0.0", maxEver: "v1.0.0", keep: "10" }),
    /corrupted/
  );
});

test("parseSystemData: missing data block throws", () => {
  assert.throws(() => parseSystemData(undefined), /no data block/);
  assert.throws(() => parseSystemData(null), /no data block/);
});

test("systemConfigManifest: shape", () => {
  const cm = systemConfigManifest("coding", { current: "v1.0.0", maxEver: "v1.0.0", keep: "10" });
  assert.equal(cm.kind, "ConfigMap");
  assert.equal(cm.metadata.name, "coding-system");
  assert.equal(cm.metadata.namespace, "coding");
  assert.equal(cm.metadata.labels["coding-container"], "true");
  assert.deepEqual(cm.data, { current: "v1.0.0", maxEver: "v1.0.0", keep: "10" });
});

// --- cluster round-trip via a KUBECTL_BIN stub ---------------------------

// kubectlExec runs a .js KUBECTL_BIN directly via node (no shell), so the
// stub can be the node script itself on every platform.
function makeKubectlStub(dir) {
  const stubJs = path.join(dir, "kubectl-stub.js");
  fs.writeFileSync(
    stubJs,
    [
      'const fs = require("fs");',
      'const args = process.argv.slice(2).join(" ");',
      // No process.exit in the apply branch: it must stay alive for the
      // stdin events (a trailing process.exit(0) would kill it first).
      'if (args.startsWith("apply -f -")) {',
      '  let data = "";',
      '  process.stdin.on("data", (d) => (data += d));',
      '  process.stdin.on("end", () => { fs.writeFileSync(process.env.SYSTEM_APPLY_OUT, data); process.exit(0); });',
      '} else if (args.startsWith("get cm coding-system")) {',
      '  const f = process.env.SYSTEM_CM_JSON;',
      '  if (f && fs.existsSync(f)) { process.stdout.write(fs.readFileSync(f, "utf8")); process.exit(0); }',
      '  process.stderr.write(\'Error from server (NotFound): configmaps "coding-system" not found\\n\');',
      '  process.exit(1);',
      '} else {',
      '  process.exit(0);',
      '}',
    ].join("\n")
  );
  return stubJs;
}

const prevKubectl = process.env.KUBECTL_BIN;

test("getSystemConfig: reads and parses the ConfigMap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syscfg-"));
  const cmFile = path.join(dir, "cm.json");
  fs.writeFileSync(
    cmFile,
    JSON.stringify({
      metadata: { name: "coding-system", namespace: "coding" },
      data: { current: "v1.3.0", previous: "v1.2.0", maxEver: "v1.3.0", keep: "7" },
    })
  );
  const stub = makeKubectlStub(dir);
  process.env.KUBECTL_BIN = stub;
  process.env.SYSTEM_CM_JSON = cmFile;
  try {
    const sys = getSystemConfig("coding");
    assert.deepEqual(sys, { current: "v1.3.0", previous: "v1.2.0", maxEver: "v1.3.0", keep: 7 });
  } finally {
    process.env.KUBECTL_BIN = prevKubectl;
    delete process.env.SYSTEM_CM_JSON;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getSystemConfig: missing ConfigMap -> bootstrap hint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syscfg-"));
  const stub = makeKubectlStub(dir);
  process.env.KUBECTL_BIN = stub;
  delete process.env.SYSTEM_CM_JSON;
  try {
    assert.throws(
      () => getSystemConfig("coding"),
      (err) => /system init --tag v1\.0\.0 --keep 10/.test(err.message)
    );
  } finally {
    process.env.KUBECTL_BIN = prevKubectl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getSystemConfig: corrupted data surfaces a clear error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syscfg-"));
  const cmFile = path.join(dir, "cm.json");
  fs.writeFileSync(
    cmFile,
    JSON.stringify({
      metadata: { name: "coding-system", namespace: "coding" },
      data: { current: "banana", maxEver: "v1.0.0", keep: "10" },
    })
  );
  const stub = makeKubectlStub(dir);
  process.env.KUBECTL_BIN = stub;
  process.env.SYSTEM_CM_JSON = cmFile;
  try {
    assert.throws(() => getSystemConfig("coding"), /current/);
  } finally {
    process.env.KUBECTL_BIN = prevKubectl;
    delete process.env.SYSTEM_CM_JSON;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("patchSystemConfig: applies a valid ConfigMap (all values as strings)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syscfg-"));
  const out = path.join(dir, "applied.json");
  const stub = makeKubectlStub(dir);
  process.env.KUBECTL_BIN = stub;
  process.env.SYSTEM_APPLY_OUT = out;
  try {
    await patchSystemConfig("coding", {
      current: "v1.4.0",
      previous: "v1.3.0",
      maxEver: "v1.4.0",
      keep: 12,
    });
    const applied = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(applied.kind, "ConfigMap");
    assert.equal(applied.metadata.namespace, "coding");
    assert.deepEqual(applied.data, {
      current: "v1.4.0",
      previous: "v1.3.0",
      maxEver: "v1.4.0",
      keep: "12",
    });
  } finally {
    process.env.KUBECTL_BIN = prevKubectl;
    delete process.env.SYSTEM_APPLY_OUT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("patchSystemConfig: rejects invalid state before touching the cluster", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syscfg-"));
  const out = path.join(dir, "applied.json");
  const stub = makeKubectlStub(dir);
  process.env.KUBECTL_BIN = stub;
  process.env.SYSTEM_APPLY_OUT = out;
  try {
    await assert.rejects(
      patchSystemConfig("coding", { current: "v1.0.0", maxEver: "v0.1.0", keep: 10 }),
      /corrupted/
    );
    assert.ok(!fs.existsSync(out), "nothing must be applied on invalid state");
  } finally {
    process.env.KUBECTL_BIN = prevKubectl;
    delete process.env.SYSTEM_APPLY_OUT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
