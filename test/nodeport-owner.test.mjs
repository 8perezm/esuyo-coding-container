import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// findNodePortOwner against a stub kubectl (KUBECTL_BIN) that returns a fixed
// `kubectl get svc -A` listing: hermetic, no cluster needed.
const { findNodePortOwner } = await import("../src/utils/project.js");

const LISTING = JSON.stringify({
  items: [
    { metadata: { namespace: "coding", name: "coding-ssh" }, spec: { ports: [{ nodePort: 30122 }] } },
    { metadata: { namespace: "coding", name: "tryout" }, spec: { ports: [{ nodePort: 30023 }] } },
    { metadata: { namespace: "default", name: "kubernetes" }, spec: { ports: [] } },
    {
      metadata: { namespace: "kube-system", name: "traefik" },
      spec: { ports: [{ nodePort: 30445 }, { nodePort: 32081 }] },
    },
  ],
});
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "nodeport-owner-"));
if (process.platform === "win32") {
  process.env.KUBECTL_BIN = path.join(bin, "kubectl.cmd");
  fs.writeFileSync(process.env.KUBECTL_BIN, `@echo off\r\necho ${LISTING}\r\n`);
} else {
  process.env.KUBECTL_BIN = path.join(bin, "kubectl");
  fs.writeFileSync(process.env.KUBECTL_BIN, `#!/bin/sh\necho '${LISTING}'\n`);
  fs.chmodSync(process.env.KUBECTL_BIN, 0o755);
}

test("findNodePortOwner: returns the holding service", () => {
  assert.deepEqual(findNodePortOwner(30023), { namespace: "coding", name: "tryout" });
});

test("findNodePortOwner: a service with multiple nodePorts", () => {
  assert.deepEqual(findNodePortOwner(32081), { namespace: "kube-system", name: "traefik" });
});

test("findNodePortOwner: null when the port is free", () => {
  assert.equal(findNodePortOwner(30024), null);
});

test("findNodePortOwner: services without nodePorts are ignored", () => {
  assert.equal(findNodePortOwner(40000), null);
});
