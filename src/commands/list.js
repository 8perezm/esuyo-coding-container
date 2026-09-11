import {
  addHostEntry,
  ephemeralKnownHostsFile,
  listHostEntries,
  sshConfigPath,
} from "../utils/ssh-config.js";
import { exec } from "../utils/exec.js";
import { kubectlExec } from "../utils/system-config.js";

/**
 * Ordering for the `list` table: by host, then port, then alias.
 * IPv4 hosts compare octet-by-octet so 10.0.0.7 sorts before 10.0.0.19;
 * anything else falls back to a string comparison. Missing values sort last.
 */
function compareIpv4(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function compareHost(a, b) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (IPV4.test(a) && IPV4.test(b)) {
    const diff = compareIpv4(a, b);
    if (diff !== 0) return diff;
  } else {
    const diff = a.localeCompare(b);
    if (diff !== 0) return diff;
  }
  return 0;
}

function comparePort(a, b) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isInteger(na) && Number.isInteger(nb) && na !== nb) return na - nb;
  if (a !== b) return String(a).localeCompare(String(b));
  return 0;
}

function compareByHostPort(a, b) {
  return compareHost(a.hostName, b.hostName) || comparePort(a.port, b.port) || a.alias.localeCompare(b.alias);
}

/**
 * List the SSH connections the CLI manages (the `coding-<project>` aliases
 * `deploy`/`create` write to ~/.ssh/config), ordered by host then port.
 * Read-only: never touches the cluster, the config.yaml layers, or the SSH
 * config file itself.
 */
export function listSsh({ file } = {}) {
  const sshConfig = file ?? sshConfigPath();
  const entries = listHostEntries(sshConfig).sort(compareByHostPort);
  if (entries.length === 0) {
    console.log(`No coding-container SSH connections found in ${sshConfig}.`);
    console.log("Deploy a project to register one: coding-container create");
    return;
  }
  const rows = entries.map((e) => ({
    alias: e.alias,
    host: e.hostName ?? "-",
    port: e.port ?? "-",
    user: e.user ?? "-",
    identityFile: e.identityFile ?? "-",
  }));
  const widths = {
    alias: Math.max("ALIAS".length, ...rows.map((r) => r.alias.length)),
    host: Math.max("HOST".length, ...rows.map((r) => r.host.length)),
    port: Math.max("PORT".length, ...rows.map((r) => r.port.length)),
    user: Math.max("USER".length, ...rows.map((r) => r.user.length)),
  };
  const pad = (s, w) => s.padEnd(w, " ");
  console.log(
    `${pad("ALIAS", widths.alias)}  ${pad("HOST", widths.host)}  ${pad("PORT", widths.port)}  ${pad("USER", widths.user)}  IDENTITYFILE`
  );
  for (const r of rows) {
    console.log(
      `${pad(r.alias, widths.alias)}  ${pad(r.host, widths.host)}  ${pad(r.port, widths.port)}  ${pad(r.user, widths.user)}  ${r.identityFile}`
    );
  }
  console.log(`\n${entries.length} connection(s) from ${sshConfig} (connect: ssh <alias>)`);
}

/**
 * Pick the IP of a healthy cluster node. A NodePort service is reachable
 * through *any* node, so when the cluster grows (or a node is replaced and
 * its IP changes) the stored HostName just needs to point at a node that is
 * currently Ready — it does not need to be the node the pod runs on.
 */
