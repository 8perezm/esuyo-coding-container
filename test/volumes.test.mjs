import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
// Forward slashes so the path is a safe YAML double-quoted scalar on any OS.
const DOCKERFILE = path.join(PROJECT_ROOT, "Dockerfile").replaceAll("\\", "/");

// Isolate the global config layer: point XDG_CONFIG_HOME at an empty temp
// dir so only DEFAULTS + the written local config are merged.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "volumes-test-xdg-"));

const { loadConfig } = await import("../src/config.js");
const { deploymentManifest, extraVolumeMounts } = await import("../src/utils/manifest.js");

function loadLocal(yamlText, globalText = null) {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (globalText !== null) {
    fs.mkdirSync(path.join(xdg, "esuyo-coding-container"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "esuyo-coding-container", "config.yaml"), globalText);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "volumes-test-cfg-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yamlText);
  return loadConfig(file);
}

const BASE = `
project: my-project
image:
  registry: reg.example.com/you
  dockerfile: ${JSON.stringify(DOCKERFILE)}
nfs:
  server: 10.0.0.5
  basePath: /mnt/share/workspaces
`;

function loadVolumes(volumesYaml) {
  return loadLocal(BASE + `  volumes:\n${volumesYaml}`);
}

// Manifest tests use hand-built configs (pure renderers, no files needed).
function manifestCfg(volumes, overrides = {}) {
  return {
    project: "demo",
    image: { registry: "reg.example.com/you", name: "coding-container", tag: "1" },
    k8s: { namespace: "coding", replicas: 1, resources: {}, sidecars: [] },
    ssh: { port: 22 },
    web: { ports: [] },
    ingress: { className: "traefik" },
    container: { workdir: "/workspace" },
    nfs: { server: "10.0.0.5", basePath: "/mnt/share/workspaces/", subPath: "", volumes },
    ...overrides,
  };
}

function codingContainer(cfg) {
  return deploymentManifest(cfg).spec.template.spec.containers.find((c) => c.name === "coding");
}

test("deployment: no nfs.volumes -> manifest unchanged (workspace + ssh-keys only)", () => {
  const cfg = manifestCfg([]);
  const manifest = deploymentManifest(cfg);
  assert.deepEqual(codingContainer(cfg).volumeMounts, [
    { name: "workspace", mountPath: "/workspace", subPath: "demo" },
    { name: "ssh-keys", mountPath: "/root/.ssh/authorized_keys", subPath: "authorized_keys" },
  ]);
  assert.equal(manifest.spec.template.spec.volumes.length, 2);
});

test("deployment: extra volumes mount on the workspace NFS volume, no new volumes", () => {
  const cfg = manifestCfg([
    { subPath: "shared-datasets", mountPath: "/data", readOnly: true },
    { subPath: "team-tools", mountPath: "/opt/team-tools" },
  ]);
  const manifest = deploymentManifest(cfg);
  assert.deepEqual(codingContainer(cfg).volumeMounts, [
    { name: "workspace", mountPath: "/workspace", subPath: "demo" },
    { name: "ssh-keys", mountPath: "/root/.ssh/authorized_keys", subPath: "authorized_keys" },
    { name: "workspace", mountPath: "/data", subPath: "shared-datasets", readOnly: true },
    { name: "workspace", mountPath: "/opt/team-tools", subPath: "team-tools" },
  ]);
  // Still exactly two pod volumes: the shared NFS export + the ssh ConfigMap.
  assert.deepEqual(manifest.spec.template.spec.volumes, [
    { name: "workspace", nfs: { server: "10.0.0.5", path: "/mnt/share/workspaces" } },
    { name: "ssh-keys", configMap: { name: "demo-ssh" } },
  ]);
});

test("extraVolumeMounts: omits readOnly when false, defaults empty when unset", () => {
  assert.deepEqual(extraVolumeMounts(manifestCfg([{ subPath: "a", mountPath: "/a" }])), [
    { name: "workspace", mountPath: "/a", subPath: "a" },
  ]);
  assert.deepEqual(extraVolumeMounts(manifestCfg([])), []);
  assert.deepEqual(extraVolumeMounts({ nfs: { volumes: undefined } }), []);
});

test("config: valid volumes load (readOnly optional, subPath may be nested)", () => {
  const cfg = loadVolumes(
    [
      "    - subPath: shared/nested",
      "      mountPath: /data",
      "      readOnly: true",
      "    - subPath: tools",
      "      mountPath: /opt/tools",
    ].join("\n")
  );
  assert.equal(cfg.nfs.volumes.length, 2);
  assert.equal(cfg.nfs.volumes[0].readOnly, true);
  assert.equal(cfg.nfs.volumes[1].readOnly, undefined);
});

const INVALID = [
  ["volumes is an object", "    subPath: a\n", /must be a list/],
  ["entry is a string", "    - just-a-string\n", /must be an object/],
  ["missing mountPath", "    - subPath: a\n", /'mountPath'/],
  ["missing subPath", "    - mountPath: /a\n", /'subPath'/],
  ["absolute subPath", "    - subPath: /a\n      mountPath: /a\n", /'subPath' must be a relative/],
  ["subPath with .. segment", "    - subPath: a/..b/../c\n      mountPath: /a\n", /'subPath' must be a relative/],
  ["subPath collides with workspace folder", "    - subPath: my-project\n      mountPath: /a\n", /collides with the \/workspace folder/],
  ["duplicate subPath", "    - subPath: a\n      mountPath: /x\n    - subPath: a\n      mountPath: /y\n", /subPath "a" more than once/],
  ["relative mountPath", "    - subPath: a\n      mountPath: a\n", /'mountPath' must be an absolute/],
  ["mountPath with trailing slash", "    - subPath: a\n      mountPath: /a/\n", /'mountPath' must be an absolute/],
  ["mountPath with .. segment", "    - subPath: a\n      mountPath: /a/../b\n", /'mountPath' must be an absolute/],
  ["mountPath is the workdir", "    - subPath: a\n      mountPath: /workspace\n", /may not be \/workspace/],
  ["mountPath nested under workdir", "    - subPath: a\n      mountPath: /workspace/data\n", /may not be \/workspace/],
  ["mountPath is the ssh keys path", "    - subPath: a\n      mountPath: /root/.ssh/authorized_keys\n", /authorized_keys/],
  ["duplicate mountPath", "    - subPath: a\n      mountPath: /x\n    - subPath: b\n      mountPath: /x\n", /mountPath "\/x" more than once/],
  ["mountPath nested under another", "    - subPath: a\n      mountPath: /data\n    - subPath: b\n      mountPath: /data/sub\n", /nested with/],
  ["mountPath containing another", "    - subPath: a\n      mountPath: /data/sub\n    - subPath: b\n      mountPath: /data\n", /nested with/],
  ["readOnly as string", "    - subPath: a\n      mountPath: /a\n      readOnly: \"true\"\n", /'readOnly' must be a boolean/],
];

for (const [name, yaml, pattern] of INVALID) {
  test(`config: rejects ${name}`, () => {
    assert.throws(() => loadVolumes(yaml), pattern);
  });
}

test("config: volumes layer over the global config (arrays replace wholesale)", () => {
  const global = `${BASE}  volumes:\n    - subPath: from-global\n      mountPath: /g\n`;
  const fromGlobal = loadLocal(BASE, global);
  assert.deepEqual(fromGlobal.nfs.volumes, [{ subPath: "from-global", mountPath: "/g" }]);

  const fromLocal = loadLocal(
    BASE + "  volumes:\n    - subPath: from-local\n      mountPath: /l\n",
    global
  );
  assert.deepEqual(fromLocal.nfs.volumes, [{ subPath: "from-local", mountPath: "/l" }]);
});
