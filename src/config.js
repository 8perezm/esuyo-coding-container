import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { expandEnvMap } from "./utils/envsubst.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Global config directory: $XDG_CONFIG_HOME/esuyo-coding-container or ~/.config/esuyo-coding-container.
 * Holds the shared settings (config.yaml) and, by default, the SSH key
 * material (keys/).
 */
export function globalConfigDir() {
  const base = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(base, "esuyo-coding-container");
}

export function globalConfigPath() {
  return path.join(globalConfigDir(), "config.yaml");
}

// Read-only reference; loadConfig() clones it before merging.
export const DEFAULTS = {
  project: "my-project",
  image: {
    // registry is intentionally unset: it is environment-specific and is
    // captured by `coding-container setup` (or set in the global config).
    registry: "",
    name: "coding-container",
    // tag is intentionally unset: in global mode, deploys float on the
    // cluster's coding-system ConfigMap (`coding-container system get`);
    // set image.tag to pin this project to one global version. In custom
    // mode (own dockerfile/buildArgs/name) image.tag is required.
    dockerfile: "Dockerfile",
    context: ".",
    buildArgs: {
      BASE_IMAGE: "ubuntu:24.04",
      NODE_VERSION: "22",
      EXTRA_APT_PACKAGES: "",
      EXTRA_NPM_PACKAGES: "",
    },
  },
  k8s: {
    namespace: "coding",
    replicas: 1,
    serviceType: "NodePort",
    nodePort: 30022,
    imagePullSecret: "",
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "2", memory: "8Gi" },
    },
    env: {},
    // Secret-backed env for the coding container (e.g. provider API keys).
    // Rendered into a managed `<project>-env` Secret and referenced via
    // valueFrom.secretKeyRef, so `kubectl get deploy` never shows values.
    // Values may use `${LOCAL_VAR}` (expanded from your shell at deploy
    // time); a missing variable fails fast. Same `${}` expansion applies to
    // k8s.env (which stays plaintext in the Deployment).
    //   secretEnv:
    //     OPENAI_API_KEY: ${OPENAI_API_KEY}
    secretEnv: {},
    // Extra containers in the pod (e.g. a Postgres database or a message
    // queue for the app in the coding container). Each entry is a near-raw
    // k8s container spec: 'name' and 'image' are required, 'env' may be a
    // map or a k8s env list, everything else (ports, command, volumeMounts,
    // resources, probes, ...) passes through unchanged. One knob is consumed
    // by the service instead of the container: a port entry's optional
    // 'nodePort' (30000-32767, unique across ssh, web.ports, and sidecars)
    // exposes that port on every cluster node (handy for TCP services an
    // HTTP Ingress can't route) and is stripped from the rendered
    // ContainerPort.
    sidecars: [],
  },
  nfs: {
    // server / basePath are intentionally unset: they are environment-specific
    // and are captured by `coding-container setup` (or set in the global config).
    server: "",
    basePath: "",
    // Subfolder under basePath that backs /workspace. Unset -> the project
    // name. Set it to pin a specific folder (e.g. reuse an existing one).
    subPath: "",
    // Extra NAS folders mounted into the container alongside /workspace.
    // Each entry reuses nfs.server/nfs.basePath: 'subPath' is a folder under
    // basePath (created on first mount if missing), 'mountPath' is an absolute
    // path in the container, and 'readOnly' (default false) blocks container
    // writes. All mounts reuse the single workspace NFS volume.
    //   volumes:
    //     - { subPath: shared-datasets, mountPath: /data, readOnly: true }
    volumes: [],
  },
  ssh: {
    user: "root",
    port: 22,
    keyName: "id_ed25519",
  },
  web: {
    // Container ports to expose to the browser (dev servers, etc.). Each
    // entry becomes a Traefik Ingress rule: its host routes to that container
    // port on the project's service. DNS resolution of the hosts is up to you.
    // An optional 'nodePort' (30000-32767, unique across ssh, web.ports, and
    // sidecars) additionally exposes the port on every cluster node, for
    // clients that can't use the Ingress hosts.
    //   web:
    //     ports:
    //       - { port: 3000, host: my-web.example.com, nodePort: 30080 }
    //       - { port: 8080, host: my-api.example.com, name: api }
    ports: [],
  },
  ingress: {
    // Ingress class that routes the web.ports rules (k3s ships Traefik).
    className: "traefik",
  },
  container: {
    workdir: "/workspace",
    localPort: 2222,
  },
};

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Resolve the relative path fields of one config layer (image.dockerfile,
 * image.context, ssh.keyDir) against the directory that layer's file lives
 * in. Built-in defaults resolve against the local config's directory so a
 * project without a global config behaves exactly as before.
 */