function getReadyNodeIp() {
  const { cmd, args, opts } = kubectlExec();
  let out;
  try {
    out = exec(cmd, [...args, "get", "nodes", "-o", "json"], opts);
  } catch (err) {
    throw new Error(`cannot list cluster nodes:\n${err.message}`);
  }
  let nodes;
  try {
    nodes = JSON.parse(out);
  } catch (err) {
    throw new Error(`cannot parse 'kubectl get nodes' output: ${err.message}`);
  }
  const items = nodes.items ?? [];
  const addressOf = (node) => {
    const addrs = node.status?.addresses ?? [];
    return (
      addrs.find((a) => a.type === "InternalIP")?.address ??
      addrs.find((a) => a.type === "ExternalIP")?.address
    );
  };
  const ready = items.filter((n) =>
    (n.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True")
  );
  // No Ready conditions at all (e.g. a stubbed/apiserver-less response):
  // fall back to any node that has an address.
  const candidates = ready.length ? ready : items;
  for (const node of candidates) {
    const ip = addressOf(node);
    if (ip) return ip;
  }
  throw new Error("no cluster node with an InternalIP/ExternalIP address found");
}

/**
 * All services in the cluster, indexed by service name. An alias
 * `coding-<project>` maps to the service `<project>` (in whatever namespace
 * the project was deployed to), so the index is searched across namespaces.
 */
function indexServicesByName() {
  const { cmd, args, opts } = kubectlExec();
  let out;
  try {
    out = exec(cmd, [...args, "get", "svc", "-A", "-o", "json"], opts);
  } catch (err) {
    throw new Error(`cannot list cluster services:\n${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`cannot parse 'kubectl get svc' output: ${err.message}`);
  }
  const byName = new Map();
  for (const svc of parsed.items ?? []) {
    const name = svc.metadata?.name;
    if (!name) continue;
    const sshPort = (svc.spec?.ports ?? []).find((p) => p.name === "ssh");
    const record = {
      namespace: svc.metadata?.namespace ?? "",
      nodePort: sshPort?.nodePort,
    };
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(record);
  }
  return byName;
}

/**
 * Re-point every managed SSH alias at a currently-Ready node and resync its
 * Port from the live Service's ssh nodePort.
 *
 * Why this exists: `deploy` captures one node's IP at deploy time. On a
 * single-node cluster that never changes, but once the cluster grows (or a
 * node is replaced) the stored IP can go stale — the pod moving nodes is
 * harmless by itself (NodePort is reachable via any node), a dead/stale node
 * IP is what breaks `ssh coding-<project>` and VS Code Remote-SSH. Refresh
 *ing the aliases fixes that without redeploying.
 *
 * Stale entries (no matching service — e.g. after `delete` on another
 * machine) and ambiguous ones (same service name in several namespaces) are
 * left untouched with a warning. Nothing outside the managed block is modified.
 */
export function listUpdateSsh({ file, dryRun = false } = {}) {
  const sshConfig = file ?? sshConfigPath();
  const entries = listHostEntries(sshConfig);
  if (entries.length === 0) {
    console.log(`No coding-container SSH connections found in ${sshConfig}.`);
    console.log("Deploy a project to register one: coding-container create");
    return;
  }
  const nodeIp = getReadyNodeIp();
  const services = indexServicesByName();
  let updated = 0;
  let current = 0;
  for (const entry of entries) {
    const project = entry.alias.replace(/^coding-/, "");
    const matches = services.get(project) ?? [];
    if (matches.length === 0) {
      console.warn(
        `warning: no service "${project}" found in any namespace — leaving "${entry.alias}" untouched (stale entry? run 'coding-container delete' to remove it)`
      );
      continue;
    }
    if (matches.length > 1) {
      const where = matches.map((m) => `"${m.namespace}"`).join(", ");
      console.warn(
        `warning: service "${project}" exists in several namespaces (${where}) — leaving "${entry.alias}" untouched (edit ~/.ssh/config manually)`
      );
      continue;
    }
    const [{ namespace, nodePort }] = matches;
    const wantPort = nodePort !== undefined && nodePort !== null ? String(nodePort) : entry.port;
    if (!entry.identityFile) {
      console.warn(`warning: "${entry.alias}" has no IdentityFile — leaving it untouched`);
      continue;
    }
    if (entry.hostName === nodeIp && entry.port === wantPort) {
      console.log(`"${entry.alias}": already current (${nodeIp}:${entry.port}, service "${project}" in "${namespace}")`);
      current++;
      continue;
    }
    const what =
      entry.hostName !== nodeIp && entry.port !== wantPort
        ? `host ${entry.hostName ?? "-"} -> ${nodeIp}, port ${entry.port ?? "-"} -> ${wantPort}`
        : entry.hostName !== nodeIp
          ? `host ${entry.hostName ?? "-"} -> ${nodeIp}`
          : `port ${entry.port ?? "-"} -> ${wantPort}`;
    if (dryRun) {
      console.log(`"${entry.alias}": would update ${what} (service "${project}" in "${namespace}")`);
      continue;
    }
    addHostEntry(
      {
        alias: entry.alias,
        hostName: nodeIp,
        port: wantPort,
        user: entry.user ?? "root",
        identityFile: entry.identityFile,
        knownHostsFile: entry.knownHostsFile ?? ephemeralKnownHostsFile(),
      },
      sshConfig
    );
    console.log(`"${entry.alias}": updated ${what} (service "${project}" in "${namespace}")`);
    updated++;
  }
  if (dryRun) {
    console.log(`\nDry run: no changes written to ${sshConfig}.`);
  } else {
    console.log(`\n${updated} updated, ${current} already current (${entries.length} total) in ${sshConfig}.`);
  }
}
