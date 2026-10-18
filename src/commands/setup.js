import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { globalConfigDir, globalConfigPath, PROJECT_ROOT } from "../config.js";
import { ensureKeyPair } from "../utils/keys.js";
import { exec, run } from "../utils/exec.js";
import { kubectlExec } from "../utils/system-config.js";
import { NAMESPACE_LABEL, SETUP_ANNOTATIONS, readNamespaceSetupValues } from "../utils/namespaces.js";

// Values that differ per environment. When neither a flag nor a prompt supplies
// one, the generated config gets a clearly-marked placeholder instead of a guess.
export const PLACEHOLDERS = {
  registry: "your-registry.example.com/you",
  nfsServer: "your-nas-ip-or-hostname",
  nfsBasePath: "/path/to/shared/workspaces",
  namespace: "coding",
};

// Same DNS-1123 pattern as defaultNamespace() in src/utils/instance.js:
// lowercase alphanumerics and '-', max 63 chars.
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function normalizeNamespace(value) {
  const v = String(value ?? "").trim();
  if (v.length < 1 || v.length > 63 || !NAMESPACE_RE.test(v)) {
    throw new Error(
      `namespace must be a valid k8s name (lowercase alphanumerics and '-', max 63 chars), got: ${JSON.stringify(value)}`
    );
  }
  return v;
}

/**
 * Which of the three setup-value annotations to (re)write. Skips blanks
 * and the setup placeholders so a never-configured environment never
 * pollutes cluster annotations with "your-registry.example.com/you".
 */
export function setupAnnotationPairs(setupValues) {
  const skip = new Set(Object.values(PLACEHOLDERS));
  const pairs = [];
  if (!setupValues || typeof setupValues !== "object") return pairs;
  for (const [field, key] of Object.entries(SETUP_ANNOTATIONS)) {
    const v = setupValues[field];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || skip.has(t)) continue;
    pairs.push(`${key}=${t}`);
  }
  return pairs;
}

/**
 * Label + annotate an existing namespace; best effort, never throws.
 * Only touches a namespace that already exists (creation happens on
 * deploy/init), so setup stays fully usable offline.
 */
async function tagNamespaceBestEffort(ns, setupValues) {
  try {
    const { cmd, args, opts } = kubectlExec();
    exec(cmd, [...args, "get", "namespace", ns], opts);
    await run(cmd, [...args, "label", "namespace", ns, NAMESPACE_LABEL, "--overwrite"], opts);
    const pairs = setupAnnotationPairs(setupValues);
    if (pairs.length) {
      await run(cmd, [...args, "annotate", "namespace", ns, "--overwrite", ...pairs], opts);
    }
  } catch (err) {
    console.warn(
      `warning: could not tag namespace "${ns}" (it will be tagged on the next deploy): ` +
        String(err.message ?? err).split("\n")[0]
    );
  }
}

// Emit a YAML double-quoted scalar so special characters (":", "/", etc.) are safe.
function yamlValue(v) {
  return JSON.stringify(v);
}

