import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the global config layer: only DEFAULTS + the written local config
// are merged, so a developer's real ~/.config/coding-container never leaks in.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rootless-test-xdg-"));

const { loadConfig, authorizedKeysPath } = await import("../src/config.js");
const { deploymentManifest, serviceManifest } = await import("../src/utils/manifest.js");

const BASE = `project: my-project
image:
  registry: reg.example.com/you
  tag: v1.0.0
nfs:
  server: 10.0.0.5
  basePath: /workspaces
`;

function loadYaml(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rootless-test-cfg-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yamlText);
  return loadConfig(file);
}

function load(extra = "") {
  return loadYaml(BASE + extra);
}

function coding(cfg) {
  return deploymentManifest(cfg).spec.template.spec.containers.find((c) => c.name === "coding");
}

test("defaults keep the historical root mode", () => {
  const cfg = load();
  assert.equal(cfg.container.root, true);
  assert.equal(cfg.container.user, "root");
  assert.equal(cfg.container.uid, 0);
  assert.equal(cfg.container.gid, 0);
  assert.equal(cfg.container.home, "/root");
  assert.equal(cfg.ssh.user, "root");
  assert.equal(cfg.ssh.port, 22);
  assert.equal(authorizedKeysPath(cfg), "/root/.ssh/authorized_keys");
  assert.equal(coding(cfg).securityContext, undefined);
  assert.equal(coding(cfg).volumeMounts[1].mountPath, "/root/.ssh/authorized_keys");
  assert.equal(coding(cfg).ports[0].containerPort, 22);
  assert.equal(coding(cfg).env, undefined);
});

test("rootless defaults: ubuntu user, home, SSH user and port 2222", () => {
  const cfg = load("container:\n  uid: 1000\n");
  assert.equal(cfg.container.root, false);
  assert.equal(cfg.container.user, "ubuntu");
  assert.equal(cfg.container.uid, 1000);
  assert.equal(cfg.container.gid, 1000);
  assert.equal(cfg.container.home, "/home/ubuntu");
  assert.equal(cfg.ssh.user, "ubuntu");
  assert.equal(cfg.ssh.port, 2222);
  assert.equal(authorizedKeysPath(cfg), "/home/ubuntu/.ssh/authorized_keys");
});

test("rootless honors explicit user, gid, home and SSH port", () => {
  const cfg = load(
    "container:\n" +
      "  user: alice\n" +
      "  uid: 1001\n" +
      "  gid: 2002\n" +
      "  home: /home/alice\n" +
      "ssh:\n" +
      "  port: 2223\n"
  );
  assert.equal(cfg.container.user, "alice");
  assert.equal(cfg.container.gid, 2002);
  assert.equal(cfg.container.home, "/home/alice");
  assert.equal(cfg.ssh.user, "alice");
  assert.equal(cfg.ssh.port, 2223);
  assert.equal(authorizedKeysPath(cfg), "/home/alice/.ssh/authorized_keys");
});

test("root:false selects rootless mode with ubuntu/1000 defaults", () => {
  const cfg = load("container:\n  root: false\n");
  assert.equal(cfg.container.root, false);
  assert.equal(cfg.container.user, "ubuntu");
  assert.equal(cfg.container.uid, 1000);
  assert.equal(cfg.container.gid, 1000);
  assert.equal(cfg.container.home, "/home/ubuntu");
  assert.equal(cfg.ssh.user, "ubuntu");
  assert.equal(cfg.ssh.port, 2222);
  assert.equal(authorizedKeysPath(cfg), "/home/ubuntu/.ssh/authorized_keys");
  assert.equal(coding(cfg).securityContext.runAsUser, 1000);
  assert.equal(coding(cfg).ports[0].containerPort, 2222);
});

test("root:true keeps the historical root mode", () => {
  const cfg = load("container:\n  root: true\n");
  assert.equal(cfg.container.root, true);
  assert.equal(cfg.container.user, "root");
  assert.equal(cfg.container.uid, 0);
  assert.equal(cfg.container.gid, 0);
  assert.equal(cfg.container.home, "/root");
  assert.equal(cfg.ssh.user, "root");
  assert.equal(cfg.ssh.port, 22);
  assert.equal(coding(cfg).securityContext, undefined);
});

test("root:false honors an explicit custom uid for a different NAS mapping", () => {
  const cfg = load("container:\n  root: false\n  user: alice\n  uid: 2001\n  home: /home/alice\n");
  assert.equal(cfg.container.root, false);
  assert.equal(cfg.container.user, "alice");
  assert.equal(cfg.container.uid, 2001);
  assert.equal(cfg.container.gid, 2001);
  assert.equal(cfg.container.home, "/home/alice");
  assert.equal(cfg.ssh.user, "alice");
  assert.equal(coding(cfg).securityContext.runAsUser, 2001);
});

test("old uid-only configs infer root:false for backward compat", () => {
  const cfg = load("container:\n  uid: 1000\n");
  assert.equal(cfg.container.root, false);
});

