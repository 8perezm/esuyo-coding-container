import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the global config layer per process.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "instance-env-xdg-"));

const instance = await import("../src/utils/instance.js");
const { loadConfig, globalConfigDir } = await import("../src/config.js");
const { sshAlias, sshProjectFromAlias, addHostEntry, listHostEntries } = await import("../src/utils/ssh-config.js");

const KEYS = ["CODING_CONFIG_LEAF", "CODING_SSH_PREFIX", "CODING_NAMESPACE"];

function snapshot() {
  const s = {};
  for (const k of KEYS) s[k] = process.env[k];
  return s;
}

function restore(s) {
  for (const k of KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
  instance.resetInstanceEnvForTests();
}

function withEnv(vars, fn) {
  const prev = snapshot();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  instance.resetInstanceEnvForTests();
  try {
    return fn();
  } finally {
    restore(prev);
  }
}

function writeLocal(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-env-cfg-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yamlText);
  return file;
}

const MINIMAL = (extra = "") =>
  "project: my-proj\n" +
  "image:\n" +
  "  registry: registry.example.com/you\n" +
  "nfs:\n" +
  "  server: 10.0.0.5\n" +
  "  basePath: /workspaces\n" +
  extra;

test("defaults preserve today's paths", () => {
  withEnv({ CODING_CONFIG_LEAF: undefined, CODING_SSH_PREFIX: undefined, CODING_NAMESPACE: undefined }, () => {
    assert.equal(instance.configDirLeaf(), "coding-container");
    assert.equal(instance.sshPrefix(), "coding-");
    assert.equal(instance.defaultNamespace(), "coding");
    assert.ok(globalConfigDir().endsWith("coding-container"));
    assert.equal(sshAlias("my-proj"), "coding-my-proj");
    assert.equal(sshProjectFromAlias("coding-my-proj"), "my-proj");
  });
});

test("env overrides leaf, prefix and default namespace", () => {
  withEnv({ CODING_CONFIG_LEAF: "coding-container-dev", CODING_SSH_PREFIX: "coding-dev-", CODING_NAMESPACE: "coding-dev" }, () => {
    assert.ok(globalConfigDir().endsWith("coding-container-dev"));
    assert.equal(sshAlias("my-proj"), "coding-dev-my-proj");
    assert.equal(sshProjectFromAlias("coding-dev-my-proj"), "my-proj");
    // Sibling alias belongs to the other copy: left untouched by this instance.
    assert.equal(sshProjectFromAlias("coding-my-proj"), null);
    const cfg = loadConfig(writeLocal(MINIMAL()));
    assert.equal(cfg.k8s.namespace, "coding-dev");
  });
});

test("project config still overrides the env default namespace", () => {
  withEnv({ CODING_NAMESPACE: "coding-dev", CODING_CONFIG_LEAF: undefined, CODING_SSH_PREFIX: undefined }, () => {
    const cfg = loadConfig(writeLocal(MINIMAL("k8s:\n  namespace: coding-prod\n")));
    assert.equal(cfg.k8s.namespace, "coding-prod");
  });
});

test("sibling prefixes coexist in one managed ssh block", () => {
  withEnv({ CODING_SSH_PREFIX: "coding-dev-", CODING_CONFIG_LEAF: undefined, CODING_NAMESPACE: undefined }, () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "instance-env-ssh-")), "config");
    addHostEntry({ alias: "coding-my-proj", hostName: "10.0.0.1", port: "30022", user: "root", identityFile: "/prod/key", knownHostsFile: "/dev/null" }, file);
    addHostEntry({ alias: sshAlias("my-proj"), hostName: "10.0.0.1", port: "30023", user: "root", identityFile: "/dev/key", knownHostsFile: "/dev/null" }, file);
    const aliases = listHostEntries(file).map((e) => e.alias).sort();
    assert.deepEqual(aliases, ["coding-dev-my-proj", "coding-my-proj"]);
  });
});

test("real env wins over the .env file", () => {
  const prev = snapshot();
  try {
    delete process.env.CODING_SSH_PREFIX;
    instance.resetInstanceEnvForTests();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-env-dot-"));
    fs.writeFileSync(path.join(root, ".env"), "CODING_SSH_PREFIX=coding-file-\n");
    instance.loadInstanceEnv(root);
    assert.equal(instance.sshPrefix(), "coding-file-");

    // Reset and prove a real env value is never overwritten by the file.
    instance.resetInstanceEnvForTests();
    process.env.CODING_SSH_PREFIX = "coding-real-";
    instance.loadInstanceEnv(root);
    assert.equal(instance.sshPrefix(), "coding-real-");
  } finally {
    restore(prev);
  }
});

test("invalid values fail fast with a clear message", () => {
  withEnv({ CODING_CONFIG_LEAF: "a/b" }, () => {
    assert.throws(() => instance.configDirLeaf(), /CODING_CONFIG_LEAF/);
  });
  withEnv({ CODING_SSH_PREFIX: "BAD" }, () => {
    assert.throws(() => instance.sshPrefix(), /CODING_SSH_PREFIX/);
  });
  withEnv({ CODING_NAMESPACE: "Bad_NS" }, () => {
    assert.throws(() => instance.defaultNamespace(), /CODING_NAMESPACE/);
  });
});
