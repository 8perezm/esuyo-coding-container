import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
// Forward slashes so the path is a safe YAML double-quoted scalar on any OS.
const DOCKERFILE = path.join(PROJECT_ROOT, "Dockerfile").replaceAll("\\", "/");

// Isolate the global config layer: point XDG_CONFIG_HOME at an empty temp
// dir so only DEFAULTS + the written local config are merged.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-xdg-"));

const { loadConfig } = await import("../src/config.js");
const { expandEnvRefs, expandEnvMap } = await import("../src/utils/envsubst.js");
const {
  deploymentManifest,
  fullManifest,
  secretEnvEntries,
  secretEnvName,
  secretManifest,
  secretsHash,
} = await import("../src/utils/manifest.js");

function loadLocal(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-cfg-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yamlText);
  return loadConfig(file);
}

// ${} inside a JS template literal interpolates, so build yaml with
// concatenation where a literal ${...} must reach the file.
const BASE =
  "project: my-project\n" +
  "image:\n" +
  "  registry: reg.example.com/you\n" +
  `  dockerfile: ${JSON.stringify(DOCKERFILE)}\n` +
  "nfs:\n" +
  "  server: 10.0.0.5\n" +
  "  basePath: /mnt/share/workspaces\n";

// Manifest tests use hand-built configs (pure renderers, no files needed).
function manifestCfg({ env = {}, secretEnv = {} } = {}) {
  return {
    project: "demo",
    image: { registry: "reg.example.com/you", name: "coding-container", tag: "1" },
    k8s: { namespace: "coding", replicas: 1, resources: {}, sidecars: [], env, secretEnv },
    ssh: { port: 22 },
    web: { ports: [] },
    ingress: { className: "traefik" },
    container: { workdir: "/workspace" },
    nfs: { server: "10.0.0.5", basePath: "/mnt/share/workspaces/", subPath: "" },
  };
}

