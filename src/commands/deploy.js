import path from "node:path";
import { exec, run, runWithInput } from "../utils/exec.js";
import { ensureKeyPair, readPublicKey } from "../utils/keys.js";
import { ensurePullSecret } from "../utils/registry.js";
import { fullManifest, webPorts, sidecarNodePorts as sidecarNodePortsList } from "../utils/manifest.js";
import { imageRef } from "../config.js";
import { addHostEntry, ephemeralKnownHostsFile, removeLegacyKnownHostsFile, sshAlias, sshConfigPath } from "../utils/ssh-config.js";
import { findNodePortOwner } from "../utils/project.js";
import { kubectlExec, resolveDeployTag, SYSTEM_CM_NAME } from "../utils/system-config.js";

export async function ensureNamespace(ns) {
  const { cmd, args, opts } = kubectlExec();
  try {
    exec(cmd, [...args, "get", "namespace", ns], opts);
  } catch {
    console.log(`Creating namespace ${ns} ...`);
    await run(cmd, [...args, "create", "namespace", ns], opts);
  }
}

export async function deploy(cfg, { wait = true } = {}) {
  // Tag resolution (the float): custom mode uses the project pin; global
  // mode uses the project pin/--tag when set, else the ConfigMap's current.
  const hadExplicitTag = Boolean(cfg.image.tag);
  cfg.image.tag = resolveDeployTag(cfg);
  if (cfg.imageMode === "global" && !hadExplicitTag) {
    console.log(
      `Global image mode: deploying version ${cfg.image.tag} from the ${SYSTEM_CM_NAME} ConfigMap ` +
        `('system get' to inspect, 'system rollback' to repoint, 'system create --tag vX.Y.Z' to publish new).`
    );
  }

  const { public: publicPath } = ensureKeyPair(cfg.ssh.keyDirPath, cfg.ssh.keyName);
  const publicKey = readPublicKey(publicPath);

  const ns = cfg.k8s.namespace;
  await ensureNamespace(ns);

  // Fail fast on a taken NodePort: applying anyway leaves a partial state
  // (deployment + ingress created, service invalid).
  if (cfg.k8s.serviceType === "NodePort") {
    const wanted = [
      [cfg.k8s.nodePort, "k8s.nodePort (SSH)"],
      ...webPorts(cfg)
        .filter((p) => p.nodePort !== undefined)
        .map((p) => [p.nodePort, `web port "${p.name}"`]),
      ...sidecarNodePortsList(cfg).map((p) => [p.nodePort, `sidecar port "${p.name}"`]),
    ];
    for (const [port, what] of wanted) {
      const owner = findNodePortOwner(port);
      // Our own service (redeploy with an unchanged port) is not a conflict.
      if (owner && !(owner.namespace === ns && owner.name === cfg.project)) {
        throw new Error(
          `nodePort ${port} (${what}) is already allocated to service "${owner.name}" ` +
            `in namespace "${owner.namespace}"; pick another port (30000-32767) in config.yaml`
        );
      }
    }
  }

  const pullSecret = await ensurePullSecret(cfg);

  const manifest = fullManifest(cfg, publicKey, pullSecret);
  const { cmd: kubectl, args: kargs, opts: kopts } = kubectlExec();
  console.log(`Deploying ${imageRef(cfg)} to namespace ${cfg.k8s.namespace} ...`);
  await runWithInput(kubectl, [...kargs, "apply", "-f", "-"], manifest, kopts);

  if (wait) {
    console.log("Waiting for rollout to complete ...");
    await run(kubectl, [
      ...kargs,
      "rollout",
      "status",
      `deployment/${cfg.project}`,
      "-n",
      cfg.k8s.namespace,
      "--timeout=300s",
    ], kopts);
  }
  console.log(`Deployed ${cfg.project} in ${cfg.k8s.namespace}`);

  // Node IP for the NodePort hints below and the SSH alias.
  let nodeIp;
  try {
    nodeIp = exec(kubectl, [
      ...kargs,
      "get",
      "nodes",
      "-o",
      "jsonpath={.items[0].status.addresses[?(@.type==\"InternalIP\")].address}",
    ], kopts);
  } catch {
    /* handled below */
  }

  const web = webPorts(cfg);
  if (web.length) {
    console.log("Web (Traefik Ingress):");
    for (const p of web) {
      console.log(`  http://${p.host}/  (container port ${p.port})`);
    }
    const webNodePorts = web.filter((p) => p.nodePort !== undefined);
    if (webNodePorts.length) {
      console.log("Web NodePorts (reachable on any cluster node):");
      for (const p of webNodePorts) {
        console.log(`  http://${nodeIp ?? "<node-ip>"}:${p.nodePort}/  (container port ${p.port})`);
      }
    }
  }

  const sidecarNodePorts = sidecarNodePortsList(cfg);
  if (sidecarNodePorts.length) {
    console.log("Sidecar NodePorts (reachable on any cluster node):");
    for (const p of sidecarNodePorts) {
      console.log(`  ${p.name}: ${nodeIp ?? "<node-ip>"}:${p.nodePort}  (container port ${p.port})`);
    }
  }

  // Register an SSH alias for the container (VS Code Remote-SSH / ssh).
  // Host keys are ephemeral, so the alias points at the OS null device and
  // any legacy per-project known_hosts file is removed.
  if (nodeIp) {
    try {
      const alias = sshAlias(cfg.project);
      addHostEntry({
        alias,
        hostName: nodeIp,
        port: cfg.k8s.nodePort,
        user: cfg.ssh.user,
        identityFile: path.join(cfg.ssh.keyDirPath, cfg.ssh.keyName),
        knownHostsFile: ephemeralKnownHostsFile(),
      });
      if (removeLegacyKnownHostsFile(cfg.ssh.keyDirPath, cfg.project)) {
        console.log(`Removed stale known_hosts for "${cfg.project}"`);
      }
      console.log(`SSH alias "${alias}" written to ${sshConfigPath()} (connect: ssh ${alias})`);
    } catch (err) {
      console.warn(`Warning: could not update SSH config: ${err.message}`);
    }
  } else {
    console.warn("Warning: could not resolve a node IP; skipped the SSH alias in ~/.ssh/config");
  }
}
