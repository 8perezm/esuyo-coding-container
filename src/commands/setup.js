import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { globalConfigDir, globalConfigPath, PROJECT_ROOT } from "../config.js";
import { ensureKeyPair } from "../utils/keys.js";

// Values that differ per environment. When neither a flag nor a prompt supplies
// one, the generated config gets a clearly-marked placeholder instead of a guess.
const PLACEHOLDERS = {
  registry: "your-registry.example.com/you",
  nfsServer: "your-nas-ip-or-hostname",
  nfsBasePath: "/path/to/shared/workspaces",
};

// Emit a YAML double-quoted scalar so special characters (":", "/", etc.) are safe.
function yamlValue(v) {
  return JSON.stringify(v);
}

function renderTemplate(dir, values) {
  return `# coding-container global configuration (created by 'coding-container setup')
#
# Shared by every project. Layering, lowest to highest priority:
#   built-in defaults -> THIS file -> the project's config.yaml -> CLI flags
#
# Relative paths in this file resolve against this file's directory.
# The Dockerfile and the SSH key pair live next to this file:
#   Dockerfile - the image build (copied here from the repo on first run)
#   keys/      - the shared SSH key pair (per-project known_hosts alongside)

image:
  registry: ${yamlValue(values.registry)}
  name: coding-container
  # tag: optional local fallback (e.g. for offline 'validate --manifest').
  # Normal deploys float on the cluster's coding-system ConfigMap:
  #   coding-container system init --tag v1.0.0   (once, on a fresh cluster)
  #   coding-container system get                 (show current/previous/maxEver)
  # Set tag in a project config to pin that project to one global version.
  # Single image build shared by all projects (Dockerfile copied next to this file).
  dockerfile: ${path.join(dir, "Dockerfile")}
  context: ${dir}
  buildArgs:
    BASE_IMAGE: ubuntu:26.04
    NODE_VERSION: "22"
    EXTRA_APT_PACKAGES: ""
    EXTRA_NPM_PACKAGES: ""

k8s:
  namespace: coding
  replicas: 1
  serviceType: NodePort
  nodePort: 30022   # default; override per project if several run at once
  imagePullSecret: ""
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: "2"
      memory: 8Gi
  env: {}
  # Secret-backed env (values hidden from kubectl get deploy output):
  # deployed as the managed <project>-env Secret and referenced via valueFrom.
  # \${VAR} is expanded from your local shell at deploy time (missing vars
  # fail fast); plain values stay in this file, so prefer \${} for real secrets.
  # secretEnv:
  #   OPENAI_API_KEY: \${OPENAI_API_KEY}

nfs:
  server: ${yamlValue(values.nfsServer)}
  basePath: ${yamlValue(values.nfsBasePath)}
  # Extra NAS folders mounted into the container alongside /workspace. Each
  # subPath is a subfolder of basePath (created on first mount); readOnly
  # (default false) blocks container writes.
  # volumes:
  #   - { subPath: shared-datasets, mountPath: /data, readOnly: true }

ssh:
  user: root
  port: 22
  keyName: id_ed25519
  # keyDir intentionally unset: keys default to ./keys next to this file.
  # Set ssh.keyDir in a project config to keep a per-project key pair instead.

container:
  workdir: /workspace
  localPort: 2222
`;
}

// Copy the Dockerfile from the repo into the global folder (the build context)
// and add a .dockerignore so the SSH keys / this config never enter the build
// context. Existing files are never overwritten.
function provisionDockerfile(dir) {
  const dst = path.join(dir, "Dockerfile");
  if (fs.existsSync(dst)) {
    console.log(`kept:    ${dst} (already exists, left untouched)`);
  } else {
    fs.copyFileSync(path.join(PROJECT_ROOT, "Dockerfile"), dst);
    console.log(`created: ${dst} (copied from the repo)`);
  }
  const ignore = path.join(dir, ".dockerignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "keys/\nconfig.yaml\n*.pem\n");
    console.log(`created: ${ignore}`);
  }
}

// Ask for one environment value. A flag wins; otherwise an interactive prompt
// (only on a real TTY); otherwise a clearly-marked placeholder. Never blocks
// when run non-interactively.
async function ask(rl, value, { flagName, label, example, placeholder }) {
  if (value) return value;
  if (rl) {
    let text = "";
    try {
      text = await rl.question(`${label} [e.g. ${example}]: `);
    } catch {
      /* stdin closed (Ctrl-D) -> fall through to the placeholder */
    }
    const v = (text || "").trim();
    if (v) return v;
    console.warn(
      `warning: no value for ${label.toLowerCase()}; wrote a placeholder. ` +
        `Set it in the global config or re-run: coding-container setup --${flagName} <value>`
    );
  }
  return placeholder;
}

// Collect the environment-specific values for a fresh global config.
async function captureEnvironment(opts) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const willPrompt = Boolean(rl && (!opts.registry || !opts.nfsServer || !opts.nfsBasePath));
  if (willPrompt) {
    console.log("A few questions about your environment (Enter skips to a placeholder):");
  }
  try {
    return {
      registry: await ask(rl, opts.registry, {
        flagName: "registry",
        label: "Container registry",
        example: "registry.example.com/you",
        placeholder: PLACEHOLDERS.registry,
      }),
      nfsServer: await ask(rl, opts.nfsServer, {
        flagName: "nfs-server",
        label: "NFS server (NAS IP or hostname)",
        example: "10.0.0.5",
        placeholder: PLACEHOLDERS.nfsServer,
      }),
      nfsBasePath: await ask(rl, opts.nfsBasePath, {
        flagName: "nfs-base-path",
        label: "NFS base path (shared folder for per-project workspaces)",
        example: "/workspaces",
        placeholder: PLACEHOLDERS.nfsBasePath,
      }),
    };
  } finally {
    if (rl) rl.close();
  }
}

export async function setup(opts = {}) {
  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });

  provisionDockerfile(dir);

  const cfgFile = globalConfigPath();
  if (fs.existsSync(cfgFile)) {
    console.log(`kept:    ${cfgFile} (already exists, left untouched)`);
  } else {
    const values = await captureEnvironment(opts);
    fs.writeFileSync(cfgFile, renderTemplate(dir, values));
    console.log(`created: ${cfgFile}`);
  }

  const pair = ensureKeyPair(path.join(dir, "keys"), "id_ed25519");
  console.log(`keys:    ${pair.private}`);

  console.log(
    `\nDone. Edit the global config if your environment differs (registry, NFS server),\n` +
      `then run (once, on a fresh cluster): coding-container system init --tag v1.0.0\n` +
      `and in any project folder: coding-container create`
  );
}
