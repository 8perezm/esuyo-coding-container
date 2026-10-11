import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_OPS,
  REPO_ROOT,
  buildJobArgv,
  buildStarterYaml,
  captureOutput,
  configuredPorts,
  createServer,
  findClaimedNodePorts,
  findTakenNodePorts,
  getWorkloadsStatus,
  isManagedConfigPath,
  managedProjectsDir,
  parseCookies,
  parseDotEnv,
  parseTopNodes,
  parseTopPods,
  redactConfig,
  slugifyProjectName,
  sortSshEntries,
  trimLogs,
  uniqueManagedConfigPath,
  updateEnvFilePassword,
  validatePasswordChange,
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
  const raw = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  const parsed = parseDotEnv(raw);
  assert.ok(parsed.ADMIN_EMAIL);
  assert.ok(parsed.ADMIN_PASSWORD);
  assert.ok(parsed.PORT);
});

test("parseTopNodes: parses kubectl top nodes lines", () => {
  const map = parseTopNodes("worker-01  250m  12%  1800Mi  28%\nworker-02  90m  4%  900Mi  14%\n");
  assert.equal(map.get("worker-01").cpu, "250m");
  assert.equal(map.get("worker-01").cpuPercent, 12);
  assert.equal(map.get("worker-01").memory, "1800Mi");
  assert.equal(map.get("worker-01").memoryPercent, 28);
  assert.equal(map.get("worker-02").cpu, "90m");
  assert.equal(parseTopNodes("").size, 0);
});

test("parseTopPods: parses kubectl top pods lines", () => {
  const map = parseTopPods("my-project-abc  15m  220Mi\n");
  assert.deepEqual(map.get("my-project-abc"), { cpu: "15m", memory: "220Mi" });
  assert.equal(parseTopPods("garbage line").size, 0);
});

test("configuredPorts: exposes ssh/web/sidecar ports from a config", () => {
  const cfg = {
    ssh: { port: 22 },
    k8s: { nodePort: 30022, nodeName: "", sidecars: [{ name: "db", ports: [{ containerPort: 5432, nodePort: 30432 }] }] },
    web: { ports: [{ port: 3000, hosts: ["web.example.com"], nodePort: 30080 }] },
  };
  const out = configuredPorts(cfg);
  assert.equal(out.sshNodePort, 30022);
  assert.equal(out.web[0].nodePort, 30080);
  assert.deepEqual(out.web[0].hosts, ["web.example.com"]);
  assert.equal(out.sidecars[0].nodePort, 30432);
});

