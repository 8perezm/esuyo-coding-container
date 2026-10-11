import { exec } from "./exec.js";
import { kubectlExec } from "./system-config.js";

/**
 * Parse `kubectl get nodes -o json` into [{ name, internalIP, ready }].
 * Unknown/missing fields stay undefined/false (never throws on shape).
 */
export function parseNodesJson(jsonStr) {
  const { items = [] } = JSON.parse(jsonStr);
  return items.map((n) => {
    const addresses = n.status?.addresses || [];
    const internalIP = (addresses.find((a) => a.type === "InternalIP") || {}).address;
    const readyCond = (n.status?.conditions || []).find((c) => c.type === "Ready");
    return {
      name: n.metadata?.name,
      internalIP,
      ready: readyCond?.status === "True",
    };
  });
}

/**
 * Parse `kubectl get pods -o json` into [{ name, phase, hostIP, nodeName }].
 */
export function parsePodsJson(jsonStr) {
  const { items = [] } = JSON.parse(jsonStr);
  return items.map((p) => ({
    name: p.metadata?.name,
    phase: p.status?.phase,
    hostIP: p.status?.hostIP,
    nodeName: p.spec?.nodeName,
  }));
}

/**
 * Pick the SSH NodePort IP: the pod's own hostIP when that node is Ready,
 * else the first Ready node with an InternalIP. Returns null when no Ready
 * node exists (caller warns instead of writing a dead alias).
 */
export function pickNodeIp(nodes, podHostIP = null) {
  const ready = nodes.filter((n) => n.ready && n.internalIP);
  if (!ready.length) return null;
  if (podHostIP && ready.some((n) => n.internalIP === podHostIP)) return podHostIP;
  return ready[0].internalIP;
}

/**
 * Resolve where the project actually runs: ask the cluster for this
 * project's pods, then map the Running pod's hostIP onto the Ready nodes.
 * Falls back to the first Ready node when the pod list is empty/pending;
 * returns null when the cluster is unreachable or nothing is Ready (so
 * deploy can warn and skip the SSH alias instead of writing a dead IP).
 *
 * Uses `-o json` (not jsonpath) so Windows script stubs don't hit shell
 * quoting issues.
 */
export function resolveSshNodeIp(cfg) {
  const { cmd, args, opts } = kubectlExec();
  let podHostIP = null;
  try {
    const out = exec(cmd, [...args, "get", "pods", "-n", cfg.k8s.namespace, "-l", `app=${cfg.project}`, "-o", "json"], opts);
    const pods = parsePodsJson(out);
    const running = pods.find((p) => p.phase === "Running" && p.hostIP) || pods.find((p) => p.hostIP);
    podHostIP = running?.hostIP ?? null;
  } catch {
    /* pods unreadable -> Ready-node fallback below */
  }
  try {
    const out = exec(cmd, [...args, "get", "nodes", "-o", "json"], opts);
    return pickNodeIp(parseNodesJson(out), podHostIP);
  } catch {
    return null;
  }
}