function withPaths(layer, baseDir) {
  const out = structuredClone(layer);
  if (out.image) {
    if (out.image.dockerfile) {
      out.image.dockerfilePath = path.resolve(baseDir, out.image.dockerfile);
    }
    if (out.image.context) {
      out.image.contextPath = path.resolve(baseDir, out.image.context);
    }
  }
  if (out.ssh && out.ssh.keyDir) {
    out.ssh.keyDirPath = path.resolve(baseDir, out.ssh.keyDir);
  }
  return out;
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8")) || {};
}

/**
 * Which project config to use: an explicit -c value wins, then a config.yaml
 * in the current working directory, then the repo's own config.yaml.
 */
export function resolveDefaultConfigPath(explicit) {
  if (explicit) return explicit;
  const cwdConfig = path.resolve(process.cwd(), "config.yaml");
  return fs.existsSync(cwdConfig) ? cwdConfig : path.join(PROJECT_ROOT, "config.yaml");
}

/**
 * Load and validate configuration.
 *
 * Layers, lowest to highest priority:
 *   1. hardcoded DEFAULTS
  *   2. global config  (~/.config/esuyo-coding-container/config.yaml, if present)
 *   3. local project config (configPath)
 *   4. CLI overrides (e.g. -p/--project, --tag)
 *
 * The cluster is a layer too, but it is read by the deploy/system commands,
 * not here: in global mode the image tag floats on the coding-system
 * ConfigMap in the cluster (see src/utils/system-config.js). loadConfig
 * stays offline and pure; it only computes which mode the project is in:
 *   cfg.imageMode = "custom" when the project layer sets image.dockerfile,
 *   image.buildArgs or image.name (the project ships its own image at
 *   registry/coding-<project>), else "global" (the shared team image).
 *
 * @param {string} configPath path to the local project yaml file
 * @param {object} overrides flat-ish overrides applied on top (e.g. from CLI flags)
 */
