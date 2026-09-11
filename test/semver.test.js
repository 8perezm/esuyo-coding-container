import test from "node:test";
import assert from "node:assert/strict";
import { isSemver, compareSemver, semverSortAsc } from "../src/utils/semver.js";

test("isSemver: only vMAJOR.MINOR.PATCH", () => {
  assert.ok(isSemver("v1.2.3"));
  assert.ok(isSemver("v10.20.30"));
  assert.ok(!isSemver("1.2.3"));
  assert.ok(!isSemver("v1.2"));
  assert.ok(!isSemver("v1"));
  assert.ok(!isSemver("v1.2.3.4"));
  assert.ok(!isSemver("v1.2.3-beta"));
  assert.ok(!isSemver("v1.2.3+build"));
  assert.ok(!isSemver("latest"));
  assert.ok(!isSemver("20260908123045"));
  assert.ok(!isSemver(""));
  assert.ok(!isSemver(null));
  assert.ok(!isSemver(1.2));
});

test("compareSemver: numeric, not lexical", () => {
  assert.ok(compareSemver("v1.2.0", "v1.10.0") < 0);
  assert.ok(compareSemver("v2.0.0", "v10.0.0") < 0);
  assert.ok(compareSemver("v1.10.0", "v1.9.9") > 0);
  assert.ok(compareSemver("v1.2.10", "v1.2.9") > 0);
  assert.equal(compareSemver("v1.2.3", "v1.2.3"), 0);
});

test("semverSortAsc: ascending, non-semver excluded", () => {
  assert.deepEqual(
    semverSortAsc(["v1.10.0", "v1.2.0", "latest", "v1.2.10", "20260101000000", "v1.2.3"]),
    ["v1.2.0", "v1.2.3", "v1.2.10", "v1.10.0"]
  );
  assert.deepEqual(semverSortAsc([]), []);
  assert.deepEqual(semverSortAsc(["latest"]), []);
});
