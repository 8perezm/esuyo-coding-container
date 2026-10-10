import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_OPS,
  REPO_ROOT,
  buildJobArgv,
  captureOutput,
  createServer,
  parseCookies,
  parseDotEnv,
  redactConfig,
  sortSshEntries,
  trimLogs,
} from "./server.js";

test("parseDotEnv: values, comments, quotes, empty lines", () => {
  const parsed = parseDotEnv(
    "# comment\nADMIN_EMAIL=admin@example.com\n\nADMIN_PASSWORD=pa#ss word\nQUOTED=\"hello world\"\nSINGLE='abc'\n"
  );
  assert.equal(parsed.ADMIN_EMAIL, "admin@example.com");
  assert.equal(parsed.ADMIN_PASSWORD, "pa#ss word"); // inline '#' is kept
  assert.equal(parsed.QUOTED, "hello world");
  assert.equal(parsed.SINGLE, "abc");
});

test("parseDotEnv: edge cases (no '=', empty key, empty value)", () => {
  const parsed = parseDotEnv("NOEQUALS\n=novalue\nEMPTY=\n  SPACED = v \n");
  assert.deepEqual(parsed, { EMPTY: "", SPACED: "v" });
});

test("parseCookies: parses name=value pairs", () => {
  assert.deepEqual(parseCookies("a=1; gui_session=tok123; b=2"), {
    a: "1",
    gui_session: "tok123",
    b: "2",
  });
  assert.deepEqual(parseCookies(undefined), {});
});

test("buildJobArgv: deploy/create/delete/gc map op+args to CLI argv", () => {
  assert.deepEqual(
    buildJobArgv("deploy", { noWait: true }, { configPath: "/c/c.yaml" }),
    ["-c", "/c/c.yaml", "deploy", "--no-wait"]
  );
  assert.deepEqual(
    buildJobArgv(
      "create",
      { skipBuild: true, skipPush: true, tag: "v1.2.3" },
      { configPath: "/c/c.yaml" }
    ),
    ["-c", "/c/c.yaml", "--tag", "v1.2.3", "create", "--skip-build", "--skip-push"]
  );
  // -p/--tag global overrides precede the subcommand.
  assert.deepEqual(buildJobArgv("build", { project: "demo" }, { configPath: "/c.yaml" }), [
    "-c",
    "/c.yaml",
    "-p",
    "demo",
    "build",
  ]);
  assert.deepEqual(buildJobArgv("delete", { keepSecrets: true }, { configPath: "/c.yaml" }), [
    "-c",
    "/c.yaml",
    "delete",
    "--keep-secrets",
  ]);
  assert.deepEqual(
    buildJobArgv("gc", { keep: 3, dryRun: true }, { configPath: "/c.yaml" }),
    ["-c", "/c.yaml", "gc", "--keep", "3", "--dry-run"]
  );
});

test("buildJobArgv: system ops + failure cases", () => {
  assert.deepEqual(buildJobArgv("system-init", { tag: "v1.0.0", keep: 10 }, {}), [
    "system",
    "init",
    "--tag",
    "v1.0.0",
    "--keep",
    "10",
  ]);
  assert.deepEqual(buildJobArgv("system-rollback", { tag: "v1.0.1" }, {}), [
    "system",
    "rollback",
    "v1.0.1",
  ]);
  assert.deepEqual(buildJobArgv("list-update", { dryRun: true }, {}), [
    "list",
    "update",
    "--dry-run",
  ]);
  assert.deepEqual(buildJobArgv("key-rotate", {}, { configPath: "/c.yaml" }), [
    "-c",
    "/c.yaml",
    "key",
    "--force",
  ]);
  assert.throws(() => buildJobArgv("system-init", {}, {}), /requires args\.tag/);
  assert.throws(() => buildJobArgv("nope", {}, {}), /unknown op/);
  assert.ok(ALLOWED_OPS.includes("system-gc"));
});

test("redactConfig: redacts secretEnv, keeps the rest, does not mutate", () => {
  const cfg = { project: "p", k8s: { env: { A: "1" }, secretEnv: { KEY: "s3cret", N: 5 } } };
  const out = redactConfig(cfg);
  assert.equal(out.k8s.secretEnv.KEY, "***REDACTED***");
  assert.equal(out.k8s.secretEnv.N, "***REDACTED***");
  assert.equal(out.k8s.env.A, "1");
  assert.equal(cfg.k8s.secretEnv.KEY, "s3cret"); // input untouched
  assert.deepEqual(redactConfig({ project: "p" }), { project: "p" });
});

test("sortSshEntries: IPv4-aware host, then port, then alias; missing last", () => {
  const entries = sortSshEntries([
    { alias: "coding-b", hostName: "10.0.0.19", port: "22" },
    { alias: "coding-a", hostName: "10.0.0.7", port: "22" },
    { alias: "coding-c", hostName: "10.0.0.7", port: "2222" },
    { alias: "coding-d" },
  ]);
  assert.deepEqual(
    entries.map((e) => e.alias),
    ["coding-a", "coding-c", "coding-b", "coding-d"]
  );
});

test("captureOutput: collects console lines and stdout writes, then restores", () => {
  const { lines, stdout } = captureOutput(() => {
    console.log("hello", 1);
    console.warn("careful");
    process.stdout.write("MANIFEST-BODY");
  });
  assert.deepEqual(lines, ["hello 1", "careful"]);
  assert.equal(stdout, "MANIFEST-BODY");
  console.log("restored"); // must not throw / be captured
});

test("trimLogs: short logs pass through, long logs keep the last 200KB", () => {
  assert.equal(trimLogs("abc"), "abc");
  const big = `x${"y".repeat(300 * 1024)}`;
  const trimmed = trimLogs(big);
  assert.equal(trimmed.length, 200 * 1024);
  assert.ok(trimmed.endsWith("y".repeat(10)));
});

test(".env.example exists with required keys", () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "web", ".env.example"), "utf8");
  const parsed = parseDotEnv(raw);
  assert.ok(parsed.ADMIN_EMAIL);
  assert.ok(parsed.ADMIN_PASSWORD);
  assert.ok(parsed.PORT);
});

test("http smoke: health public, me/login/logout gated", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-test-"));
  const env = {
    adminEmail: "admin@example.com",
    adminPassword: "s3cret",
    port: 0,
    projectsFile: path.join(tmp, "projects.json"),
    allowedOrigin: "",
  };
  const server = createServer(env);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Public.
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    // Gated without a session.
    assert.equal((await fetch(`${base}/api/me`)).status, 401);

    // Wrong credentials fail.
    const bad = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "wrong" }),
    });
    assert.equal(bad.status, 401);

    // Correct login sets an HttpOnly session cookie.
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /gui_session=/);
    assert.match(setCookie, /HttpOnly/);
    const cookie = setCookie.split(";")[0];

    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { email: "admin@example.com" });

    const logout = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
