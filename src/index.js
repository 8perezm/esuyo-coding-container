#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, imageRef, globalConfigPath, resolveDefaultConfigPath } from "./config.js";
import { setup } from "./commands/setup.js";
import { build } from "./commands/build.js";
import { push } from "./commands/push.js";
import { deploy } from "./commands/deploy.js";
import { create } from "./commands/create.js";
import { ssh } from "./commands/ssh.js";
import { gc } from "./commands/gc.js";
import { deleteProject } from "./commands/delete.js";
import { validate } from "./commands/validate.js";
import {
  systemInit,
  systemGet,
  systemList,
  systemCreate,
  systemRollback,
  systemGc,
} from "./commands/system.js";
import { ensureKeyPair } from "./utils/keys.js";
import { ensureProjectConfig } from "./utils/project.js";
import { resolveDeployTag } from "./utils/system-config.js";

const program = new Command();

program
  .name("coding-container")
  .description("Build, publish and deploy SSH-accessible coding containers on k3s")
  .version("1.0.0")
  // Positional options: flags before the subcommand are global, flags after
  // belong to the subcommand. Required so `system create --tag vX.Y.Z` is
  // not swallowed by the global --tag.
  .enablePositionalOptions()
  .option("-c, --config <file>", "path to config yaml (default: ./config.yaml if present, else the repo's)")
  .option("-p, --project <name>", "override the project name")
  .option("--tag <tag>", "override the image tag");

function cfgFrom(ctx) {
  const globalOpts = program.opts();
  const overrides = {};
  if (globalOpts.project) overrides.project = globalOpts.project;
  if (globalOpts.tag) overrides.image = { tag: globalOpts.tag };
  const cfg = loadConfig(resolveDefaultConfigPath(globalOpts.config), overrides);
  // First-run nudge: shown once, on stderr, until the global config exists.
  if (process.argv[2] !== "setup" && !fs.existsSync(globalConfigPath())) {
    console.error(
      `tip: no global config at ${globalConfigPath()} - using built-in defaults. Run "coding-container setup" to create one.`
    );
  }
  return cfg;
}

program
  .command("setup")
  .description("create the global config, Dockerfile and SSH key pair (never overwrites existing files)")
  .option("--registry <registry>", "container registry (e.g. registry.example.com/you)")
  .option("--nfs-server <server>", "NFS server IP or hostname (your NAS)")
  .option("--nfs-base-path <path>", "NFS base path for per-project workspaces")
  .action(async (opts) => {
    await setup(opts);
  });

program
  .command("create")
  .description(
    "deploy the project: global mode floats on the shared image (no build/push here), " +
      "custom mode builds + pushes the project's own image first"
  )
  .option("--skip-build", "skip the docker build step")
  .option("--skip-push", "skip the docker push step")
  .action(async (opts) => {
    const globalOpts = program.opts();
    // No explicit -c and no ./config.yaml: scaffold one (project name from
    // the folder, first free NodePort) and proceed with it.
    if (!globalOpts.config) {
      const cwdConfig = path.resolve(process.cwd(), "config.yaml");
      if (!fs.existsSync(cwdConfig)) {
        const { created, project, nodePort } = ensureProjectConfig(
          process.cwd(),
          globalOpts.project
        );
        if (created) {
          console.log(
            `No config.yaml in ${process.cwd()}\nCreated one for project "${project}" (nodePort ${nodePort}).`
          );
        }
      }
    }
    const cfg = cfgFrom();
    await create(cfg, {
      skipBuild: opts.skipBuild,
      skipPush: opts.skipPush,
    });
  });

program
  .command("build")
  .description("build the project's custom image (global-mode projects: use 'system create')")
  .action(async () => {
    const cfg = cfgFrom();
    await build(cfg);
  });

program
  .command("push")
  .description("push the project's custom image to the registry (global-mode projects: use 'system create')")
  .action(async () => {
    const cfg = cfgFrom();
    await push(cfg);
  });

program
  .command("deploy")
  .description("deploy the image to the k3s cluster")
  .option("--no-wait", "do not wait for the rollout to finish")
  .action(async (opts) => {
    const cfg = cfgFrom();
    await deploy(cfg, { wait: opts.wait });
  });

program
  .command("ssh")
  .description("open an SSH session into the deployed container (lands in /workspace)")
  .option("--direct", "connect via node IP + nodePort instead of kubectl port-forward")
  .action(async (opts) => {
    const cfg = cfgFrom();
    await ssh(cfg, { direct: opts.direct });
  });