export function loadConfig(configPath, overrides = {}) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const localDir = path.dirname(resolved);
  const gDir = globalConfigDir();

  let cfg = withPaths(DEFAULTS, localDir);
  if (fs.existsSync(globalConfigPath())) {
    cfg = deepMerge(cfg, withPaths(readYaml(globalConfigPath()), gDir));
  }
  const local = readYaml(resolved);
  cfg = deepMerge(cfg, withPaths(local, localDir));
  cfg = deepMerge(cfg, overrides);

  const localImage = (local && local.image) || {};
  cfg.imageMode =
    localImage.dockerfile || localImage.buildArgs || localImage.name ? "custom" : "global";
  // Custom projects never touch the global repo: default their image name
  // to coding-<project> unless they set image.name themselves.
  if (cfg.imageMode === "custom" && !localImage.name) {
    cfg.image.name = `coding-${cfg.project}`;
  }

  // Default key location: keys/ inside the global config dir (shared key
  // pair for all projects; per-project known_hosts files live alongside).
  if (!cfg.ssh.keyDirPath) cfg.ssh.keyDirPath = path.join(gDir, "keys");
  // `${VAR}` expansion (local shell -> config) is scoped to env-ish fields
  // only, so hosts/paths/ports can never surprise-expand. Missing variables
  // fail fast here, before validate().
  if (cfg.k8s.env != null) cfg.k8s.env = expandEnvMap(cfg.k8s.env, "k8s.env");
  if (cfg.k8s.secretEnv != null) cfg.k8s.secretEnv = expandEnvMap(cfg.k8s.secretEnv, "k8s.secretEnv");
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  if (!cfg.project) throw new Error("config: 'project' is required");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(cfg.project)) {
    throw new Error(
      `config: 'project' must be a valid k8s name (lowercase alphanum and '-'): ${cfg.project}`
    );
  }
  if (!cfg.image.registry) {
    throw new Error(
      "config: image.registry is not set. Run 'coding-container setup' " +
        "(or set image.registry in your global config) to point at your registry."
    );
  }
  if (!cfg.image.name) {
    throw new Error("config: image.name is required");
  }
  if (!fs.existsSync(cfg.image.dockerfilePath)) {
    throw new Error(`config: dockerfile not found: ${cfg.image.dockerfilePath}`);
  }
  if (!cfg.nfs.server) {
    throw new Error(
      "config: nfs.server is not set. Run 'coding-container setup' " +
        "(or set nfs.server in your global config) to point at your NAS."
    );
  }
  if (!cfg.nfs.basePath) {
    throw new Error(
      "config: nfs.basePath is not set. Run 'coding-container setup' " +
        "(or set nfs.basePath in your global config) to the shared folder that " +
        "holds the per-project workspaces."
    );
  }
  if (cfg.nfs.subPath !== undefined && cfg.nfs.subPath !== "") {
    if (
      typeof cfg.nfs.subPath !== "string" ||
      cfg.nfs.subPath.startsWith("/") ||
      cfg.nfs.subPath.split("/").some((seg) => seg === "" || seg === "..")
    ) {
      throw new Error(
        `config: nfs.subPath must be a relative folder name under nfs.basePath ` +
          `(no leading '/', no empty or '..' segments): ${cfg.nfs.subPath}`
      );
    }
  }
  if (cfg.nfs.volumes !== undefined) {
    if (!Array.isArray(cfg.nfs.volumes)) {
      throw new Error(
        "config: nfs.volumes must be a list of {subPath, mountPath, readOnly?} entries"
      );
    }
    const workdir = cfg.container.workdir;
    const sshKeyMount = "/root/.ssh/authorized_keys";
    const workspaceSub = cfg.nfs.subPath || cfg.project;
    const seenSubPaths = new Set();
    const seenMountPaths = new Set();
    for (const entry of cfg.nfs.volumes) {
      const label =
        entry && typeof entry === "object" && !Array.isArray(entry) && entry.subPath
          ? `nfs.volumes entry "${entry.subPath}"`
          : `nfs.volumes entry ${JSON.stringify(entry)}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`config: ${label} must be an object with 'subPath' and 'mountPath'`);
      }
      if (
        typeof entry.subPath !== "string" ||
        entry.subPath.startsWith("/") ||
        entry.subPath.split("/").some((seg) => seg === "" || seg === "..")
      ) {
        throw new Error(
          `config: ${label} 'subPath' must be a relative folder name under nfs.basePath ` +
            `(no leading '/', no empty or '..' segments): ${JSON.stringify(entry.subPath)}`
        );
      }
      if (entry.subPath === workspaceSub) {
        throw new Error(
          `config: ${label} 'subPath' collides with the /workspace folder ("${workspaceSub}")`
        );
      }
      if (seenSubPaths.has(entry.subPath)) {
        throw new Error(
          `config: nfs.volumes lists subPath "${entry.subPath}" more than once`
        );
      }
      seenSubPaths.add(entry.subPath);
      if (
        typeof entry.mountPath !== "string" ||
        !entry.mountPath.startsWith("/") ||
        entry.mountPath.split("/").slice(1).some((seg) => seg === "" || seg === "..")
      ) {
        throw new Error(
          `config: ${label} 'mountPath' must be an absolute container path ` +
            `(no trailing '/', no empty or '..' segments): ${JSON.stringify(entry.mountPath)}`
        );
      }
      if (entry.mountPath === workdir || entry.mountPath.startsWith(`${workdir}/`)) {
        throw new Error(
          `config: ${label} 'mountPath' may not be ${workdir} or nested under it ` +
            `(it would shadow the NFS-backed workspace): ${entry.mountPath}`
        );
      }
      if (entry.mountPath === sshKeyMount) {
        throw new Error(
          `config: ${label} 'mountPath' collides with the SSH authorized_keys mount: ${entry.mountPath}`
        );
      }
      if (seenMountPaths.has(entry.mountPath)) {
        throw new Error(
          `config: nfs.volumes lists mountPath "${entry.mountPath}" more than once`
        );
      }
      for (const other of seenMountPaths) {
        if (
          entry.mountPath.startsWith(`${other}/`) ||
          other.startsWith(`${entry.mountPath}/`)
        ) {
          throw new Error(
            `config: ${label} 'mountPath' "${entry.mountPath}" is nested with ` +
              `an existing nfs.volumes mount "${other}"`
          );
        }
      }
      seenMountPaths.add(entry.mountPath);
      if (entry.readOnly !== undefined && typeof entry.readOnly !== "boolean") {
        throw new Error(
          `config: ${label} 'readOnly' must be a boolean: ${JSON.stringify(entry.readOnly)}`
        );
      }
    }
  }
  const st = cfg.k8s.serviceType;
  if (st !== "NodePort" && st !== "LoadBalancer") {
    throw new Error("config: k8s.serviceType must be NodePort or LoadBalancer");
  }
  for (const field of ["env", "secretEnv"]) {
    const map = cfg.k8s[field];
    if (map == null) continue;
    if (typeof map !== "object" || Array.isArray(map)) {
      throw new Error(`config: k8s.${field} must be a map of NAME to value`);
    }
    for (const [name, value] of Object.entries(map)) {
      if (value != null && typeof value === "object") {
        throw new Error(
          `config: k8s.${field} '${name}' must be a scalar (string, number or boolean), ` +
            `got ${JSON.stringify(value)}`
        );
      }
    }
  }
  // Shared by web.ports and k8s.sidecars: nodePorts must be unique across both.
  const seenNodePorts = new Set();
  if (cfg.k8s.sidecars !== undefined) {
    if (!Array.isArray(cfg.k8s.sidecars)) {
      throw new Error(
        "config: k8s.sidecars must be a list of container entries (each with 'name' and 'image')"
      );
    }
    // Ports already declared by the coding container: a sidecar must not
    // redeclare them, or the service's numeric targetPort resolution breaks.
    const codingPorts = new Set(
      [cfg.ssh.port, ...(cfg.web?.ports || []).map((p) => p.port)].map(String)
    );
    const sidecarPorts = new Set();
    // Service port names already taken (ssh + web.ports): an exposed sidecar
    // port must not reuse one, or the service is invalid.
    const svcPortNames = new Set([
      "ssh",
      ...(cfg.web?.ports || []).map((p) => p.name || `web-${p.port}`),
    ]);
    const seenNames = new Set(["coding"]);
    for (const entry of cfg.k8s.sidecars) {
      const label =
        entry && typeof entry === "object" && entry.name
          ? `k8s.sidecars entry "${entry.name}"`
          : `k8s.sidecars entry ${JSON.stringify(entry)}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`config: ${label} must be an object with 'name' and 'image'`);
      }
      if (typeof entry.name !== "string" || !/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(entry.name) || entry.name.length > 63) {
        throw new Error(
          `config: ${label} needs a valid container name (lowercase a-z/0-9/-, max 63 chars): ${JSON.stringify(entry.name)}`
        );
      }
      if (seenNames.has(entry.name)) {
        throw new Error(`config: k8s.sidecars lists the container name "${entry.name}" more than once`);
      }
      seenNames.add(entry.name);
      if (typeof entry.image !== "string" || !entry.image) {
        throw new Error(`config: ${label} needs an 'image' (e.g. "postgres:16")`);
      }
      if (entry.ports !== undefined) {
        if (!Array.isArray(entry.ports)) {
          throw new Error(
            `config: ${label} 'ports' must be a list of {containerPort, name?, protocol?, nodePort?} entries`
          );
        }
        for (const port of entry.ports) {
          if (
            !port ||
            typeof port !== "object" ||
            !Number.isInteger(port.containerPort) ||
            port.containerPort < 1 ||
            port.containerPort > 65535
          ) {
            throw new Error(
              `config: ${label} port entry must have an integer 'containerPort' (1-65535): ${JSON.stringify(port)}`
            );
          }
          if (
            port.name !== undefined &&
            (!/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(port.name) || port.name.length > 15)
          ) {
            throw new Error(
              `config: ${label} port name must be a <=15-char IANA service name (lowercase a-z/0-9/-): ${JSON.stringify(port.name)}`
            );
          }
          if (port.protocol !== undefined && port.protocol !== "TCP" && port.protocol !== "UDP") {
            throw new Error(
              `config: ${label} port protocol must be TCP or UDP: ${JSON.stringify(port.protocol)}`
            );
          }
          const key = String(port.containerPort);
          if (codingPorts.has(key)) {
            throw new Error(
              `config: ${label} declares containerPort ${key}, which the coding container already uses (ssh or web.ports)`
            );
          }
          if (sidecarPorts.has(key)) {
            throw new Error(
              `config: k8s.sidecars lists containerPort ${key} more than once (one container per port keeps the service's port resolution unambiguous)`
            );
          }
          sidecarPorts.add(key);
          if (port.nodePort !== undefined) {
            if (
              !Number.isInteger(port.nodePort) ||
              port.nodePort < 30000 ||
              port.nodePort > 32767
            ) {
              throw new Error(
                `config: ${label} port nodePort must be an integer in 30000-32767: ${JSON.stringify(port.nodePort)}`
              );
            }
            if (port.nodePort === cfg.k8s.nodePort) {
              throw new Error(
                `config: ${label} port nodePort ${port.nodePort} collides with the SSH NodePort (k8s.nodePort)`
              );
            }
            if (seenNodePorts.has(port.nodePort)) {
              throw new Error(
                `config: k8s.sidecars lists nodePort ${port.nodePort} more than once`
              );
            }
            seenNodePorts.add(port.nodePort);
            const svcName = port.name || `nodeport-${port.containerPort}`;
            if (svcPortNames.has(svcName)) {
              throw new Error(
                `config: ${label} port name "${svcName}" is already used by a service port ` +
                  `(ssh, web.ports, or another exposed sidecar port); give the sidecar port a different 'name'`
              );
            }
            svcPortNames.add(svcName);
          }
        }
      }
    }
    if (cfg.k8s.replicas !== 1) {
      throw new Error(
        "config: k8s.replicas must be 1 when k8s.sidecars is set — replicas share the same NAS folder, so stateful sidecars (databases, queues) would conflict"
      );
    }
  }
  if (cfg.web?.ports !== undefined) {
    if (!Array.isArray(cfg.web.ports)) {
      throw new Error("config: web.ports must be a list of {port, host} entries");
    }
    const seenPorts = new Set();
    const seenHosts = new Set();
    for (const entry of cfg.web.ports) {
      const port = entry && entry.port;
      if (!entry || typeof entry !== "object" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
          `config: web.ports entry must be an object with a 'port' (1-65535) and a 'host': ${JSON.stringify(entry)}`
        );
      }
      if (seenPorts.has(port)) {
        throw new Error(`config: web.ports lists port ${port} more than once`);
      }
      seenPorts.add(port);
      if (
        typeof entry.host !== "string" ||
        !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(entry.host)
      ) {
        throw new Error(
          `config: web.ports entry for port ${port} has an invalid host (lowercase a-z/0-9/-/.): ${JSON.stringify(entry.host)}`
        );
      }
      if (seenHosts.has(entry.host)) {
        throw new Error(`config: web.ports entries share the host "${entry.host}"`);
      }
      seenHosts.add(entry.host);
      if (
        entry.name !== undefined &&
        (!/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(entry.name) || entry.name.length > 15)
      ) {
        throw new Error(
          `config: web port name must start with a letter, use a-z/0-9/- and be at most 15 chars: ${entry.name}`
        );
      }
      if (entry.nodePort !== undefined) {
        if (
          !Number.isInteger(entry.nodePort) ||
          entry.nodePort < 30000 ||
          entry.nodePort > 32767
        ) {
          throw new Error(
            `config: web.ports entry for port ${port} nodePort must be an integer in 30000-32767: ${JSON.stringify(entry.nodePort)}`
          );
        }
        if (entry.nodePort === cfg.k8s.nodePort) {
          throw new Error(
            `config: web.ports entry for port ${port} nodePort ${entry.nodePort} collides with the SSH NodePort (k8s.nodePort)`
          );
        }
        if (seenNodePorts.has(entry.nodePort)) {
          throw new Error(
            `config: web.ports entry for port ${port} nodePort ${entry.nodePort} collides with another web.ports or sidecar port nodePort`
          );
        }
        seenNodePorts.add(entry.nodePort);
      }
    }
  }
  if (cfg.ingress?.className !== undefined && typeof cfg.ingress.className !== "string") {
    throw new Error("config: ingress.className must be a string");
  }
}

/**
 * Full image reference. The tag is required (no "latest" fallback): it comes
 * from the project pin/--tag or, in global mode, from the coding-system
 * ConfigMap via resolveDeployTag().
 */
export function imageRef(cfg) {
  if (!cfg.image.tag) {
    throw new Error(
      "image tag is required: set image.tag (or --tag), or in global mode let " +
        "deploy float on the coding-system ConfigMap (see 'coding-container system get')"
    );
  }
  return `${cfg.image.registry}/${cfg.image.name}:${cfg.image.tag}`;
}
