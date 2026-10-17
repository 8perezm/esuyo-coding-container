import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NAMESPACE_LABEL,
  SETUP_ANNOTATIONS,
  parseNamespaces,
  getNamespaces,
  readNamespaceSetupValues,
} from "../src/utils/namespaces.js";
import { ensureNamespace } from "../src/commands/deploy.js";
import {
  PLACEHOLDERS,
  normalizeNamespace,
  setupAnnotationPairs,
  setup,
} from "../src/commands/setup.js";

// --- pure parseNamespaces -------------------------------------------------

test("namespace label and annotation keys", () => {
  assert.equal(NAMESPACE_LABEL, "coding-container=true");
  assert.deepEqual(SETUP_ANNOTATIONS, {
    registry: "coding-container.io/registry",
    nfsServer: "coding-container.io/nfs-server",
    nfsBasePath: "coding-container.io/nfs-base-path",
  });
});

function nsItem(name, { annotations, createdAt = "2026-10-01T00:00:00Z" } = {}) {
  const metadata = { name };
  if (annotations !== undefined) metadata.annotations = annotations;
  if (createdAt !== undefined) metadata.creationTimestamp = createdAt;
  return { metadata };
}

function cmItem(namespace, name = "coding-system") {
  return { metadata: { name, namespace } };
}

test("parseNamespaces marks initialized from the coding-system list", () => {
  const nsJson = {
    items: [nsItem("team-alpha"), nsItem("dev-miguel")],
  };
  const cmJson = { items: [cmItem("team-alpha")] };
  const out = parseNamespaces(nsJson, cmJson);
  assert.deepEqual(
    out.map((n) => [n.name, n.initialized]),
    [
      ["dev-miguel", false],
      ["team-alpha", true],
    ]
  );
});

test("parseNamespaces extracts setupValues from annotations", () => {
  const out = parseNamespaces(
    {
      items: [
        nsItem("team-alpha", {
          annotations: {
            "coding-container.io/registry": "registry.example.com/team",
            "coding-container.io/nfs-server": "10.0.0.5",
            "coding-container.io/nfs-base-path": "/workspaces",
            "unrelated.io/note": "ignored",
          },
        }),
      ],
    },
    { items: [cmItem("team-alpha")] }
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].setupValues, {
    registry: "registry.example.com/team",
    nfsServer: "10.0.0.5",
    nfsBasePath: "/workspaces",
  });
  assert.equal(out[0].createdAt, "2026-10-01T00:00:00Z");
});

test("parseNamespaces falls back to namespace-only prefill without annotations", () => {
  const out = parseNamespaces({ items: [nsItem("coding")] }, { items: [] });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "coding");
  assert.equal(out[0].initialized, false);
  assert.deepEqual(out[0].setupValues, {});
});

test("parseNamespaces skips blank annotation values and nameless items", () => {
  const out = parseNamespaces(
    {
      items: [
        nsItem("team-alpha", {
          annotations: {
            "coding-container.io/registry": "  ",
            "coding-container.io/nfs-server": "10.0.0.5",
          },
        }),
        { metadata: {} },
        null,
      ],
    },
    { items: [] }
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].setupValues, { nfsServer: "10.0.0.5" });
});

test("parseNamespaces ignores non-coding-system ConfigMaps", () => {
  const out = parseNamespaces(
    { items: [nsItem("team-alpha")] },
    { items: [cmItem("team-alpha", "something-else")] }
  );
  assert.equal(out[0].initialized, false);
});

test("parseNamespaces degrades to [] on invalid JSON shapes", () => {
  assert.deepEqual(parseNamespaces("{{{ not json", "???"), []);
  assert.deepEqual(parseNamespaces(null, undefined), []);
  assert.deepEqual(parseNamespaces({ items: "nope" }, { items: [] }), []);
  assert.deepEqual(parseNamespaces({ kind: "NamespaceList" }, { items: [] }), []);
  assert.deepEqual(parseNamespaces('{"items":[]}', '{"items":[]}'), []);
});

// --- kubectl stub plumbing -------------------------------------------------