program
  .command("delete")
  .alias("destroy")
  .description("delete the deployment, service and ssh configmap from the cluster")
  .option("--keep-secrets", "keep the ssh configmap")
  .action(async (opts) => {
    const cfg = cfgFrom();
    await deleteProject(cfg, { keepSecrets: opts.keepSecrets });
  });

program
  .command("key")
  .description("show (or generate) the SSH key pair used for this project")
  .option("--force", "regenerate the key pair (invalidates existing access)")
  .action((opts) => {
    const cfg = cfgFrom();
    if (opts.force) {
      for (const file of [
        path.join(cfg.ssh.keyDirPath, cfg.ssh.keyName),
        path.join(cfg.ssh.keyDirPath, cfg.ssh.keyName) + ".pub",
      ]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
    const pair = ensureKeyPair(cfg.ssh.keyDirPath, cfg.ssh.keyName);
    console.log(`Private key: ${pair.private}`);
    console.log(`Public key:  ${pair.public}`);
    let image;
    try {
      cfg.image.tag = resolveDeployTag(cfg);
      image = imageRef(cfg);
    } catch (err) {
      image = `unresolved: ${String(err.message).split("\n")[0]}`;
    }
    console.log(`Image:       ${image}`);
  });

program
  .command("validate")
  .description("load and validate the config without changing anything")
  .option("--manifest", "print the rendered k8s manifests instead of the summary")
  .action((opts) => {
    validate(cfgFrom(), { manifest: opts.manifest });
  });

program
  .command("gc")
  .description(
    "delete old tags from the project's custom image repo (keeps the pinned tag, in-use tags and N versions behind the pin; global-mode projects: use 'system gc')"
  )
  .option("--keep <n>", "how many versions behind the pinned tag to keep", (value) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--keep must be a non-negative integer, got: ${value}`);
    }
    return n;
  }, 5)
  .option("--dry-run", "list the tags that would be deleted without deleting anything")
  .action(async (opts) => {
    const cfg = cfgFrom();
    await gc(cfg, { keep: opts.keep, dryRun: opts.dryRun });
  });

function parseIntOption(value, flag) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative integer, got: ${value}`);
  }
  return n;
}

// The shared global image: one ConfigMap (coding-system) in the cluster is
// the source of truth. `system create` is the only writer of the image;
// project deploys float on `current`.
const system = program
  .command("system")
  .description(
    "manage the shared global coding image (cluster ConfigMap 'coding-system'; run from a global-mode project or the repo root)"
  )
  .enablePositionalOptions();

system
  .command("init")
  .description("create the coding-system ConfigMap (fresh clusters only; fails if it exists)")
  .requiredOption("--tag <tag>", "starting version (semver vX.Y.Z)")
  .option("--keep <n>", "gc window: versions kept behind current (default: 10)", (value) => {
    return parseIntOption(value, "--keep");
  }, 10)
  .action(async (opts) => {
    const cfg = cfgFrom();
    await systemInit(cfg, { tag: opts.tag, keep: opts.keep });
  });

system
  .command("get")
  .description("show current/previous/maxEver/keep and the resolved global image")
  .action(async () => {
    systemGet(cfgFrom());
  });

system
  .command("list")
  .description("list the global repo's registry tags, semver-sorted (read-only)")
  .action(async () => {
    await systemList(cfgFrom());
  });

system
  .command("create")
  .description(
    "build + push a new global version and repoint current (the only writer of the global image)"
  )
  .requiredOption("--tag <tag>", "new version (semver vX.Y.Z, must not exist and must be > maxEver)")
  .action(async (opts) => {
    const cfg = cfgFrom();
    await systemCreate(cfg, { tag: opts.tag });
  });

system
  .command("rollback")
  .description("repoint current to an existing version (default: previous); no build/push/delete")
  .argument("[tag]", "target version (semver vX.Y.Z; default: previous)")
  .action(async (tag) => {
    const cfg = cfgFrom();
    await systemRollback(cfg, { tag });
  });

system
  .command("gc")
  .description(
    "delete old tags from the global repo (keeps current, previous, all in-use tags and the ConfigMap's keep-many behind current)"
  )
  .option("--keep <n>", "override the ConfigMap's keep for this run", (value) => {
    return parseIntOption(value, "--keep");
  })
  .option("--dry-run", "list the tags that would be deleted without deleting anything")
  .action(async (opts) => {
    const cfg = cfgFrom();
    await systemGc(cfg, { keep: opts.keep, dryRun: opts.dryRun });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nError: ${err.message}\n`);
  process.exit(1);
});