function codingContainer(cfg) {
  return deploymentManifest(cfg).spec.template.spec.containers.find((c) => c.name === "coding");
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- expansion unit tests ---------------------------------------------------

test("expandEnvRefs: expands ${VAR}, leaves everything else alone", () => {
  withEnv({ FOO: "bar" }, () => {
    assert.equal(expandEnvRefs("prefix-${FOO}-suffix", "t"), "prefix-bar-suffix");
    assert.equal(expandEnvRefs("no refs here", "t"), "no refs here");
    assert.equal(expandEnvRefs("bare $FOO is untouched", "t"), "bare $FOO is untouched");
    assert.equal(expandEnvRefs("empty ${}", "t"), "empty ${}");
  });
});

test("expandEnvRefs: missing variable fails fast with the variable name", () => {
  withEnv({ DEFINITELY_NOT_SET_XYZ: undefined }, () => {
    assert.throws(
      () => expandEnvRefs("${DEFINITELY_NOT_SET_XYZ}", "k8s.secretEnv 'KEY'"),
      /needs \$DEFINITELY_NOT_SET_XYZ/
    );
  });
});

test("expandEnvMap: only string values expand, scalars pass through", () => {
  withEnv({ N: "42" }, () => {
    assert.deepEqual(expandEnvMap({ a: "${N}", b: 7, c: true, d: null }, "t"), {
      a: "42",
      b: 7,
      c: true,
      d: null,
    });
  });
});

// --- config load tests ------------------------------------------------------

test("config: secretEnv loads and ${VAR} expands from the local shell", () => {
  withEnv({ OPENAI_API_KEY: "sk-test" }, () => {
    const cfg = loadLocal(BASE + "k8s:\n  secretEnv:\n    OPENAI_API_KEY: ${OPENAI_API_KEY}\n");
    assert.equal(cfg.k8s.secretEnv.OPENAI_API_KEY, "sk-test");
  });
});

test("config: missing ${VAR} in secretEnv fails the load", () => {
  withEnv({ DEFINITELY_NOT_SET_XYZ: undefined }, () => {
    assert.throws(
      () => loadLocal(BASE + "k8s:\n  secretEnv:\n    KEY: ${DEFINITELY_NOT_SET_XYZ}\n"),
      /needs \$DEFINITELY_NOT_SET_XYZ/
    );
  });
});

test("config: secretEnv defaults to {} and rejects non-maps / object values", () => {
  assert.deepEqual(loadLocal(BASE).k8s.secretEnv, {});
  assert.throws(() => loadLocal(BASE + "k8s:\n  secretEnv:\n    - a\n"), /must be a map/);
  assert.throws(
    () => loadLocal(BASE + "k8s:\n  secretEnv:\n    KEY:\n      nested: true\n"),
    /must be a scalar/
  );
});

// --- manifest tests ---------------------------------------------------------

test("secretManifest: null when empty, Opaque Secret with stringData otherwise", () => {
  assert.equal(secretManifest(manifestCfg()), null);
  const doc = secretManifest(manifestCfg({ secretEnv: { B: "2", A: "1" } }));
  assert.equal(doc.kind, "Secret");
  assert.equal(doc.type, "Opaque");
  assert.equal(doc.metadata.name, "demo-env");
  assert.equal(doc.metadata.namespace, "coding");
  // Sorted for a stable render.
  assert.deepEqual(Object.keys(doc.stringData), ["A", "B"]);
});

test("deployment: plain env stays value:, secretEnv becomes valueFrom", () => {
  const cfg = manifestCfg({ env: { PLAIN: "x" }, secretEnv: { OPENAI_API_KEY: "sk" } });
  const env = codingContainer(cfg).env;
  assert.deepEqual(env, [
    { name: "PLAIN", value: "x" },
    {
      name: "OPENAI_API_KEY",
      valueFrom: { secretKeyRef: { name: "demo-env", key: "OPENAI_API_KEY" } },
    },
  ]);
  // No secret leak in the Deployment: no "sk" anywhere.
  assert.ok(!JSON.stringify(deploymentManifest(cfg)).includes('"sk"'));
});

test("deployment: no secretEnv -> no annotation, no valueFrom", () => {
  const cfg = manifestCfg({ env: { PLAIN: "x" } });
  const dep = deploymentManifest(cfg);
  assert.deepEqual(codingContainer(cfg).env, [{ name: "PLAIN", value: "x" }]);
  assert.equal(dep.spec.template.metadata.annotations, undefined);
});

test("secretsHash: null when empty, stable, changes on rotation", () => {
  assert.equal(secretsHash(manifestCfg()), null);
  const a = secretsHash(manifestCfg({ secretEnv: { K: "v1" } }));
  const b = secretsHash(manifestCfg({ secretEnv: { K: "v1" } }));
  const c = secretsHash(manifestCfg({ secretEnv: { K: "v2" } }));
  assert.equal(a, b);
  assert.notEqual(a, c);
  const dep = deploymentManifest(manifestCfg({ secretEnv: { K: "v1" } }));
  assert.equal(dep.spec.template.metadata.annotations["coding-container-secrets-hash"], a);
});

test("fullManifest: Secret doc present only with secretEnv, redaction hides values", () => {
  const docs = (out) => out.split("---\n").map((d) => yaml.load(d));
  const kinds = (cfg, opts) => docs(fullManifest(cfg, "ssh-key", null, opts)).map((d) => d.kind);

  assert.deepEqual(kinds(manifestCfg()), ["ConfigMap", "Deployment", "Service"]);
  assert.deepEqual(kinds(manifestCfg({ secretEnv: { K: "v" } })), [
    "ConfigMap",
    "Secret",
    "Deployment",
    "Service",
  ]);

  const cfg = manifestCfg({ secretEnv: { OPENAI_API_KEY: "sk-live" } });
  const plain = docs(fullManifest(cfg, "ssh-key"))[1];
  assert.equal(plain.stringData.OPENAI_API_KEY, "sk-live");
  const redacted = docs(fullManifest(cfg, "ssh-key", null, { redactSecrets: true }))[1];
  assert.equal(redacted.kind, "Secret");
  assert.equal(redacted.stringData.OPENAI_API_KEY, "***REDACTED***");
});

test("secretEnvName follows the <project>-env convention", () => {
  assert.equal(secretEnvName(manifestCfg()), "demo-env");
});

test("secretEnvEntries: sorted, nulls dropped, values stringified", () => {
  assert.deepEqual(
    secretEnvEntries(manifestCfg({ secretEnv: { B: 2, A: "x", C: null } })),
    [
      ["A", "x"],
      ["B", "2"],
    ]
  );
});
