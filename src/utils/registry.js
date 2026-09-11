import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { exec, runWithInput } from "./exec.js";

function dockerConfigPath() {
  return path.join(os.homedir(), ".docker", "config.json");
}

function readDockerConfig() {
  try {
    const file = dockerConfigPath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Extract the registry host from a registry reference that may include a
 * namespace path, e.g. "registry.example.com/you" -> "registry.example.com".
 */
export function registryHost(registry) {
  return registry.split("/")[0];
}

/**
 * Read registry credentials stored inline in ~/.docker/config.json.
 * Docker stores auths keyed by host only, so the host is derived here.
 * Returns { server, username, password } or null.
 */
export function localRegistryAuth(registry) {
  const cfg = readDockerConfig();
  if (!cfg) return null;
  const host = registryHost(registry);
  const auth = (cfg.auths || {})[host];
  if (!auth) return null;
  let username = auth.username;
  let password = auth.password;
  if (!username && auth.auth) {
    const decoded = Buffer.from(auth.auth, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    username = decoded.slice(0, idx);
    password = decoded.slice(idx + 1);
  }
  if (!username || !password) return null;
  return { server: host, username, password };
}

/**
 * Query the docker credential helper (e.g. docker-credential-desktop) for the
 * registry host. Covers setups where credentials live in the OS keychain
 * instead of config.json.
 */
export function credentialHelperAuth(registry, spawn = spawnSync) {
  const cfg = readDockerConfig();
  if (!cfg) return null;
  const host = registryHost(registry);
  const store =
    (cfg.credHelpers && cfg.credHelpers[host]) || cfg.credsStore || null;
  if (!store) return null;
  return queryCredentialHelper(store, host, spawn);
}

/**
 * Ask each docker-credential-<store> candidate for the host's credentials.
 * `spawn` is injectable for tests.
 */
export function queryCredentialHelper(store, host, spawn = spawnSync) {
  const candidates = [
    `docker-credential-${store}`,
    `docker-credential-${store}.exe`,
    path.join("C:/Program Files/Docker/Docker/resources/bin", `docker-credential-${store}.exe`),
    path.join("C:/Program Files/Docker/Docker", `credentialHelper${store[0].toUpperCase()}${store.slice(1)}.exe`),
  ];

  for (const bin of candidates) {
    for (const serverURL of [host, `https://${host}`]) {
      try {
        // The credential-helper protocol passes the server URL as a plain
        // string on stdin for `get` (JSON is only used for `store`); a JSON
        // payload makes the helper look up a credential literally named
        // after that JSON string and always report "not found".
        const res = spawn(bin, ["get"], {
          input: serverURL,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
        });
        if (res.error || res.status !== 0 || !res.stdout) continue;
        const parsed = JSON.parse(res.stdout.trim());
        if (parsed.Username && parsed.Secret) {
          return { server: host, username: parsed.Username, password: parsed.Secret };
        }
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

export function pullSecretName(registry) {
  return `coding-${registryHost(registry).replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
}

/**
 * Find an existing kubernetes.io/dockerconfigjson secret in the namespace
 * whose dockerconfigjson contains an auth entry for the registry host.
 */
async function discoverExistingSecret(cfg) {
  let items = [];
  try {
    const out = exec("kubectl", ["get", "secret", "-n", cfg.k8s.namespace, "-o", "json"]);
    items = JSON.parse(out).items || [];
  } catch {
    return null;
  }
  const host = registryHost(cfg.image.registry);
  for (const s of items) {
    if (s.type !== "kubernetes.io/dockerconfigjson") continue;
    try {
      const dcj = JSON.parse(
        Buffer.from(s.data[".dockerconfigjson"], "base64").toString("utf8")
      );
      const auths = dcj.auths || {};
      if (Object.keys(auths).some((key) => registryHost(key) === host)) {
        return s.metadata.name;
      }
    } catch {
      /* not parseable, skip */
    }
  }
  return null;
}

/**
 * Resolve a pull secret for the image registry, in priority order:
 *   1. k8s.imagePullSecret from config (must exist in the namespace)
 *   2. a previously created "coding-<host>" managed secret
 *   3. a new managed secret built from local docker credentials
 *   4. an existing dockerconfigjson secret in the namespace matching the host
 *   5. null (with a warning) if the registry is expected to be public
 */
export async function ensurePullSecret(cfg) {
  const ns = cfg.k8s.namespace;
  const name = pullSecretName(cfg.image.registry);

  if (cfg.k8s.imagePullSecret) {
    try {
      exec("kubectl", ["get", "secret", cfg.k8s.imagePullSecret, "-n", ns]);
      return cfg.k8s.imagePullSecret;
    } catch {
      throw new Error(
        `config: k8s.imagePullSecret "${cfg.k8s.imagePullSecret}" not found in namespace ${ns}`
      );
    }
  }

  try {
    exec("kubectl", ["get", "secret", name, "-n", ns]);
    return name;
  } catch {
    /* not created yet */
  }

  const auth = localRegistryAuth(cfg.image.registry) || credentialHelperAuth(cfg.image.registry);
  if (auth) {
    const dockerConfig = JSON.stringify({
      auths: {
        [auth.server]: {
          username: auth.username,
          password: auth.password,
          auth: Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64"),
        },
      },
    });
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace: ns },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": Buffer.from(dockerConfig, "utf8").toString("base64") },
    };
    await runWithInput("kubectl", ["apply", "-f", "-"], JSON.stringify(secret));
    console.log(`Created pull secret ${name} in ${ns}`);
    return name;
  }

  const discovered = await discoverExistingSecret(cfg);
  if (discovered) {
    console.log(`Using existing pull secret ${discovered} in ${ns}`);
    return discovered;
  }

  console.log(
    `No local docker credentials for ${cfg.image.registry} found and no matching ` +
      `pull secret in ${ns}. The cluster must already be able to pull the image, ` +
      `or set k8s.imagePullSecret in the config.`
  );
  return null;
}
