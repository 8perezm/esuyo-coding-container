import net from "node:net";
import path from "node:path";
import { exec, run, start } from "../utils/exec.js";
import { ensureKeyPair } from "../utils/keys.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForReady(child, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.ready) return true;
    await sleep(200);
  }
  return child.ready;
}

/**
 * Per-project known_hosts file so ephemeral pod host keys (regenerated on
 * every image build) never pollute the user's global known_hosts, and a
 * changed key never blocks the connection.
 */
function sshCommonOptions(cfg, port, privateKey) {
  return [
    "-i",
    privateKey,
    "-p",
    String(port),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${path.join(cfg.ssh.keyDirPath, `${cfg.project}-known_hosts`)}`,
  ];
}

async function sshDirect(cfg, privateKey) {
  const nodeIp = exec("kubectl", [
    "get",
    "nodes",
    "-o",
    "jsonpath={.items[0].status.addresses[?(@.type==\"InternalIP\")].address}",
  ]);
  await run("ssh", [...sshCommonOptions(cfg, cfg.k8s.nodePort, privateKey), `${cfg.ssh.user}@${nodeIp}`]);
}

export async function ssh(cfg, { direct = false } = {}) {
  const { private: privateKey } = ensureKeyPair(cfg.ssh.keyDirPath, cfg.ssh.keyName);

  if (direct) {
    await sshDirect(cfg, privateKey);
    return;
  }

  let localPort = cfg.container.localPort;
  if (!(await portAvailable(localPort))) {
    localPort = await findFreePort();
    console.log(`Local port ${cfg.container.localPort} is in use, using ${localPort} instead`);
  }
  const pf = start("kubectl", [
    "-n",
    cfg.k8s.namespace,
    "port-forward",
    `svc/${cfg.project}`,
    `${localPort}:${cfg.ssh.port}`,
  ]);
  pf.stdout.on("data", (d) => {
    if (String(d).includes("Forwarding from")) pf.ready = true;
  });
  pf.stderr.on("data", (d) => process.stderr.write(d));

  if (!(await waitForReady(pf))) {
    pf.kill();
    throw new Error(`port-forward to svc/${cfg.project} did not start in time`);
  }

  let failed = false;
  try {
    await run("ssh", [...sshCommonOptions(cfg, localPort, privateKey), `${cfg.ssh.user}@127.0.0.1`]);
  } catch {
    failed = true;
  } finally {
    pf.kill();
  }
  if (failed) process.exitCode = 255;
}