test("config: rejects root:true with a non-zero uid", () => {
  assert.throws(() => load("container:\n  root: true\n  uid: 1000\n"), /container\.root is true/);
});

test("config: rejects root:false with an explicit zero uid", () => {
  assert.throws(() => load("container:\n  root: false\n  uid: 0\n"), /container\.root is false/);
});

test("config: rejects a non-boolean root", () => {
  assert.throws(() => load('container:\n  root: "false"\n'), /container\.root must be a boolean/);
});

test("rootless manifest: security context, key mount, port and env", () => {
  const cfg = load("container:\n  uid: 1000\n");
  const container = coding(cfg);
  assert.deepEqual(container.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.deepEqual(container.volumeMounts[1], {
    name: "ssh-keys",
    mountPath: "/home/ubuntu/.ssh/authorized_keys",
    subPath: "authorized_keys",
  });
  assert.equal(container.ports[0].containerPort, 2222);
  assert.deepEqual(container.env, [
    { name: "CODING_CONTAINER_SSH_PORT", value: "2222" },
  ]);

  const ssh = serviceManifest(cfg).spec.ports[0];
  assert.equal(ssh.port, 2222);
  assert.equal(ssh.targetPort, 2222);
  assert.equal(ssh.nodePort, cfg.k8s.nodePort);
});

test("rootless does not change sidecar security contexts", () => {
  const cfg = load(
    "container:\n  uid: 1000\n" +
      "k8s:\n" +
      "  sidecars:\n" +
      "    - name: db\n" +
      "      image: postgres:18.6\n" +
      "      securityContext:\n" +
      "        runAsUser: 999\n"
  );
  const containers = deploymentManifest(cfg).spec.template.spec.containers;
  const db = containers.find((c) => c.name === "db");
  assert.deepEqual(db.securityContext, { runAsUser: 999 });
  assert.equal(containers.find((c) => c.name === "coding").securityContext.runAsUser, 1000);
});

test("rootless adds the SSH port env after user and secret env", () => {
  const cfg = load(
    "container:\n  uid: 1000\n" +
      "k8s:\n" +
      "  env:\n" +
      "    FOO: bar\n" +
      "  secretEnv:\n" +
      "    TOKEN: value\n"
  );
  assert.deepEqual(coding(cfg).env, [
    { name: "FOO", value: "bar" },
    { name: "TOKEN", valueFrom: { secretKeyRef: { name: "my-project-env", key: "TOKEN" } } },
    { name: "CODING_CONTAINER_SSH_PORT", value: "2222" },
  ]);
});

test("rootless defaults are part of image.buildArgs", () => {
  const cfg = load();
  assert.equal(cfg.image.buildArgs.APP_USER, "ubuntu");
  assert.equal(cfg.image.buildArgs.APP_UID, "1000");
  assert.equal(cfg.image.buildArgs.APP_GID, "1000");
});

test("ssh.user follows container.user unless explicitly different", () => {
  const cfg = load("container:\n  user: alice\n  uid: 1000\n");
  assert.equal(cfg.ssh.user, "alice");
  assert.throws(
    () => load("container:\n  uid: 1000\nssh:\n  user: alice\n"),
    /ssh\.user must match container\.user/
  );
});

const INVALID = [
  ["user name with uppercase", "container:\n  user: Dev\n", /container\.user/],
  ["uid as a string", 'container:\n  uid: "1000"\n', /container\.uid/],
  ["negative uid", "container:\n  uid: -1\n", /container\.uid/],
  ["fractional gid", "container:\n  uid: 1000\n  gid: 1000.5\n", /container\.gid/],
  ["root uid with rootless gid", "container:\n  gid: 1000\n", /both be 0|both non-zero|container\.root is true/],
  ["relative home", "container:\n  uid: 1000\n  home: home/dev\n", /container\.home/],
  ["trailing slash home", "container:\n  uid: 1000\n  home: /home/ubuntu/\n", /container\.home/],
  ["root home in rootless mode", "container:\n  uid: 1000\n  home: /root/dev\n", /must not be under \/root/],
  ["privileged SSH port", "container:\n  uid: 1000\nssh:\n  port: 80\n", /privileged SSH port/],
  ["ssh port out of range", "ssh:\n  port: 70000\n", /ssh\.port/],
  [
    "web port collides with the rootless SSH port",
    "container:\n  uid: 1000\nweb:\n  ports:\n    - { port: 2222, host: web.example.com }\n",
    /collides with ssh\.port/,
  ],
];

for (const [name, extra, pattern] of INVALID) {
  test(`config: rejects ${name}`, () => {
    assert.throws(() => load(extra), pattern);
  });
}

test("config: rejects an extra volume on the rootless key path", () => {
  const yaml = `project: my-project
image:
  registry: reg.example.com/you
  tag: v1.0.0
container:
  uid: 1000
nfs:
  server: 10.0.0.5
  basePath: /workspaces
  volumes:
    - subPath: keys
      mountPath: /home/ubuntu/.ssh/authorized_keys
`;
  assert.throws(() => loadYaml(yaml), /authorized_keys/);
});