test("getWorkloadsStatus: bad config path degrades to error entry, never throws", () => {
  const { workloads } = getWorkloadsStatus([
    { id: "missing-1", name: "ghost", configPath: "/nonexistent/config.yaml" },
  ]);
  assert.equal(workloads.length, 1);
  assert.equal(workloads[0].deployed, false);
  assert.ok(workloads[0].error);
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

test("http: cluster endpoints are gated and degrade without a cluster", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-cluster-"));
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
    // Gated without a session.
    assert.equal((await fetch(`${base}/api/cluster/nodes`)).status, 401);
    assert.equal((await fetch(`${base}/api/cluster/ports`)).status, 401);
    assert.equal((await fetch(`${base}/api/cluster/workloads`)).status, 401);

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    for (const p of ["/api/cluster/nodes", "/api/cluster/ports", "/api/cluster/workloads"]) {
      const r = await fetch(`${base}${p}`, { headers: { cookie } });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok("ok" in body);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("validatePasswordChange: requires current, min length, difference", () => {
  assert.equal(validatePasswordChange("", "newpassword1"), "current password is required");
  assert.equal(validatePasswordChange("old", ""), "new password is required");
  assert.equal(validatePasswordChange("old", "short"), "new password must be at least 8 characters");
  assert.equal(validatePasswordChange("samepass1", "samepass1"), "new password must be different");
  assert.equal(validatePasswordChange("oldpass99", "brandnew99"), null);
});

test("updateEnvFilePassword: preserves other lines and appends when missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-env-"));
  const file = path.join(tmp, ".env");
  fs.writeFileSync(file, "# comment\nADMIN_EMAIL=a@b.c\nADMIN_PASSWORD=old\nPORT=3000\n");
  updateEnvFilePassword(file, "newpass99");
  const raw = fs.readFileSync(file, "utf8");
  assert.match(raw, /# comment/);
  assert.match(raw, /ADMIN_EMAIL=a@b\.c/);
  assert.match(raw, /ADMIN_PASSWORD=newpass99/);
  assert.match(raw, /PORT=3000/);

  const missing = path.join(tmp, "fresh.env");
  updateEnvFilePassword(missing, "another99");
  assert.match(fs.readFileSync(missing, "utf8"), /ADMIN_PASSWORD=another99/);
});

test("http: change-password updates login and persists to env file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-passwd-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(envFile, "ADMIN_EMAIL=admin@example.com\nADMIN_PASSWORD=oldpass99\nPORT=3000\n");
  const env = {
    adminEmail: "admin@example.com",
    adminPassword: "oldpass99",
    port: 0,
    projectsFile: path.join(tmp, "projects.json"),
    allowedOrigin: "",
    envFile,
  };
  const server = createServer(env);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const loginAs = async (password) => {
    const r = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password }),
    });
    return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] };
  };
  try {
    // Gated without a session.
    assert.equal(
      (
        await fetch(`${base}/api/change-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ currentPassword: "x", newPassword: "y" }),
        })
      ).status,
      401
    );

    const first = await loginAs("oldpass99");
    assert.equal(first.status, 200);
    const second = await loginAs("oldpass99");
    assert.equal(second.status, 200);

    // Wrong current password fails.
    const wrong = await fetch(`${base}/api/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ currentPassword: "nope-nope", newPassword: "brandnew99" }),
    });
    assert.equal(wrong.status, 401);

    // Too short fails.
    const short = await fetch(`${base}/api/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ currentPassword: "oldpass99", newPassword: "short" }),
    });
    assert.equal(short.status, 400);

    // Correct change succeeds, persists, and drops the other session.
    const changed = await fetch(`${base}/api/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ currentPassword: "oldpass99", newPassword: "brandnew99" }),
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { ok: true, persisted: true });
    assert.match(fs.readFileSync(envFile, "utf8"), /ADMIN_PASSWORD=brandnew99/);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: second.cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: first.cookie } })).status, 200);

    // Old password dead, new password works.
    assert.equal((await loginAs("oldpass99")).status, 401);
    assert.equal((await loginAs("brandnew99")).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("http: POST /api/validate + /api/manifest validate unsaved drafts without touching disk", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-draft-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  try {
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
    fs.mkdirSync(globalDir, { recursive: true });
    const globalYaml = "image:\n  registry: registry.example.com\nnfs:\n  server: nas.local\n  basePath: /data\n";
    fs.writeFileSync(path.join(globalDir, "config.yaml"), globalYaml);

    const projDir = path.join(tmp, "proj");
    fs.mkdirSync(projDir, { recursive: true });
    const configPath = path.join(projDir, "config.yaml");
    const savedYaml = "project: demo\n";
    fs.writeFileSync(configPath, savedYaml);
    const projectsFile = path.join(tmp, "projects.json");
    fs.writeFileSync(projectsFile, JSON.stringify([{ id: "p1", name: "demo", configPath }]));

    const env = {
      adminEmail: "admin@example.com",
      adminPassword: "s3cret",
      port: 0,
      projectsFile,
      allowedOrigin: "",
    };
    const server = createServer(env);
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const post = (p, body) =>
        fetch(`${base}${p}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // Valid draft with a different project name than the file on disk.
      let r = await post("/api/validate", { projectId: "p1", yaml: "project: draft-name\n" });
      assert.equal(r.status, 200);
      let body = await r.json();
      assert.equal(body.ok, true);
      assert.ok((body.lines ?? []).join("\n").includes("draft-name"), "must validate the draft, not the saved file");
      assert.equal(fs.readFileSync(configPath, "utf8"), savedYaml);

      // Invalid draft fails (load-time 400, same as GET) without touching the good file.
      r = await post("/api/validate", { projectId: "p1", yaml: "project: 'BAD NAME!!'\n" });
      assert.equal(r.status, 400);
      body = await r.json();
      assert.equal(body.ok, false);
      assert.ok(body.error);
      assert.equal(fs.readFileSync(configPath, "utf8"), savedYaml);

      // Manifest renders from the draft.
      r = await post("/api/manifest", { projectId: "p1", yaml: "project: demo\n" });
      assert.equal(r.status, 200);
      body = await r.json();
      assert.ok(String(body.manifest).includes("kind:"), "manifest must render");
      assert.ok(Array.isArray(body.warnings));

      // Bad global draft fails (load-time 400) without touching the real global file.
      r = await post("/api/validate", { projectId: "p1", globalYaml: "image:\n  registry: ''\n" });
      assert.equal(r.status, 400);
      body = await r.json();
      assert.equal(body.ok, false);
      assert.equal(fs.readFileSync(path.join(globalDir, "config.yaml"), "utf8"), globalYaml);

      // GET still validates the saved file.
      const g = await fetch(`${base}/api/validate?projectId=p1`, { headers: { cookie } });
      assert.equal((await g.json()).ok, true);

      // No temp files left behind in either directory.
      for (const dir of [projDir, globalDir]) {
        const leftovers = fs.readdirSync(dir).filter((f) => f.includes("draft"));
        assert.deepEqual(leftovers, []);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("slugifyProjectName: lowercases, dashes, trims, fallbacks", () => {
  assert.equal(slugifyProjectName("My Project!"), "my-project");
  assert.equal(slugifyProjectName("  --Foo__Bar--  "), "foo-bar");
  assert.equal(slugifyProjectName(""), "project");
  assert.equal(slugifyProjectName("!!!"), "project");
  assert.ok(slugifyProjectName("a".repeat(100)).length <= 63);
});

test("managed paths: dir, detection, unique suffix", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-managed-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  try {
    const dir = managedProjectsDir();
    assert.ok(dir.endsWith(path.join("coding-container", "projects")) || dir.includes("projects"));
    const managed = path.join(dir, "demo", "config.yaml");
    const custom = path.join(tmp, "elsewhere", "config.yaml");
    assert.equal(isManagedConfigPath(managed), true);
    assert.equal(isManagedConfigPath(custom), false);
    // Suffix when taken by registry or disk.
    const projects = [{ id: "a", name: "demo", configPath: managed }];
    assert.equal(uniqueManagedConfigPath(projects, "demo").slug, "demo-2");
    assert.equal(uniqueManagedConfigPath([], "fresh").slug, "fresh");
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "project: demo\n");
    assert.equal(uniqueManagedConfigPath([], "demo").slug, "demo-2");
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("http: GET /api/global-config reports the system Dockerfile location", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-global-df-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  try {
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "config.yaml"), "image:\n  registry: registry.example.com\n");
    fs.writeFileSync(path.join(globalDir, "Dockerfile"), "FROM scratch\n");
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
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

      let r = await fetch(`${base}/api/global-config`, { headers: { cookie } });
      assert.equal(r.status, 200);
      let body = await r.json();
      assert.equal(body.dockerfile.path, path.join(globalDir, "Dockerfile"));
      assert.equal(body.dockerfile.exists, true);

      // Custom image.dockerfile in the global layer is honored.
      fs.writeFileSync(
        path.join(globalDir, "config.yaml"),
        "image:\n  registry: registry.example.com\n  dockerfile: custom/Dockerfile\n"
      );
      r = await fetch(`${base}/api/global-config`, { headers: { cookie } });
      body = await r.json();
      assert.equal(body.dockerfile.path, path.join(globalDir, "custom", "Dockerfile"));
      assert.equal(body.dockerfile.exists, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("buildStarterYaml: app + postgres sidecar with interpolated slug/ports", () => {
  const yaml = buildStarterYaml({ slug: "My App!", mainNodePort: 30022, dbNodePort: 30432 });
  assert.ok(yaml.includes("project: my-app"));
  assert.ok(yaml.includes("nodePort: 30022"));
  assert.ok(yaml.includes("name: postgres"));
  assert.ok(yaml.includes("postgres:18.6"));
  assert.ok(yaml.includes("containerPort: 5432"));
  assert.ok(yaml.includes("nodePort: 30432"));
  assert.ok(yaml.includes("POSTGRES_USER: my-app"));
  assert.ok(yaml.includes("POSTGRES_DB: my-app"));
  assert.ok(yaml.includes("POSTGRES_PASSWORD: my-app"));
  assert.ok(yaml.includes("app-my-app.example.com"));
});

test("findTakenNodePorts: flags foreign holders, ignores own service and free ports", () => {
  const cfg = {
    project: "demo",
    k8s: {
      namespace: "coding",
      nodePort: 30022,
      sidecars: [{ name: "db", ports: [{ containerPort: 5432, nodePort: 30432 }] }],
    },
    web: { ports: [{ port: 3000, hosts: ["web.example.com"], nodePort: 30080 }] },
  };
  const live = {
    ports: [
      { namespace: "coding", service: "other", nodePort: 30022 },
      { namespace: "coding", service: "demo", nodePort: 30432 },
      { namespace: "coding", service: "someone", nodePort: 30080 },
    ],
  };
  const taken = findTakenNodePorts(cfg, live);
  assert.deepEqual(
    taken.map((t) => t.nodePort),
    [30022, 30080]
  );
  assert.equal(taken[0].service, "other");
  assert.equal(taken[1].label, "web port 3000");
  // Own service's port is not flagged; unknown shapes degrade to empty.
  assert.deepEqual(findTakenNodePorts(cfg, { ports: [] }), []);
  assert.deepEqual(findTakenNodePorts(cfg, null), []);
});

test("findClaimedNodePorts: flags ports claimed by other saved configs", () => {
  const wanted = [
    { nodePort: 30022, label: "ssh" },
    { nodePort: 30432, label: "sidecar db" },
  ];
  const claimed = findClaimedNodePorts(wanted, [
    { name: "blog", wanted: [{ nodePort: 30022, label: "ssh" }] },
    { name: "shop", wanted: [{ nodePort: 30099, label: "ssh" }] },
  ]);
  assert.deepEqual(
    claimed.map((c) => [c.nodePort, c.project, c.projectLabel]),
    [[30022, "blog", "ssh"]]
  );
  assert.deepEqual(findClaimedNodePorts(wanted, []), []);
});
test("http: validate mentions cluster-taken NodePorts but still passes; silent offline", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-ports-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevKubectl = process.env.KUBECTL_BIN;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  try {
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.yaml"),
      "image:\n  registry: registry.example.com\nnfs:\n  server: nas.local\n  basePath: /data\n"
    );
    const projDir = path.join(tmp, "proj");
    fs.mkdirSync(projDir, { recursive: true });
    const configPath = path.join(projDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "project: demo\nk8s:\n  sidecars:\n    - name: db\n      image: postgres:18.6\n      ports:\n        - { containerPort: 5432, nodePort: 30432 }\n"
    );
    const projectsFile = path.join(tmp, "projects.json");
    fs.writeFileSync(projectsFile, JSON.stringify([{ id: "p1", name: "demo", configPath }]));

    const stubDir = path.join(tmp, "stub");
    fs.mkdirSync(stubDir, { recursive: true });
    const svcJson = JSON.stringify({
      items: [
        { metadata: { namespace: "coding", name: "other" }, spec: { ports: [{ nodePort: 30022 }] } },
        { metadata: { namespace: "coding", name: "demo" }, spec: { ports: [{ nodePort: 30432 }] } },
      ],
    });
    fs.writeFileSync(
      path.join(stubDir, "kubectl-stub.js"),
      [
        'const joined = process.argv.slice(2).join(" ");',
        'function out(s) { process.stdout.write(s + "\\n"); }',
        'function die(msg) { process.stderr.write(msg + "\\n"); process.exit(1); }',
        'if (joined.startsWith("get svc")) {',
        `  out(${JSON.stringify(svcJson)});`,
        '} else if (joined.startsWith("get cm")) {',
        '  die(\'Error from server (NotFound): configmaps "coding-system" not found\');',
        "} else {",
        '  die("unexpected kubectl args: " + joined);',
        "}",
      ].join("\n")
    );
    process.env.KUBECTL_BIN = path.join(stubDir, "kubectl-stub.js");

    const env = {
      adminEmail: "admin@example.com",
      adminPassword: "s3cret",
      port: 0,
      projectsFile,
      allowedOrigin: "",
    };
    const server = createServer(env);
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

      // Foreign-held ssh port is mentioned; own sidecar port is not; still ok.
      let r = await fetch(`${base}/api/validate?projectId=p1`, { headers: { cookie } });
      assert.equal(r.status, 200);
      let body = await r.json();
      assert.equal(body.ok, true);
      const text = (body.lines ?? []).join("\n");
      assert.ok(text.includes('nodePort 30022') && text.includes('service "other"'), "must mention the taken port");
      assert.ok(
        (body.lines ?? [])[0].includes("nodePort 30022"),
        "taken-port warning must be the first validation line"
      );
      assert.ok(!text.includes("30432"), "must not flag the project's own port");
      assert.deepEqual(
        body.portConflicts.map((c) => c.nodePort),
        [30022]
      );

      // Inactive project claiming a port in its saved YAML is also mentioned.
      const blogPath = path.join(projDir, "blog.yaml");
      fs.writeFileSync(
        blogPath,
        "project: blog\nk8s:\n  sidecars:\n    - name: db\n      image: postgres:18.6\n      ports:\n        - { containerPort: 5432, nodePort: 30432 }\n"
      );
      const registry = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
      registry.push({ id: "p2", name: "blog", configPath: blogPath });
      fs.writeFileSync(projectsFile, JSON.stringify(registry));
      r = await fetch(`${base}/api/validate?projectId=p1`, { headers: { cookie } });
      assert.equal(r.status, 200);
      body = await r.json();
      assert.equal(body.ok, true);
      const claimedText = (body.lines ?? []).join("\n");
      assert.ok(
        claimedText.includes("nodePort 30432") && claimedText.includes('also claimed by project "blog"'),
        "must mention the port claimed by the inactive project"
      );
      assert.ok(
        (body.lines ?? [])[0].includes("already in use"),
        "cluster conflicts stay above YAML-claim warnings"
      );
      const claim = body.portConflicts.find((c) => c.nodePort === 30432);
      assert.equal(claim?.source, "project");
      assert.equal(claim?.project, "blog");

      // Validating blog itself never flags its own claim.
      r = await fetch(`${base}/api/validate?projectId=p2`, { headers: { cookie } });
      assert.equal(r.status, 200);
      body = await r.json();
      assert.equal(body.ok, true);
      assert.ok(
        !(body.lines ?? []).join("\n").includes('also claimed by project "blog"'),
        "a project must not warn about its own saved config"
      );

      // Unreachable cluster: still passes; cluster warnings drop out but local
      // YAML-claim warnings still apply (they need no cluster).
      fs.writeFileSync(
        path.join(stubDir, "kubectl-stub.js"),
        'process.stderr.write("no cluster\\n"); process.exit(1);\n'
      );
      r = await fetch(`${base}/api/validate?projectId=p1`, { headers: { cookie } });
      assert.equal(r.status, 200);
      body = await r.json();
      assert.equal(body.ok, true);
      assert.deepEqual(
        body.portConflicts.map((c) => [c.nodePort, c.source]),
        [
          [30022, "project"],
          [30432, "project"],
        ]
      );
      const offlineText = (body.lines ?? []).join("\n");
      assert.ok(!offlineText.includes("already in use"), "no cluster warnings while offline");
      assert.ok(offlineText.includes("also claimed"), "YAML-claim warnings still apply offline");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevKubectl === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = prevKubectl;
  }
});
test("http: name-only create assigns managed path; rename moves file; starter works", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-projects-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  try {
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.yaml"),
      "image:\n  registry: registry.example.com\nnfs:\n  server: nas.local\n  basePath: /data\n"
    );
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
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const json = (method, p, body) =>
        fetch(`${base}${p}`, {
          method,
          headers: { cookie, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      // Name-only create: no file on disk yet, managed path assigned.
      let r = await json("POST", "/api/projects", { name: "My Project!" });
      assert.equal(r.status, 201);
      let created = (await r.json()).project;
      assert.equal(created.name, "My Project!");
      assert.equal(isManagedConfigPath(created.configPath), true);
      assert.ok(created.configPath.endsWith(path.join("my-project", "config.yaml")));
      assert.equal(fs.existsSync(created.configPath), false);

      // Same name again → suffixed slug.
      r = await json("POST", "/api/projects", { name: "My Project!" });
      assert.equal(r.status, 201);
      const second = (await r.json()).project;
      assert.ok(second.configPath.endsWith(path.join("my-project-2", "config.yaml")));

      // Save a config, then rename → file moves, content preserved.
      const yaml = "project: my-project\n";
      r = await json("PUT", "/api/config", { projectId: created.id, yaml });
      assert.equal(r.status, 200);
      assert.equal(fs.readFileSync(created.configPath, "utf8"), yaml);
      r = await json("PUT", `/api/projects/${created.id}`, { name: "Renamed!" });
      assert.equal(r.status, 200);
      const renamed = (await r.json()).project;
      assert.equal(renamed.name, "Renamed!");
      assert.ok(renamed.configPath.endsWith(path.join("renamed", "config.yaml")));
      assert.equal(fs.existsSync(created.configPath), false);
      assert.equal(fs.readFileSync(renamed.configPath, "utf8"), yaml);

      // Custom paths stay put on rename.
      const customPath = path.join(tmp, "custom", "config.yaml");
      fs.mkdirSync(path.dirname(customPath), { recursive: true });
      fs.writeFileSync(customPath, "project: custom\n");
      r = await json("POST", "/api/projects", { name: "Custom", configPath: customPath });
      assert.equal(r.status, 201);
      const custom = (await r.json()).project;
      r = await json("PUT", `/api/projects/${custom.id}`, { name: "Custom2" });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).project.configPath, custom.configPath);
      assert.equal(fs.existsSync(customPath), true);

      // Starter endpoint renders the example for the project.
      r = await fetch(`${base}/api/project-starter?projectId=${created.id}`, { headers: { cookie } });
      assert.equal(r.status, 200);
      const starter = await r.json();
      assert.equal(starter.slug, "renamed");
      assert.ok(starter.yaml.includes("project: renamed"));
      assert.ok(starter.yaml.includes("postgres"));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});
