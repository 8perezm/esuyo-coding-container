import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { localRegistryAuth, credentialHelperAuth, registryHost } from "./registry.js";

// Docker Registry HTTP API V2 client used by `gc` (list/delete tags).
// Uses the same docker credentials as the pull-secret resolution
// (config.json or credential helper) and follows the standard
// WWW-Authenticate Bearer/Basic challenge, like the docker CLI does.
//
// Plain node:http/https with keepAlive disabled (not global fetch): the
// sockets must not outlive the command, or the CLI would hang after gc.

// Per-process state: the registry scheme (detected once), the last
// Authorization header that worked, and bearer tokens cached per
// (realm, service, scope).
const state = { scheme: null, authHeader: null, tokens: new Map() };

// Safety net so a hung registry cannot stall gc indefinitely.
const REQUEST_TIMEOUT_MS = 30000;

const agents = {
  http: new http.Agent({ keepAlive: false }),
  https: new https.Agent({ keepAlive: false }),
};

// Error codes meaning "host is unreachable", where the scheme cannot be
// inferred. Anything else (a dropped TLS handshake, a protocol error) means
// the port is not speaking TLS, i.e. a plain-http registry.
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);

function hostPort(registry) {
  const host = registryHost(registry);
  const m = host.match(/^(.*):(\d+)$/);
  return m ? { host: m[1], port: Number(m[2]) } : { host, port: 443 };
}

/**
 * Detect whether the registry speaks TLS by attempting a handshake (without
 * verifying the certificate — the real requests do their own verification).
 * Resolves to "https" or "http"; on an unreachable host it defaults to
 * "https" so the subsequent request reports a proper "cannot reach" error.
 */
function detectScheme(registry) {
  if (state.scheme) return Promise.resolve(state.scheme);
  const { host, port } = hostPort(registry);
  return new Promise((resolve) => {
    let settled = false;
    let handshakeOk = false;
    // SNI (servername) must be a hostname, not an IP literal.
    const options = { host, port, rejectUnauthorized: false };
    if (!net.isIP(host)) options.servername = host;
    const socket = tls.connect(options, () => {
      handshakeOk = true;
      finish("https");
    });
    function finish(scheme) {
      if (settled) return;
      settled = true;
      socket.destroy();
      state.scheme = scheme;
      resolve(scheme);
    }
    socket.setTimeout(5000, () => finish("http"));
    socket.on("error", (err) => finish(UNREACHABLE.has(err.code) ? "https" : "http"));
    socket.on("close", () => finish(handshakeOk ? "https" : "http"));
  });
}

/**
 * The V2 repository path for the configured image: the registry reference
 * minus the host, plus the image name.
 * "registry.example.com/you" + "coding-container" -> "you/coding-container"
 */
export function registryRepoName(cfg) {
  const host = registryHost(cfg.image.registry);
  const ns = cfg.image.registry.slice(host.length).replace(/^\/+/, "");
  return ns ? `${ns}/${cfg.image.name}` : cfg.image.name;
}

function credentials(cfg) {
  return localRegistryAuth(cfg.image.registry) || credentialHelperAuth(cfg.image.registry);
}

/**
 * Parse the first challenge of a WWW-Authenticate header. A registry may
 * send several challenges in one header (Gitea sends both Bearer and
 * Basic); only the first is usable, and the second challenge's parameters
 * must not leak into the first (its `realm` would overwrite the bearer
 * token endpoint and break the token exchange).
 */
function parseChallenge(header) {
  if (!header) return null;
  // Split on commas outside quoted values (scopes may contain commas).
  const challenges = [];
  let current = "";
  let inQuotes = false;
  for (const ch of header) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      challenges.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  challenges.push(current);
  for (const c of challenges) {
    const m = c.match(/^\s*(Bearer|Basic)\s*(.*)$/i);
    if (!m) continue;
    const params = {};
    for (const pm of m[2].matchAll(/([a-z]+)="([^"]*)"/gi)) params[pm[1].toLowerCase()] = pm[2];
    return { type: m[1].toLowerCase(), ...params };
  }
  return null;
}

/**
 * Minimal fetch-Response-like wrapper over a core http response.
 */
function makeResponse(status, statusText, headers, body) {
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    async json() {
      return JSON.parse(body.toString("utf8"));
    },
    async text() {
      return body.toString("utf8");
    },
  };
}

function request(url, method, headers = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        method,
        path: u.pathname + u.search,
        headers,
        agent: isHttps ? agents.https : agents.http,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve(makeResponse(res.statusCode, res.statusMessage, res.headers, Buffer.concat(chunks)))
        );
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`request to ${u.href} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function send(cfg, method, path, authHeader, extraHeaders = {}) {
  const scheme = await detectScheme(cfg.image.registry);
  const host = registryHost(cfg.image.registry);
  const url = `${scheme}://${host}${path}`;
  try {
    return await request(url, method, {
      ...(authHeader ? { authorization: authHeader } : {}),
      ...extraHeaders,
    });
  } catch (err) {
    const code = err.code ? ` (${err.code})` : "";
    throw new Error(`cannot reach registry at ${url}${code}: ${err.message}`);
  }
}

