import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registryRepoName, listTags, deleteTag } from "../src/utils/registry-api.js";
import { loadPersonal } from "./personal.mjs";

// A minimal Docker Registry V2 mock: requires a Bearer token (obtained with
// Basic docker creds), paginates the tag list, and records deletions.
let server, PORT, host, cfg, home;
const deleted = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const auth = req.headers.authorization || "";
    if (req.method === "GET" && url.pathname === "/token") {
      const expected = "Basic " + Buffer.from("user:pass").toString("base64");
      if (auth !== expected) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mock"' }); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ token: "tok" }));
    }
    const ok = auth === "Bearer tok";
    const challenge = `Bearer realm="http://127.0.0.1:${PORT}/token",service="mock",scope="repository:foo/bar:pull,push"`;
    if (req.method === "GET" && url.pathname === "/v2/foo/bar/tags/list") {
      if (!ok) { res.writeHead(401, { "WWW-Authenticate": challenge }); return res.end(); }
      if (!url.searchParams.has("last")) {
        res.writeHead(200, { "Content-Type": "application/json", Link: `</v2/foo/bar/tags/list?last=x>; rel="next"` });
        return res.end(JSON.stringify({ name: "foo/bar", tags: ["t2", "t1"] }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ name: "foo/bar", tags: ["t3"] }));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/v2/foo/bar/tags/")) {
      if (!ok) { res.writeHead(401, { "WWW-Authenticate": challenge }); return res.end(); }
      deleted.push(decodeURIComponent(url.pathname.split("/").pop()));
      res.writeHead(202);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  host = `127.0.0.1:${PORT}`;
  cfg = { image: { registry: `${host}/foo`, name: "bar" } };

  // Point os.homedir() at a throwaway home holding docker creds for the mock.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "reg-api-home-"));
  fs.mkdirSync(path.join(home, ".docker"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".docker", "config.json"),
    JSON.stringify({ auths: { [host]: { auth: Buffer.from("user:pass").toString("base64") } } })
  );
  process.env.USERPROFILE = home; // win32
  process.env.HOME = home; // posix
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

test("registryRepoName: registry minus host plus image name", () => {
  assert.equal(registryRepoName({ image: { registry: "registry.example.com/you", name: "coding-container" } }), "you/coding-container");
  assert.equal(registryRepoName({ image: { registry: "127.0.0.1:5000", name: "bar" } }), "bar");
});

test("registryRepoName: personal registries from fixtures.local.mjs (if present)", async () => {
  const { registries } = await loadPersonal();
  for (const registry of registries) {
    const host = registry.split("/")[0];
    const ns = registry.slice(host.length).replace(/^\/+/, "");
    const expected = ns ? `${ns}/coding-container` : "coding-container";
    assert.equal(registryRepoName({ image: { registry, name: "coding-container" } }), expected);
  }
});

test("listTags: authenticates and follows pagination", async () => {
  const tags = await listTags(cfg);
  assert.deepEqual(tags.sort(), ["t1", "t2", "t3"]);
});

test("deleteTag: issues an authenticated DELETE", async () => {
  await deleteTag(cfg, "t1");
  assert.deepEqual(deleted, ["t1"]);
});

test("listTags: registry sending Bearer and Basic challenges in one header (Gitea)", async () => {
  let gport;
  const gitea = http.createServer((req, res) => {
    if (req.url.startsWith("/v2/token")) {
      const expected = "Basic " + Buffer.from("user:pass").toString("base64");
      if (req.headers.authorization !== expected) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ token: "gtok" }));
    }
    if (req.url.startsWith("/v2/gitea/repo/tags/list")) {
      if (req.headers.authorization !== "Bearer gtok") {
        res.writeHead(401, {
          "WWW-Authenticate": [
            `Bearer realm="http://127.0.0.1:${gport}/v2/token",service="container_registry",scope="*"`,
            'Basic realm="Gitea Container Registry"',
          ],
        });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ name: "gitea/repo", tags: ["a2", "a1"] }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => gitea.listen(0, "127.0.0.1", r));
  gport = gitea.address().port;
  const cfgFile = path.join(home, ".docker", "config.json");
  const cfgJson = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfgJson.auths[`127.0.0.1:${gport}`] = { auth: Buffer.from("user:pass").toString("base64") };
  fs.writeFileSync(cfgFile, JSON.stringify(cfgJson));
  try {
    const tags = await listTags({ image: { registry: `127.0.0.1:${gport}/gitea`, name: "repo" } });
    assert.deepEqual(tags.sort(), ["a1", "a2"]);
  } finally {
    await new Promise((r) => gitea.close(r));
  }
});
