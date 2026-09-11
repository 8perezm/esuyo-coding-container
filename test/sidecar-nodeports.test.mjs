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
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-np-xdg-"));

const { loadConfig } = await import("../src/config.js");
const {
  deploymentManifest,
  serviceManifest,
  sidecarNodePorts,
} = await import("../src/utils/manifest.js");

function loadLocal(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-np-cfg-"));
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

function loadSidecars(sidecarsYaml, extra = "") {
  return loadLocal(BASE + extra + `k8s:\n  sidecars:\n${sidecarsYaml}`);
}

// Manifest tests use hand-built configs (pure renderers, no files needed).
function manifestCfg(sidecars, overrides = {}) {
  return {
    project: "demo",
    image: { registry: "reg.example.com/you", name: "coding-container", tag: "1" },
    k8s: { namespace: "coding", replicas: 1, resources: {}, serviceType: "NodePort", nodePort: 30022, sidecars },
    ssh: { port: 22 },
    web: { ports: [] },
    ingress: { className: "traefik" },
    container: { workdir: "/workspace" },
    nfs: { server: "10.0.0.5", basePath: "/mnt/share/workspaces", subPath: "", volumes: [] },
    ...overrides,
  };
}

test("service: sidecar port with nodePort renders a NodePort service port", () => {
  const cfg = manifestCfg([
    {
      name: "postgres",
      image: "postgres:16",
      ports: [{ containerPort: 5432, name: "postgres", nodePort: 30432 }],
    },
  ]);
  const ports = serviceManifest(cfg).spec.ports;
  assert.deepEqual(
    ports.find((p) => p.name === "postgres"),
    { name: "postgres", port: 5432, targetPort: 5432, protocol: "TCP", nodePort: 30432 }
  );
  // ssh and web ports are untouched.
  assert.equal(ports.length, 2);
});

test("service: sidecar ports without nodePort render no service port", () => {
  const cfg = manifestCfg([
    {
      name: "redis",
      image: "redis:7",
      ports: [{ containerPort: 6379, name: "redis" }],
    },
  ]);
  assert.deepEqual(serviceManifest(cfg).spec.ports, [
    { name: "ssh", port: 22, targetPort: 22, protocol: "TCP", nodePort: 30022 },
  ]);
  assert.deepEqual(sidecarNodePorts(cfg), []);
});

test("service: unnamed exposed port defaults to nodeport-<containerPort>, UDP passes through", () => {
  const cfg = manifestCfg([
    {
      name: "metrics",
      image: "img:1",
      ports: [{ containerPort: 9100, protocol: "UDP", nodePort: 30500 }],
    },
  ]);
  assert.deepEqual(sidecarNodePorts(cfg), [
    { name: "nodeport-9100", port: 9100, targetPort: 9100, protocol: "UDP", nodePort: 30500 },
  ]);
});

test("deployment: nodePort is stripped from the rendered sidecar container spec", () => {
  const cfg = manifestCfg([
    {
      name: "postgres",
      image: "postgres:16",
      ports: [{ containerPort: 5432, name: "postgres", nodePort: 30432 }],
    },
  ]);
  const containers = deploymentManifest(cfg).spec.template.spec.containers;
  const sidecar = containers.find((c) => c.name === "postgres");
  assert.deepEqual(sidecar.ports, [{ containerPort: 5432, name: "postgres" }]);
});

test("config: valid sidecar nodePort loads", () => {
  const cfg = loadSidecars(
    [
      "    - name: postgres",
      "      image: postgres:16",
      "      ports:",
      "        - { containerPort: 5432, name: postgres, nodePort: 30432 }",
    ].join("\n")
  );
  assert.equal(cfg.k8s.sidecars[0].ports[0].nodePort, 30432);
});

const INVALID = [
  [
    "nodePort below range",
    "    - name: postgres\n      image: postgres:16\n      ports:\n        - { containerPort: 5432, name: postgres, nodePort: 22 }",
    /nodePort must be an integer in 30000-32767/,
  ],
  [
    "nodePort above range",
    "    - name: postgres\n      image: postgres:16\n      ports:\n        - { containerPort: 5432, name: postgres, nodePort: 33000 }",
    /nodePort must be an integer in 30000-32767/,
  ],
  [
    "nodePort as string",
    "    - name: postgres\n      image: postgres:16\n      ports:\n        - { containerPort: 5432, name: postgres, nodePort: \"30432\" }",
    /nodePort must be an integer in 30000-32767/,
  ],
  [
    "nodePort collides with the SSH NodePort",
    "    - name: postgres\n      image: postgres:16\n      ports:\n        - { containerPort: 5432, name: postgres, nodePort: 30022 }",
    /collides with the SSH NodePort/,
  ],
  [
    "nodePort listed twice",
    [
      "    - name: postgres",
      "      image: postgres:16",
      "      ports:",
      "        - { containerPort: 5432, name: postgres, nodePort: 30432 }",
      "    - name: redis",
      "      image: redis:7",
      "      ports:",
      "        - { containerPort: 6379, name: redis, nodePort: 30432 }",
    ].join("\n"),
    /nodePort 30432 more than once/,
  ],
  [
    "port name collides with the ssh service port",
    "    - name: postgres\n      image: postgres:16\n      ports:\n        - { containerPort: 5432, name: ssh, nodePort: 30432 }",
    /already used by a service port/,
  ],
  [
    "port name collides with a web.ports name",
    "    - name: postgres\n      image: postgres:16\n      ports:\n        - { containerPort: 5432, name: api, nodePort: 30432 }",
    "web:\n  ports:\n    - { port: 3000, host: x.example.com, name: api }\n",
    /already used by a service port/,
  ],
  [
    "port name collides with another exposed sidecar port",
    [
      "    - name: postgres",
      "      image: postgres:16",
      "      ports:",
      "        - { containerPort: 5432, name: db, nodePort: 30432 }",
      "    - name: redis",
      "      image: redis:7",
      "      ports:",
      "        - { containerPort: 6379, name: db, nodePort: 30433 }",
    ].join("\n"),
    /already used by a service port/,
  ],
];

for (const [name, sidecarsYaml, patternOrExtra, pattern = null] of INVALID) {
  // 3-tuples are (name, yaml, pattern); one case adds a 4th element so the
  // yaml is layered with an extra top-level block (web.ports).
  const extra = typeof patternOrExtra === "string" ? patternOrExtra : "";
  const regex = typeof patternOrExtra === "string" ? pattern : patternOrExtra;
  test(`config: rejects ${name}`, () => {
    assert.throws(() => loadSidecars(sidecarsYaml, extra), regex);
  });
}