/**
 * Request with the standard registry auth dance: try with the cached
 * Authorization header, and on 401 follow the WWW-Authenticate challenge
 * (Bearer token exchange or plain Basic) with the local docker credentials.
 */
async function apiRequest(cfg, method, path, extraHeaders = {}) {
  let res = await send(cfg, method, path, state.authHeader, extraHeaders);
  if (res.status !== 401) return res;

  let challenge = parseChallenge(res.headers.get("www-authenticate"));
  if (!challenge) {
    const probe = await send(cfg, "GET", "/v2/", null);
    challenge = parseChallenge(probe.headers.get("www-authenticate"));
  }
  if (!challenge) {
    throw new Error(
      `registry ${registryHost(cfg.image.registry)} returned 401 without a usable ` +
        `WWW-Authenticate challenge (unsupported auth scheme)`
    );
  }
  const creds = credentials(cfg);
  if (!creds) {
    throw new Error(
      `registry ${registryHost(cfg.image.registry)} requires authentication but no ` +
        `docker credentials for it were found. Run: docker login ${registryHost(cfg.image.registry)}`
    );
  }
  const basic = `Basic ${Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64")}`;
  let authHeader;
  if (challenge.type === "basic") {
    authHeader = basic;
  } else if (challenge.type === "bearer") {
    const repo = registryRepoName(cfg);
    const scope = challenge.scope || `repository:${repo}:pull,push`;
    const key = `${challenge.realm}|${challenge.service || ""}|${scope}`;
    let token = state.tokens.get(key);
    if (!token) {
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
      if (scope) tokenUrl.searchParams.set("scope", scope);
      let tokenRes;
      try {
        tokenRes = await request(tokenUrl.href, "GET", { authorization: basic });
      } catch (err) {
        throw new Error(`cannot reach the registry token endpoint at ${tokenUrl.origin}: ${err.message}`);
      }
      if (!tokenRes.ok) {
        throw new Error(
          `registry token request failed with ${tokenRes.status} — check: docker login ${registryHost(cfg.image.registry)}`
        );
      }
      const body = await tokenRes.json().catch(() => ({}));
      token = body.token || body.access_token;
      if (!token) throw new Error("registry token response did not contain a token");
      state.tokens.set(key, token);
    }
    authHeader = `Bearer ${token}`;
  } else {
    throw new Error(`unsupported registry auth scheme: ${challenge.type}`);
  }

  res = await send(cfg, method, path, authHeader, extraHeaders);
  if (res.status === 401) {
    throw new Error(
      `registry authentication failed for ${registryHost(cfg.image.registry)} — check: ` +
        `docker login ${registryHost(cfg.image.registry)}`
    );
  }
  if (res.status === 403) {
    throw new Error(
      `registry ${registryHost(cfg.image.registry)} denied access (403) — the credentials ` +
        `lack permission for ${registryRepoName(cfg)}`
    );
  }
  state.authHeader = authHeader;
  return res;
}

/**
 * All tags of the image, following the V2 pagination Link header.
 */
export async function listTags(cfg) {
  const repo = registryRepoName(cfg);
  const host = registryHost(cfg.image.registry);
  const tags = new Set();
  let path = `/v2/${repo}/tags/list`;
  for (let page = 0; page < 1000; page++) {
    const res = await apiRequest(cfg, "GET", path, { Accept: "application/json" });
    if (res.status === 404) {
      throw new Error(`repository ${cfg.image.registry}/${repo} was not found in the registry`);
    }
    if (!res.ok) {
      throw new Error(`registry tag list failed with ${res.status} ${res.statusText}`.trim());
    }
    const body = await res.json().catch(() => ({}));
    for (const tag of body.tags || []) tags.add(tag);
    const link = res.headers.get("link");
    const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
    if (!next) break;
    const u = new URL(next[1], `${state.scheme}://${host}`);
    path = u.pathname + u.search;
  }
  return [...tags].sort();
}

/**
 * Delete one tag. Returns normally on success (2xx); throws otherwise.
 */
export async function deleteTag(cfg, tag) {
  const repo = registryRepoName(cfg);
  const host = registryHost(cfg.image.registry);
  const res = await apiRequest(cfg, "DELETE", `/v2/${repo}/tags/${encodeURIComponent(tag)}`);
  if (res.status === 404) {
    throw new Error(`tag ${tag} not found (already deleted?)`);
  }
  if (res.status === 405) {
    throw new Error(
      `registry ${host} does not support deleting tags through the registry API (405) — ` +
        `e.g. AWS ECR requires the AWS BatchDeleteImage API instead`
    );
  }
  if (!res.ok) {
    throw new Error(`deleting tag ${tag} failed with ${res.status} ${res.statusText}`.trim());
  }
}
