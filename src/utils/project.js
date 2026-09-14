import fs from "node:fs";
import path from "node:path";
import { exec } from "./exec.js";
import { kubectlExec } from "./system-config.js";
import { DEFAULTS } from "../config.js";

const NODEPORT_MIN = 30000;
const NODEPORT_MAX = 32767;

/**
 * Derive a valid k8s project name (DNS-1123 label) from a folder name.
 */
export function deriveProjectName(dir) {
  let name = path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) name = "project";
  if (name.length > 63) name = name.slice(0, 63).replace(/-+$/g, "");
  return name;
}

function usedNodePorts() {
  const out = exec("kubectl", [
    "get",
    "svc",
    "-A",
    "-o",
    "jsonpath={range .items[*]}{.spec.ports[*].nodePort}{' '}{end}",
  ]);
  return new Set(
    out
      .split(/\s+/)
      .filter((t) => /^\d+$/.test(t))
      .map(Number)
  );
}

/**
 * The service that holds a NodePort, or null when the port is free.
 * Scans every namespace: NodePorts are allocated cluster-wide.
 */
export function findNodePortOwner(port) {
  const { cmd, args, opts } = kubectlExec();
  // -o json (no jsonpath) keeps the argument free of quotes a shell could eat.
  const out = exec(cmd, [...args, "get", "svc", "-A", "-o", "json"], opts);
  const { items = [] } = JSON.parse(out);
  for (const svc of items) {
    const nodePorts = (svc.spec?.ports || []).map((p) => p.nodePort).filter(Boolean);
    if (nodePorts.includes(port)) {
      return { namespace: svc.metadata.namespace, name: svc.metadata.name };
    }
  }
  return null;
}

/**
 * First free NodePort starting at startPort. If the cluster is unreachable,
 * falls back to startPort (the deploy step will surface the real error).
 */
export function allocateNodePort(startPort = DEFAULTS.k8s.nodePort) {
  let used;
  try {
    used = usedNodePorts();
  } catch {
    return startPort;
  }
  for (let port = Math.max(startPort, NODEPORT_MIN); port <= NODEPORT_MAX; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`No free NodePort in ${NODEPORT_MIN}-${NODEPORT_MAX}`);
}

/**
 * Create a minimal config.yaml in dir (project name from the folder or an
 * explicit override, first free NodePort) unless one already exists.
 * Returns { configPath, created, project, nodePort }.
 */
export function ensureProjectConfig(dir, explicitProject) {
  const configPath = path.join(dir, "config.yaml");
  if (fs.existsSync(configPath)) {
    return { configPath, created: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  const project = explicitProject || deriveProjectName(dir);
  const nodePort = allocateNodePort();
  fs.writeFileSync(
    configPath,
    `# coding-container project config (auto-created by 'coding-container create')
# Shared settings come from the global config at ~/.config/coding-container/config.yaml.
project: ${project}

k8s:
  nodePort: ${nodePort}

# Expose container ports to the browser through Traefik (one Ingress rule
# per host). DNS for the hosts must resolve to your Traefik LoadBalancer.
# web:
#   ports:
#     - { port: 3000, hosts: [my-web.example.com, www.example.com] }
`
  );
  return { configPath, created: true, project, nodePort };
}