// kubectlExec runs a .js KUBECTL_BIN directly via node (no shell), so the
// stub records argv and serves canned JSON on every platform.
function makeKubectlStub(dir) {
  const stubJs = path.join(dir, "kubectl-stub.js");
  fs.writeFileSync(
    stubJs,
    [
      'const fs = require("fs");',
      "const argv = process.argv.slice(2);",
      'fs.appendFileSync(process.env.NS_RECORD, argv.join(" ") + "\\n");',
      'if (process.env.NS_FAIL_ALL === "1") { process.stderr.write("simulated offline\\n"); process.exit(1); }',
      'const joined = argv.join(" ");',
      'if (joined.startsWith("get namespace ")) {',
      '  const f = process.env.NS_GET_NS_JSON;',
      '  if (f && fs.existsSync(f)) { process.stdout.write(fs.readFileSync(f, "utf8")); process.exit(0); }',
      '  process.exit(Number(process.env.NS_GET_NS_STATUS || "0"));',
      "}",
      'if (joined.startsWith("get ns ")) {',
      '  const f = process.env.NS_NS_JSON;',
      '  if (f && fs.existsSync(f)) { process.stdout.write(fs.readFileSync(f, "utf8")); process.exit(0); }',
      '  process.stderr.write("namespaces not found\\n"); process.exit(1);',
      "}",
      'if (joined.startsWith("get cm ")) {',
      '  const f = process.env.NS_CM_JSON;',
      '  if (f && fs.existsSync(f)) { process.stdout.write(fs.readFileSync(f, "utf8")); process.exit(0); }',
      '  process.stderr.write("configmaps not found\\n"); process.exit(1);',
      "}",
      // label / annotate / create succeed silently.
      "process.exit(0);",
    ].join("\n")
  );
  return stubJs;
}

const ENV_KEYS = ["KUBECTL_BIN", "NS_RECORD", "NS_FAIL_ALL", "NS_NS_JSON", "NS_CM_JSON", "NS_GET_NS_STATUS", "NS_GET_NS_JSON"];

function snapshotEnv() {
  const s = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}

