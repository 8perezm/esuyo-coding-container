import fs from "node:fs";
import path from "node:path";
import { imageRef } from "../config.js";
import { fullManifest, secretEnvEntries, webPorts } from "../utils/manifest.js";
import { readPublicKey } from "../utils/keys.js";
import { getSystemConfig, SYSTEM_CM_NAME } from "../utils/system-config.js";

/**
 * Load-validated config, no side effects. Without --manifest prints a short
 * summary (mode, resolved image, system state when reachable); with it,
 * prints the full multi-doc k8s manifest to stdout (ready for
 * `kubectl apply --dry-run=client -f -`).
 *
 * The coding-system ConfigMap is a cluster read: when the cluster is
 * unreachable or the ConfigMap is missing, validate warns and falls back
 * to the local image.tag instead of failing.
 */
export function validate(cfg, { manifest = false } = {}) {
  let system = null;
  if (cfg.imageMode === "global") {
    try {
      system = getSystemConfig(cfg.k8s.namespace);
    } catch (err) {
      console.warn(
        `warning: could not read the ${SYSTEM_CM_NAME} ConfigMap ` +
          `(offline or not initialized): ${String(err.message).split("\n")[0]}`
      );
    }
  }
  const tag = cfg.image.tag || (system ? system.current : undefined);
  if (tag) cfg.image.tag = tag;

  if (manifest) {
    // Use the real public key when the pair already exists; otherwise a
    // placeholder (validate must never generate keys).
    const publicPath = path.join(cfg.ssh.keyDirPath, `${cfg.ssh.keyName}.pub`);
    const publicKey = fs.existsSync(publicPath)
      ? readPublicKey(publicPath)
      : "ssh-ed25519 AAAAvalidate-only coding-container";
    if (!cfg.image.tag) {
      console.warn(
        "warning: no image tag resolved (no coding-system ConfigMap and no image.tag) — " +
          "rendering with a placeholder tag"
      );
      cfg.image.tag = "__UNRESOLVED__";
    }
    process.stdout.write(fullManifest(cfg, publicKey, null, { redactSecrets: true }));
    if (secretEnvEntries(cfg).length) {
      console.warn(
        `warning: k8s.secretEnv values are redacted above (${secretEnvEntries(cfg).length} key(s)) — ` +
          `deploy applies the real values`
      );
    }
    return;
  }
  console.log(`OK: config is valid for project "${cfg.project}"`);
  console.log(`  mode:      ${cfg.imageMode}${cfg.imageMode === "custom" ? ` (repo ${cfg.image.registry}/${cfg.image.name})` : " (shared global image)"}`);
  if (system) {
    console.log(
      `  system:    current ${system.current}, previous ${system.previous ?? "none"}, ` +
        `maxEver ${system.maxEver}, keep ${system.keep}`
    );
  }
  console.log(
    `  image:     ${
      cfg.image.tag
        ? imageRef(cfg)
        : `${cfg.image.registry}/${cfg.image.name}:<no tag — run 'coding-container system init' or set image.tag>`
    }`
  );
  console.log(`  cluster:   namespace ${cfg.k8s.namespace}, ${cfg.k8s.serviceType} port ${cfg.k8s.nodePort}`);
  const secretKeys = secretEnvEntries(cfg).map(([name]) => name);
  if (secretKeys.length) {
    console.log(`  secrets:   ${secretKeys.join(", ")} (via Secret ${cfg.project}-env, values never shown)`);
  }
  const sidecars = cfg.k8s.sidecars || [];
  if (sidecars.length) {
    console.log(`  sidecars:  ${sidecars.map((s) => s.name).join(", ")}`);
  }
  for (const p of webPorts(cfg)) {
    for (const host of p.hosts) {
      console.log(`  web:       container port ${p.port} -> http://${host}/`);
    }
  }
  for (const v of cfg.nfs.volumes || []) {
    console.log(`  volume:    ${v.subPath} -> ${v.mountPath}${v.readOnly ? " (read-only)" : ""}`);
  }
}
