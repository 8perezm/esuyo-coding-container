import test from "node:test";
import assert from "node:assert/strict";
import { parseNodesJson, parsePodsJson, pickNodeIp } from "../src/utils/node-ip.js";

const nodesJson = (items) => JSON.stringify({ items });

function node(name, ip, ready) {
  return {
    metadata: { name },
    status: {
      addresses: [{ type: "InternalIP", address: ip }],
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
    },
  };
}

test("pickNodeIp: prefers the pod's own Ready node over items[0]", () => {
  const nodes = [
    { name: "node-a", internalIP: "10.0.0.1", ready: false },
    { name: "node-b", internalIP: "10.0.0.2", ready: true },
  ];
  assert.equal(pickNodeIp(nodes, "10.0.0.2"), "10.0.0.2");
});

test("pickNodeIp: pod on a NotReady node falls back to first Ready node", () => {
  const nodes = [
    { name: "node-a", internalIP: "10.0.0.1", ready: false },
    { name: "node-b", internalIP: "10.0.0.2", ready: true },
  ];
  assert.equal(pickNodeIp(nodes, "10.0.0.1"), "10.0.0.2");
});

test("pickNodeIp: no pod IP -> first Ready node (never a NotReady items[0])", () => {
  const nodes = [
    { name: "node-a", internalIP: "10.0.0.1", ready: false },
    { name: "node-b", internalIP: "10.0.0.2", ready: true },
  ];
  assert.equal(pickNodeIp(nodes, null), "10.0.0.2");
});

test("pickNodeIp: no Ready nodes -> null so deploy warns instead of writing dead IP", () => {
  const nodes = [{ name: "node-a", internalIP: "10.0.0.1", ready: false }];
  assert.equal(pickNodeIp(nodes, "10.0.0.1"), null);
  assert.equal(pickNodeIp([], null), null);
});

test("parseNodesJson: maps InternalIP + Ready", () => {
  const parsed = parseNodesJson(nodesJson([node("node-a", "10.0.0.1", false), node("node-b", "10.0.0.2", true)]));
  assert.deepEqual(parsed, [
    { name: "node-a", internalIP: "10.0.0.1", ready: false },
    { name: "node-b", internalIP: "10.0.0.2", ready: true },
  ]);
});

test("parsePodsJson: maps hostIP/nodeName/phase", () => {
  const parsed = parsePodsJson(
    JSON.stringify({
      items: [
        { metadata: { name: "p1" }, spec: { nodeName: "node-b" }, status: { phase: "Running", hostIP: "10.0.0.2" } },
      ],
    })
  );
  assert.deepEqual(parsed, [{ name: "p1", phase: "Running", hostIP: "10.0.0.2", nodeName: "node-b" }]);
});
