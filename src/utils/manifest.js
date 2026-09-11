import crypto from "node:crypto";
import yaml from "js-yaml";
import { imageRef } from "../config.js";

function nfsBasePath(cfg) {
  return cfg.nfs.basePath.replace(/\/+$/, "");
}

/**
 * NAS subfolder under basePath that backs /workspace: nfs.subPath when set,
 * else the project name.
 */
export function workspaceSubPath(cfg) {
  return cfg.nfs.subPath || cfg.project;
}

export function configMapManifest(cfg, publicKey) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `${cfg.project}-ssh`,
      namespace: cfg.k8s.namespace,
      labels: { app: cfg.project, "coding-container": "true" },
    },
    data: {
      authorized_keys: publicKey,
    },
  };
}

/**
 * Secret-backed env (k8s.secretEnv) lives in a managed `<project>-env`
 * Secret. Normalized entries (sorted by name for a stable hash/render).
 */
export function secretEnvName(cfg) {
  return `${cfg.project}-env`;
}

export function secretEnvEntries(cfg) {
  return Object.entries(cfg.k8s?.secretEnv ?? {})
    .filter(([, value]) => value != null)
    .map(([name, value]) => [name, String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Short content hash of the secret data. Stamped onto the pod template so a
 * rotated value changes the Deployment spec and rolls the pods on the next
 * deploy (a Secret edit alone would not restart anything).
 */
export function secretsHash(cfg) {
  const entries = secretEnvEntries(cfg);
  if (!entries.length) return null;
  return crypto
    .createHash("sha256")
    .update(entries.map(([name, value]) => `${name}=${value}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function secretManifest(cfg, { redact = false } = {}) {
  const entries = secretEnvEntries(cfg);
  if (!entries.length) return null;
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretEnvName(cfg),
      namespace: cfg.k8s.namespace,
      labels: { app: cfg.project, "coding-container": "true" },
    },
    type: "Opaque",
    stringData: Object.fromEntries(
      entries.map(([name, value]) => [name, redact ? "***REDACTED***" : value])
    ),
  };
}

/**
 * Normalized web.ports entries: {name, port, host, nodePort?}. Names default
 * to web-<port>; nodePort (30000-32767) is an optional service-level knob
 * that also exposes the port on every cluster node.
 */
export function webPorts(cfg) {
  return (cfg.web?.ports || []).map((entry) => ({
    name: entry.name || `web-${entry.port}`,
    port: entry.port,
    host: entry.host,
    ...(entry.nodePort !== undefined ? { nodePort: entry.nodePort } : {}),
  }));
}

/**
 * nfs.volumes entries as volumeMounts on the shared `workspace` NFS volume.
 * Each entry mounts a subfolder of nfs.basePath (subPath) at its own
 * absolute container path; readOnly defaults to false.
 */
export function extraVolumeMounts(cfg) {
  return (cfg.nfs?.volumes || []).map((entry) => ({
    name: "workspace",
    mountPath: entry.mountPath,
    subPath: entry.subPath,
    ...(entry.readOnly ? { readOnly: true } : {}),
  }));
}

/**
 * k8s.sidecars entries as container specs. Near pass-through: every field
 * (ports, command, args, volumeMounts, resources, probes, ...) is copied
 * verbatim; 'env' additionally accepts a plain map (converted to a k8s env
 * list) to match the k8s.env convention.
 */
export function sidecarContainers(cfg) {
  return (cfg.k8s.sidecars || []).map((entry) => {
    const container = structuredClone(entry);
    if (container.env !== undefined && !Array.isArray(container.env)) {
      container.env = Object.entries(container.env).map(([name, value]) => ({
        name,
        value: String(value),
      }));
    }
    // A port's optional 'nodePort' is a service-level knob: strip it so the
    // rendered ContainerPort stays a clean k8s spec.
    if (container.ports) {
      for (const port of container.ports) delete port.nodePort;
    }
    return container;
  });
}

/**
 * Sidecar ports exposed on the cluster nodes: k8s.sidecars port entries with
 * a 'nodePort' set. Each renders a service port shaped like the ssh one
 * (port/targetPort = container port, nodePort = the configured NodePort).
 */
export function sidecarNodePorts(cfg) {
  return (cfg.k8s.sidecars || []).flatMap((entry) =>
    (entry.ports || [])
      .filter((port) => port.nodePort !== undefined)
      .map((port) => ({
        name: port.name || `nodeport-${port.containerPort}`,
        port: port.containerPort,
        targetPort: port.containerPort,
        protocol: port.protocol || "TCP",
        nodePort: port.nodePort,
      }))
  );
}

export function deploymentManifest(cfg, pullSecret = null) {
  const resources = cfg.k8s.resources || {};
  const container = {
    name: "coding",
    image: imageRef(cfg),
    // Always re-check the registry on pod start: with an unpinned (latest)
    // tag, IfNotPresent makes nodes silently serve a stale cached image.
    imagePullPolicy: "Always",
    ports: [
      { name: "ssh", containerPort: cfg.ssh.port, protocol: "TCP" },
      ...webPorts(cfg).map((p) => ({ name: p.name, containerPort: p.port, protocol: "TCP" })),
    ],
    volumeMounts: [
      {
        name: "workspace",
        mountPath: cfg.container.workdir,
        subPath: workspaceSubPath(cfg),
      },
      {
        name: "ssh-keys",
        mountPath: "/root/.ssh/authorized_keys",
        subPath: "authorized_keys",
      },
      ...extraVolumeMounts(cfg),
    ],
  };
  if (cfg.k8s.env && Object.keys(cfg.k8s.env).length) {
    container.env = Object.entries(cfg.k8s.env)
      .filter(([, value]) => value != null)
      .map(([name, value]) => ({
        name,
        value: String(value),
      }));
  }
  // Secret-backed env renders after plain env, so on a user-created name
  // collision the secret reference wins (collision is the user's problem:
  // don't use the same NAME in both).
  const secretEntries = secretEnvEntries(cfg);
  if (secretEntries.length) {
    container.env = [
      ...(container.env ?? []),
      ...secretEntries.map(([name]) => ({
        name,
        valueFrom: { secretKeyRef: { name: secretEnvName(cfg), key: name } },
      })),
    ];
  }
  if (Object.keys(resources).length) container.resources = resources;

  const hash = secretsHash(cfg);

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: cfg.project,
      namespace: cfg.k8s.namespace,
      labels: { app: cfg.project, "coding-container": "true" },
    },
    spec: {
      replicas: cfg.k8s.replicas,
      selector: { matchLabels: { app: cfg.project } },
      template: {
        metadata: {
          labels: { app: cfg.project, "coding-container": "true" },
          ...(hash ? { annotations: { "coding-container-secrets-hash": hash } } : {}),
        },
        spec: {
          ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
          containers: [container, ...sidecarContainers(cfg)],
          volumes: [
            {
              name: "workspace",
              nfs: { server: cfg.nfs.server, path: nfsBasePath(cfg) },
            },
            {
              name: "ssh-keys",
              configMap: { name: `${cfg.project}-ssh` },
            },
          ],
        },
      },
    },
  };
}

export function serviceManifest(cfg) {
  const ports = [
    {
      name: "ssh",
      port: cfg.ssh.port,
      targetPort: cfg.ssh.port,
      protocol: "TCP",
      ...(cfg.k8s.serviceType === "NodePort" ? { nodePort: cfg.k8s.nodePort } : {}),
    },
    // Web ports are cluster ports for the Ingress (Traefik); an entry with a
    // nodePort is additionally reachable on every cluster node.
    ...webPorts(cfg).map((p) => ({
      name: p.name,
      port: p.port,
      targetPort: p.port,
      protocol: "TCP",
      ...(p.nodePort !== undefined ? { nodePort: p.nodePort } : {}),
    })),
    // Sidecar ports marked with a nodePort (databases and other TCP services
    // that Traefik's HTTP Ingress can't route) become NodePorts like ssh.
    ...sidecarNodePorts(cfg),
  ];
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: cfg.project,
      namespace: cfg.k8s.namespace,
      labels: { app: cfg.project, "coding-container": "true" },
    },
    spec: {
      type: cfg.k8s.serviceType,
      selector: { app: cfg.project },
      ports,
    },
  };
}

/**
 * Ingress with one rule per web port: the entry's host routes to that
 * container port on the project's service. Only rendered when web.ports is
 * non-empty.
 */
export function ingressManifest(cfg) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: cfg.project,
      namespace: cfg.k8s.namespace,
      labels: { app: cfg.project, "coding-container": "true" },
    },
    spec: {
      ingressClassName: cfg.ingress.className,
      rules: webPorts(cfg).map((p) => ({
        host: p.host,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: { service: { name: cfg.project, port: { number: p.port } } },
            },
          ],
        },
      })),
    },
  };
}

/**
 * Full multi-document manifest as a string, ready for `kubectl apply -f -`.
 * The managed env Secret is rendered between the ssh ConfigMap and the
 * Deployment (absent when k8s.secretEnv is empty). With redactSecrets the
 * Secret's values print as ***REDACTED*** (for `validate --manifest`, which
 * must never leak secrets to terminal/logs); deploy always uses real values.
 */
export function fullManifest(cfg, publicKey, pullSecret = null, opts = {}) {
  const secret = secretManifest(cfg, { redact: Boolean(opts.redactSecrets) });
  const docs = [
    configMapManifest(cfg, publicKey),
    ...(secret ? [secret] : []),
    deploymentManifest(cfg, pullSecret),
    serviceManifest(cfg),
  ];
  if (webPorts(cfg).length) docs.push(ingressManifest(cfg));
  return docs
    .map((doc) => yaml.dump(doc, { lineWidth: -1, noRefs: true }))
    .join("---\n");
}