function renderTemplate(values) {
  return `# coding-container global configuration (created by 'coding-container setup')
#
# Shared by every project. Layering, lowest to highest priority:
#   built-in defaults -> THIS file -> the project's config.yaml -> CLI flags
#
# Relative paths in this file resolve against this file's directory.
# The Dockerfile and the SSH key pair live next to this file:
#   Dockerfile - the image build (copied here from the repo on first run)
#   keys/      - the shared SSH key pair (host keys are ephemeral, never stored)

image:
  registry: ${yamlValue(values.registry)}
  name: coding-container
  # tag: optional local fallback (e.g. for offline 'validate --manifest').
  # Normal deploys float on the cluster's coding-system ConfigMap:
  #   coding-container system init --tag v1.0.0   (once, on a fresh cluster)
  #   coding-container system get                 (show current/previous/maxEver)
  # Set tag in a project config to pin that project to one global version.
  # Single image build shared by all projects (Dockerfile copied next to this file).
  # Relative paths resolve against this file's directory, so this config
  # survives renames/moves of the config folder.
  dockerfile: Dockerfile
  context: .
  buildArgs:
    BASE_IMAGE: ubuntu:26.04
    NODE_VERSION: "22"
    EXTRA_APT_PACKAGES: ""
    EXTRA_NPM_PACKAGES: ""

k8s:
  namespace: ${yamlValue(values.namespace)}
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
// context. Existing files are never overwritten. The copy is normalized to
// Unix (LF) line endings: a Windows (CRLF) checkout would otherwise bake
// '\r' into /entrypoint.sh via the Dockerfile heredoc, and the image then
// fails at boot with `exec /entrypoint.sh: no such file or directory`
// (the kernel looks for the interpreter `/bin/bash\r`).
function provisionDockerfile(dir) {
  const dst = path.join(dir, "Dockerfile");
  if (fs.existsSync(dst)) {
    // An existing Dockerfile from an older setup may carry Windows (CRLF)
    // line endings, which would bake '\r' into /entrypoint.sh. Normalizing
    // is content-preserving for the build, so repair it in place rather
    // than leaving a file that can only produce a broken image.
    const existing = fs.readFileSync(dst, "utf8");
    if (existing.includes("\r")) {
      fs.writeFileSync(dst, existing.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
      console.log(`normalized: ${dst} (converted CRLF to LF)`);
    } else {
      console.log(`kept:    ${dst} (already exists, left untouched)`);
    }
  } else {
    const src = path.join(PROJECT_ROOT, "Dockerfile");
    const content = fs.readFileSync(src, "utf8").replaceAll("\r\n", "\n");
    fs.writeFileSync(dst, content);
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
  const willPrompt = Boolean(
    rl && (!opts.registry || !opts.nfsServer || !opts.nfsBasePath || !opts.namespace)
  );
  if (willPrompt) {
    console.log("A few questions about your environment (Enter skips to a placeholder):");
  }
  try {
    const values = {
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
      namespace: await ask(rl, opts.namespace, {
        flagName: "namespace",
        label: "Coding namespace",
        example: "coding / team-alpha",
        placeholder: PLACEHOLDERS.namespace,
      }),
    };
    values.namespace = normalizeNamespace(values.namespace);
    return values;
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
    // An explicit --namespace still tags that namespace (label + any
    // explicitly-passed values) without touching the kept config file.
    if (typeof opts.namespace === "string" && opts.namespace.trim()) {
      await tagNamespaceBestEffort(normalizeNamespace(opts.namespace), {
        registry: opts.registry,
        nfsServer: opts.nfsServer,
        nfsBasePath: opts.nfsBasePath,
      });
    }
  } else {
    // Existing-namespace flow: the GUI hides registry/NFS and sends only
    // --namespace. Fill blanks from the namespace's stored annotations so
    // a reselect needs no retyping. Missing/offline degrades to the normal
    // prompt-or-placeholder path below.
    const effective = { ...opts };
    if (typeof effective.namespace === "string" && effective.namespace.trim()) {
      try {
        const stored = readNamespaceSetupValues(normalizeNamespace(effective.namespace));
        for (const field of ["registry", "nfsServer", "nfsBasePath"]) {
          if (!effective[field] && stored[field]) effective[field] = stored[field];
        }
      } catch {
        /* invalid name surfaces via captureEnvironment validation */
      }
    }
    const values = await captureEnvironment(effective);
    fs.writeFileSync(cfgFile, renderTemplate(values));
    console.log(`created: ${cfgFile}`);
    await tagNamespaceBestEffort(values.namespace, values);
  }

  const pair = ensureKeyPair(path.join(dir, "keys"), "id_ed25519");
  console.log(`keys:    ${pair.private}`);

  console.log(
    `\nDone. Edit the global config if your environment differs (registry, NFS server),\n` +
      `then run (once, on a fresh cluster): coding-container system init --tag v1.0.0\n` +
      `and in any project folder: coding-container create`
  );
}
