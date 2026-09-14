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
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "web-np-xdg-"));

const { loadConfig } = await import("../src/config.js");
const {
  deploymentManifest,
  serviceManifest,
  ingressManifest,
  webPorts,
} = await import("../src/utils/manifest.js");

function loadLocal(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-np-cfg-"));
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

function loadWeb(webYaml, extra = "") {
  return loadLocal(BASE + extra + `web:\n  ports:\n${webYaml}`);
}

// Manifest tests use hand-built configs (pure renderers, no files needed).
function manifestCfg(webPortsList, overrides = {}) {
  return {
    project: "demo",
    image: { registry: "reg.example.com/you", name: "coding-container", tag: "1" },
    k8s: { namespace: "coding", replicas: 1, resources: {}, serviceType: "NodePort", nodePort: 30022, sidecars: [] },
    ssh: { port: 22 },
    web: { ports: webPortsList },
    ingress: { className: "traefik" },
    container: { workdir: "/workspace" },
    nfs: { server: "10.0.0.5", basePath: "/mnt/share/workspaces", subPath: "", volumes: [] },
    ...overrides,
  };
}

test("service: web port with nodePort renders nodePort on the same service port", () => {
  const cfg = manifestCfg([{ port: 3000, host: "x.example.com", nodePort: 30080 }]);
  const ports = serviceManifest(cfg).spec.ports;
  assert.deepEqual(
    ports.find((p) => p.name === "web-3000"),
    { name: "web-3000", port: 3000, targetPort: 3000, protocol: "TCP", nodePort: 30080 }
  );
  // ssh and the web port: nothing else is added.
  assert.equal(ports.length, 2);
});

test("service: web port without nodePort renders no nodePort", () => {
  const cfg = manifestCfg([{ port: 3000, host: "x.example.com" }]);
  assert.deepEqual(serviceManifest(cfg).spec.ports, [
    { name: "ssh", port: 22, targetPort: 22, protocol: "TCP", nodePort: 30022 },
    { name: "web-3000", port: 3000, targetPort: 3000, protocol: "TCP" },
  ]);
});

test("ingress: nodePort does not change the rendered Ingress rules", () => {
  const plain = ingressManifest(manifestCfg([{ port: 3000, host: "x.example.com" }]));
  const withNp = ingressManifest(
    manifestCfg([{ port: 3000, host: "x.example.com", nodePort: 30080 }])
  );
  assert.deepEqual(withNp, plain);
});

test("deployment: web containerPort is rendered regardless of nodePort", () => {
  const cfg = manifestCfg([{ port: 3000, host: "x.example.com", nodePort: 30080 }]);
  const container = deploymentManifest(cfg).spec.template.spec.containers[0];
  assert.ok(container.ports.some((p) => p.name === "web-3000" && p.containerPort === 3000));
});

test("config: valid web nodePort loads", () => {
  const cfg = loadWeb("    - { port: 3000, host: x.example.com, nodePort: 30080 }");
  assert.equal(cfg.web.ports[0].nodePort, 30080);
  assert.deepEqual(webPorts(cfg), [
    { name: "web-3000", port: 3000, hosts: ["x.example.com"], nodePort: 30080 },
  ]);
});

test("config: hosts list points several domains at one port", () => {
  const cfg = loadWeb("    - { port: 3000, hosts: [a.example.com, b.example.com] }");
  assert.deepEqual(webPorts(cfg), [
    { name: "web-3000", port: 3000, hosts: ["a.example.com", "b.example.com"] },
  ]);
});

test("config: host and hosts may be combined (host first)", () => {
  const cfg = loadWeb("    - { port: 3000, host: a.example.com, hosts: [b.example.com] }");
  assert.deepEqual(webPorts(cfg), [
    { name: "web-3000", port: 3000, hosts: ["a.example.com", "b.example.com"] },
  ]);
});

test("config: host as a list points several domains at one port", () => {
  const cfg = loadWeb("    - { port: 3000, host: [a.example.com, b.example.com] }");
  assert.deepEqual(webPorts(cfg), [
    { name: "web-3000", port: 3000, hosts: ["a.example.com", "b.example.com"] },
  ]);
});

test("ingress: one rule per host, all to the same backend port", () => {
  const cfg = manifestCfg([{ port: 3000, host: "a.example.com", hosts: ["b.example.com"] }]);
  const rules = ingressManifest(cfg).spec.rules;
  assert.deepEqual(
    rules.map((r) => r.host),
    ["a.example.com", "b.example.com"]
  );
  for (const rule of rules) {
    assert.equal(rule.http.paths[0].backend.service.port.number, 3000);
  }
});

test("config: duplicate host across entries is rejected", () => {
  assert.throws(
    () =>
      loadWeb(
        [
          "    - { port: 3000, hosts: [a.example.com, b.example.com] }",
          "    - { port: 8080, host: b.example.com }",
        ].join("\n")
      ),
    /share the host "b\.example\.com"/
  );
});

const INVALID = [
  [
    "nodePort below range",
    "    - { port: 3000, host: x.example.com, nodePort: 22 }",
    /nodePort must be an integer in 30000-32767/,
  ],
  [
    "nodePort above range",
    "    - { port: 3000, host: x.example.com, nodePort: 33000 }",
    /nodePort must be an integer in 30000-32767/,
  ],
  [
    "nodePort as string",
    "    - { port: 3000, host: x.example.com, nodePort: \"30080\" }",
    /nodePort must be an integer in 30000-32767/,
  ],
  [
    "nodePort collides with the SSH NodePort",
    "    - { port: 3000, host: x.example.com, nodePort: 30022 }",
    /collides with the SSH NodePort/,
  ],
  [
    "nodePort listed twice in web.ports",
    [
      "    - { port: 3000, host: x.example.com, nodePort: 30080 }",
      "    - { port: 8080, host: y.example.com, nodePort: 30080 }",
    ].join("\n"),
    /collides with another web\.ports or sidecar port nodePort/,
  ],
  [
    "web nodePort collides with a sidecar nodePort",
    "    - { port: 3000, host: x.example.com, nodePort: 30432 }",
    /collides with another web\.ports or sidecar port nodePort/,
    `k8s:\n  sidecars:\n    - name: postgres\n      image: postgres:16\n      ports:\n        - { containerPort: 5432, name: postgres, nodePort: 30432 }\n`,
  ],
  [
    "neither host nor hosts",
    "    - { port: 3000 }",
    /needs a 'host' or a non-empty 'hosts' list/,
  ],
];

for (const [name, webYaml, pattern, extra = ""] of INVALID) {
  test(`config: rejects ${name}`, () => {
    assert.throws(() => loadWeb(webYaml, extra), pattern);
  });
}
