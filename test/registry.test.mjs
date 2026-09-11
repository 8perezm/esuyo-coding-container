import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registryHost,
  localRegistryAuth,
  credentialHelperAuth,
  queryCredentialHelper,
} from "../src/utils/registry.js";
import { loadPersonal } from "./personal.mjs";

const HOST = "registry.example.com";

function helperSpawnRespondingTo(url) {
  return (bin, args, opts) => {
    calls.push({ bin, args, input: opts.input });
    if (opts.input === url) {
      return {
        error: null,
        status: 0,
        stdout: JSON.stringify({ ServerURL: opts.input, Username: "helper-user", Secret: "helper-secret" }),
      };
    }
    return { error: null, status: 1, stdout: "", stderr: "credentials not found in native keychain" };
  };
}

let calls;

test("registryHost: strips the namespace path, keeps a port", () => {
  assert.equal(registryHost("registry.example.com/you"), "registry.example.com");
  assert.equal(registryHost("localhost:5000/foo"), "localhost:5000");
});

test("registryHost: personal registries from fixtures.local.mjs (if present)", async () => {
  const { registries } = await loadPersonal();
  for (const registry of registries) {
    assert.equal(registryHost(registry), registry.split("/")[0]);
  }
});

test("queryCredentialHelper: asks the helper with the plain server URL on stdin", () => {
  calls = [];
  const auth = queryCredentialHelper("desktop", HOST, helperSpawnRespondingTo(HOST));
  assert.deepEqual(auth, { server: HOST, username: "helper-user", password: "helper-secret" });
  assert.deepEqual(calls[0].args, ["get"]);
  // Regression: the credential-helper protocol takes the server URL as a
  // plain string, not a JSON object (a JSON payload made the helper look
  // up a credential literally named after the JSON and always miss).
  assert.equal(calls[0].input, HOST);
});

test("queryCredentialHelper: falls back to the https:// variant", () => {
  calls = [];
  const asked = [];
  const spawn = (bin, args, opts) => {
    asked.push(opts.input);
    if (opts.input === `https://${HOST}`) {
      return { error: null, status: 0, stdout: JSON.stringify({ ServerURL: opts.input, Username: "u", Secret: "s" }) };
    }
    return { error: null, status: 1, stdout: "", stderr: "" };
  };
  const auth = queryCredentialHelper("desktop", HOST, spawn);
  assert.deepEqual(auth, { server: HOST, username: "u", password: "s" });
  assert.deepEqual(asked, [HOST, `https://${HOST}`]);
});

test("queryCredentialHelper: no credentials -> null", () => {
  calls = [];
  const auth = queryCredentialHelper(
    "desktop",
    HOST,
    () => ({ error: null, status: 1, stdout: "", stderr: "credentials not found in native keychain" })
  );
  assert.equal(auth, null);
});

test("queryCredentialHelper: helper missing -> null", () => {
  calls = [];
  const auth = queryCredentialHelper(
    "desktop",
    HOST,
    () => ({ error: new Error("spawn ENOENT"), status: null, stdout: undefined })
  );
  assert.equal(auth, null);
});

let home;
let prevUserProfile, prevHome;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "reg-cred-home-"));
  fs.mkdirSync(path.join(home, ".docker"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".docker", "config.json"),
    JSON.stringify({
      credsStore: "desktop",
      auths: { [HOST]: { auth: Buffer.from("inline-user:inline-pass").toString("base64") } },
    })
  );
  prevUserProfile = process.env.USERPROFILE;
  prevHome = process.env.HOME;
  process.env.USERPROFILE = home; // win32
  process.env.HOME = home; // posix
});

after(() => {
  process.env.USERPROFILE = prevUserProfile;
  process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("localRegistryAuth: inline auths entry wins", () => {
  assert.deepEqual(localRegistryAuth(HOST), {
    server: HOST,
    username: "inline-user",
    password: "inline-pass",
  });
});

test("credentialHelperAuth: consults the credsStore helper when no inline auth", () => {
  fs.writeFileSync(
    path.join(home, ".docker", "config.json"),
    JSON.stringify({ credsStore: "desktop" })
  );
  calls = [];
  const auth = credentialHelperAuth(HOST, helperSpawnRespondingTo(HOST));
  assert.deepEqual(auth, { server: HOST, username: "helper-user", password: "helper-secret" });
  assert.equal(calls[0].bin, "docker-credential-desktop");
  assert.equal(calls[0].input, HOST);
});
