import test from "node:test";
import assert from "node:assert/strict";
import { planGc, imageTag } from "../src/commands/gc.js";

test("imageTag: full reference", () => {
  assert.equal(imageTag("registry.example.com/you/coding-container:20260908123045"), "20260908123045");
});

test("imageTag: untagged defaults to latest", () => {
  assert.equal(imageTag("registry.example.com/you/coding-container"), "latest");
});

test("imageTag: registry with a port", () => {
  assert.equal(imageTag("localhost:5000/foo/bar:1"), "1");
});

test("imageTag: a colon in the host is not a tag", () => {
  assert.equal(imageTag("localhost:5000/foo/bar"), "latest");
});

// v1.1.0 .. v1.15.0 (ascending)
const V = (i) => `v1.${i}.0`;
const FIFTEEN = Array.from({ length: 15 }, (_, i) => V(i + 1));

test("planGc: keeps pinned + previous + in-use + keep-many predecessors, deletes rest oldest-first", () => {
  // Acceptance scenario: 15 versions, pinned v1.15.0, keep 10, one in-use
  // tag (v1.2.0) outside the keep window.
  const { toDelete, kept } = planGc({
    tags: FIFTEEN,
    inUse: new Set(["v1.2.0"]),
    pinned: "v1.15.0",
    previous: "v1.14.0",
    keep: 10,
  });
  assert.deepEqual(toDelete, ["v1.1.0", "v1.3.0", "v1.4.0"]);
  assert.deepEqual(kept, [
    "v1.2.0", "v1.5.0", "v1.6.0", "v1.7.0", "v1.8.0", "v1.9.0",
    "v1.10.0", "v1.11.0", "v1.12.0", "v1.13.0", "v1.14.0", "v1.15.0",
  ]);
});

test("planGc: an in-use tag more than `keep` behind pinned survives", () => {
  const { toDelete, kept } = planGc({
    tags: FIFTEEN,
    inUse: new Set(["v1.1.0"]),
    pinned: "v1.15.0",
    previous: undefined,
    keep: 2,
  });
  assert.deepEqual(kept, ["v1.1.0", "v1.13.0", "v1.14.0", "v1.15.0"]);
  assert.deepEqual(toDelete, ["v1.2.0", "v1.3.0", "v1.4.0", "v1.5.0", "v1.6.0", "v1.7.0",
    "v1.8.0", "v1.9.0", "v1.10.0", "v1.11.0", "v1.12.0"]);
});

test("planGc: previous is kept even outside the window", () => {
  const { kept } = planGc({
    tags: FIFTEEN,
    inUse: new Set(),
    pinned: "v1.15.0",
    previous: "v1.1.0",
    keep: 2,
  });
  assert.ok(kept.includes("v1.1.0"));
});

test("planGc: non-semver tags are deletable unless in use", () => {
  const tags = [...FIFTEEN, "20260901000000", "20260902000000", "latest"];
  const { toDelete, kept, nonSemver } = planGc({
    tags,
    inUse: new Set(["20260901000000"]),
    pinned: "v1.15.0",
    previous: undefined,
    keep: 10,
  });
  assert.deepEqual(nonSemver, ["20260901000000", "20260902000000", "latest"]);
  assert.ok(kept.includes("20260901000000"));
  // non-semver deletions come after the semver deletions (v1.1.0..v1.4.0 are
  // older than the keep window of 10)
  assert.deepEqual(toDelete, ["v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0", "20260902000000", "latest"]);
});

test("planGc: non-semver tag that is the pin itself survives", () => {
  const { toDelete, kept } = planGc({
    tags: ["v1.0.0", "v1.1.0", "latest"],
    inUse: new Set(),
    pinned: "latest",
    previous: undefined,
    keep: 5,
  });
  assert.deepEqual(kept, ["latest"]);
  assert.deepEqual(toDelete, ["v1.0.0", "v1.1.0"]);
});

test("planGc: pinned tag absent from the registry keeps only in-use tags", () => {
  const { toDelete, kept } = planGc({
    tags: FIFTEEN,
    inUse: new Set(["v1.7.0"]),
    pinned: "v9.9.9",
    previous: undefined,
    keep: 10,
  });
  assert.deepEqual(kept, ["v1.7.0"]);
  assert.equal(toDelete.length, 14);
});

test("planGc: keep larger than the available predecessors keeps everything below pinned", () => {
  const { toDelete, kept } = planGc({
    tags: FIFTEEN,
    inUse: new Set(),
    pinned: "v1.2.0",
    previous: undefined,
    keep: 10,
  });
  assert.deepEqual(kept, ["v1.1.0", "v1.2.0"]);
  assert.equal(toDelete.length, 13);
});

test("planGc: keep 0 keeps only pinned, previous and in-use", () => {
  const { toDelete, kept } = planGc({
    tags: FIFTEEN,
    inUse: new Set(["v1.3.0"]),
    pinned: "v1.15.0",
    previous: "v1.14.0",
    keep: 0,
  });
  assert.deepEqual(kept, ["v1.3.0", "v1.14.0", "v1.15.0"]);
  assert.equal(toDelete.length, 12);
});

test("planGc: everything in use -> nothing deleted", () => {
  const { toDelete } = planGc({
    tags: [...FIFTEEN, "latest"],
    inUse: new Set([...FIFTEEN, "latest"]),
    pinned: "v1.15.0",
    previous: undefined,
    keep: 10,
  });
  assert.deepEqual(toDelete, []);
});

test("planGc: semver ordering is numeric (v1.10.0 is newer than v1.9.9)", () => {
  const tags = ["v1.9.9", "v1.10.0", "v1.2.0"];
  const { kept } = planGc({ tags, inUse: new Set(), pinned: "v1.10.0", previous: undefined, keep: 1 });
  assert.deepEqual(kept, ["v1.9.9", "v1.10.0"]);
});