function restoreEnv(s) {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

function recordedVerbs(recordFile) {
  return fs
    .readFileSync(recordFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function assertOnlyGetLabelAnnotateCreate(recordFile) {
  const lines = recordedVerbs(recordFile);
  assert.ok(lines.length > 0, "expected kubectl calls to be recorded");
  for (const line of lines) {
    const verb = line.split(" ")[0];
    assert.ok(
      ["get", "label", "annotate", "create"].includes(verb),
      `non-destructive paths only (get/label/annotate/create), got: ${line}`
    );
    assert.ok(!line.includes("delete"), `must never delete, got: ${line}`);
  }
  return lines;
}

test("getNamespaces reads labeled namespaces + coding-system list (get only)", () => {
  const prev = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const nsFile = path.join(dir, "ns.json");
    const cmFile = path.join(dir, "cm.json");
    fs.writeFileSync(
      nsFile,
      JSON.stringify({
        items: [
          nsItem("team-alpha", {
            annotations: {
              "coding-container.io/registry": "registry.example.com/team",
              "coding-container.io/nfs-server": "10.0.0.5",
              "coding-container.io/nfs-base-path": "/workspaces",
            },
          }),
          nsItem("coding"),
        ],
      })
    );
    fs.writeFileSync(cmFile, JSON.stringify({ items: [cmItem("team-alpha")] }));
    const record = path.join(dir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(dir);
    process.env.NS_RECORD = record;
    process.env.NS_NS_JSON = nsFile;
    process.env.NS_CM_JSON = cmFile;

    const out = getNamespaces();
    assert.equal(out.length, 2);
    assert.equal(out[0].name, "coding");
    assert.deepEqual(out[0].setupValues, {});
    assert.equal(out[1].name, "team-alpha");
    assert.equal(out[1].initialized, true);
    assert.equal(out[1].setupValues.registry, "registry.example.com/team");

    const lines = assertOnlyGetLabelAnnotateCreate(record);
    assert.ok(lines.some((l) => l.includes("-l coding-container=true")), `label-filtered list expected: ${lines}`);
    assert.ok(lines.some((l) => l.includes("coding-system")), `coding-system read expected: ${lines}`);
  } finally {
    restoreEnv(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getNamespaces throws when the namespace list is unreachable", () => {
  const prev = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const record = path.join(dir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(dir);
    process.env.NS_RECORD = record;
    process.env.NS_FAIL_ALL = "1";
    assert.throws(() => getNamespaces(), /cannot list coding-container namespaces/);
  } finally {
    restoreEnv(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getNamespaces lists namespaces with initialized:false when only the ConfigMap read fails", () => {
  const prev = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const nsFile = path.join(dir, "ns.json");
    fs.writeFileSync(nsFile, JSON.stringify({ items: [nsItem("coding")] }));
    const record = path.join(dir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(dir);
    process.env.NS_RECORD = record;
    process.env.NS_NS_JSON = nsFile;
    // NS_CM_JSON unset -> the stub exits 1 for `get cm`.

    const out = getNamespaces();
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "coding");
    assert.equal(out[0].initialized, false);
  } finally {
    restoreEnv(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureNamespace labels + annotates an existing namespace (no create, no delete)", async () => {
  const prev = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const record = path.join(dir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(dir);
    process.env.NS_RECORD = record;
    process.env.NS_GET_NS_STATUS = "0"; // namespace exists

    await ensureNamespace("team-alpha", {
      setupValues: { registry: "registry.example.com/team", nfsServer: "10.0.0.5", nfsBasePath: "/workspaces" },
    });

    const lines = assertOnlyGetLabelAnnotateCreate(record);
    assert.ok(lines.some((l) => l.startsWith("get namespace team-alpha")), `expected get: ${lines}`);
    assert.ok(!lines.some((l) => l.startsWith("create ")), `existing ns must not be created: ${lines}`);
    const label = lines.find((l) => l.startsWith("label "));
    assert.ok(label?.includes("coding-container=true") && label?.includes("--overwrite"), `label line: ${label}`);
    const annotate = lines.find((l) => l.startsWith("annotate "));
    assert.ok(annotate?.includes("--overwrite"), `annotate line: ${annotate}`);
    for (const key of Object.values(SETUP_ANNOTATIONS)) {
      assert.ok(annotate?.includes(`${key}=`), `annotate must carry ${key}: ${annotate}`);
    }
  } finally {
    restoreEnv(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureNamespace creates when missing, skips annotate without values", async () => {
  const prev = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const record = path.join(dir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(dir);
    process.env.NS_RECORD = record;
    process.env.NS_GET_NS_STATUS = "1"; // namespace missing

    await ensureNamespace("fresh-ns");

    const lines = assertOnlyGetLabelAnnotateCreate(record);
    assert.ok(lines.some((l) => l.startsWith("create namespace fresh-ns")), `expected create: ${lines}`);
    assert.ok(lines.some((l) => l.startsWith("label ")), `label still asserted: ${lines}`);
    assert.ok(!lines.some((l) => l.startsWith("annotate ")), `no values -> no annotate: ${lines}`);
  } finally {
    restoreEnv(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setupAnnotationPairs skips blanks and placeholders", () => {
  assert.deepEqual(setupAnnotationPairs(undefined), []);
  assert.deepEqual(setupAnnotationPairs({}), []);
  assert.deepEqual(
    setupAnnotationPairs({ registry: "  ", nfsServer: "10.0.0.5", nfsBasePath: PLACEHOLDERS.nfsBasePath }),
    ["coding-container.io/nfs-server=10.0.0.5"]
  );
  assert.deepEqual(setupAnnotationPairs({ registry: PLACEHOLDERS.registry }), []);
});

test("normalizeNamespace accepts DNS-1123 names, rejects the rest", () => {
  assert.equal(normalizeNamespace("coding"), "coding");
  assert.equal(normalizeNamespace("  team-alpha  "), "team-alpha");
  for (const bad of ["", "Bad_NS", "UPPER", "-lead", "trail-", "has space", "a".repeat(64)]) {
    assert.throws(() => normalizeNamespace(bad), /namespace/);
  }
});

// --- setup template + best-effort tagging -----------------------------------

function isolateGlobalConfig() {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-setup-"));
  process.env.XDG_CONFIG_HOME = dir;
  // Pre-seed the key pair so setup() never shells out to ssh-keygen.
  const keysDir = path.join(dir, "coding-container", "keys");
  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(path.join(keysDir, "id_ed25519"), "dummy-private");
  fs.writeFileSync(path.join(keysDir, "id_ed25519.pub"), "dummy-public");
  return { prevXdg, dir, cfgFile: path.join(dir, "coding-container", "config.yaml") };
}

test("setup writes the chosen namespace and tags it (label/annotate only)", async () => {
  const prev = snapshotEnv();
  const { prevXdg, dir, cfgFile } = isolateGlobalConfig();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const record = path.join(stubDir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(stubDir);
    process.env.NS_RECORD = record;
    process.env.NS_GET_NS_STATUS = "0"; // namespace exists -> label/annotate

    await setup({
      registry: "registry.example.com/team",
      nfsServer: "10.0.0.5",
      nfsBasePath: "/workspaces",
      namespace: "team-alpha",
    });

    const yaml = fs.readFileSync(cfgFile, "utf8");
    assert.ok(yaml.includes('namespace: "team-alpha"'), `rendered namespace:\n${yaml}`);
    const lines = assertOnlyGetLabelAnnotateCreate(record);
    const annotate = lines.find((l) => l.startsWith("annotate "));
    assert.ok(annotate?.includes("coding-container.io/registry=registry.example.com/team"), annotate);
  } finally {
    restoreEnv(prev);
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test("setup defaults to coding on blank namespace and never fails offline", async () => {
  const prev = snapshotEnv();
  const { prevXdg, dir, cfgFile } = isolateGlobalConfig();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const record = path.join(stubDir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(stubDir);
    process.env.NS_RECORD = record;
    process.env.NS_FAIL_ALL = "1"; // cluster unreachable

    await setup({ registry: "r.example.com/you", nfsServer: "10.0.0.5", nfsBasePath: "/ws" });

    const yaml = fs.readFileSync(cfgFile, "utf8");
    assert.ok(yaml.includes('namespace: "coding"'), `default namespace:\n${yaml}`);
  } finally {
    restoreEnv(prev);
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test("setup rejects an invalid namespace instead of writing it", async () => {
  const prev = snapshotEnv();
  const { prevXdg, dir, cfgFile } = isolateGlobalConfig();
  try {
    await assert.rejects(setup({ namespace: "Bad_NS" }), /namespace/);
    assert.ok(!fs.existsSync(cfgFile), "invalid namespace must not produce a config");
  } finally {
    restoreEnv(prev);
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readNamespaceSetupValues returns annotations, {} offline", () => {
  const prev = snapshotEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const nsFile = path.join(dir, "single-ns.json");
    fs.writeFileSync(
      nsFile,
      JSON.stringify({
        metadata: {
          name: "team-alpha",
          annotations: {
            "coding-container.io/registry": "registry.example.com/team",
            "coding-container.io/nfs-server": "10.0.0.5",
            "coding-container.io/nfs-base-path": "/workspaces",
          },
        },
      })
    );
    const record = path.join(dir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(dir);
    process.env.NS_RECORD = record;
    process.env.NS_GET_NS_JSON = nsFile;

    assert.deepEqual(readNamespaceSetupValues("team-alpha"), {
      registry: "registry.example.com/team",
      nfsServer: "10.0.0.5",
      nfsBasePath: "/workspaces",
    });

    process.env.NS_FAIL_ALL = "1";
    assert.deepEqual(readNamespaceSetupValues("team-alpha"), {});
  } finally {
    restoreEnv(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup with only namespace fills registry/NFS from cluster annotations", async () => {
  const prev = snapshotEnv();
  const { prevXdg, dir, cfgFile } = isolateGlobalConfig();
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  try {
    const nsFile = path.join(stubDir, "single-ns.json");
    fs.writeFileSync(
      nsFile,
      JSON.stringify({
        metadata: {
          name: "team-alpha",
          annotations: {
            "coding-container.io/registry": "registry.example.com/team",
            "coding-container.io/nfs-server": "10.0.0.5",
            "coding-container.io/nfs-base-path": "/workspaces",
          },
        },
      })
    );
    const record = path.join(stubDir, "record.txt");
    fs.writeFileSync(record, "");
    process.env.KUBECTL_BIN = makeKubectlStub(stubDir);
    process.env.NS_RECORD = record;
    process.env.NS_GET_NS_JSON = nsFile;
    process.env.NS_GET_NS_STATUS = "0";

    await setup({ namespace: "team-alpha" });

    const yaml = fs.readFileSync(cfgFile, "utf8");
    assert.ok(yaml.includes('registry: "registry.example.com/team"'), yaml);
    assert.ok(yaml.includes('server: "10.0.0.5"'), yaml);
    assert.ok(yaml.includes('basePath: "/workspaces"'), yaml);
    assert.ok(yaml.includes('namespace: "team-alpha"'), yaml);
  } finally {
    restoreEnv(prev);
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});
