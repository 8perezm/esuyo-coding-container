import { run } from "../utils/exec.js";
import { removeHostEntry, sshAlias, sshConfigPath } from "../utils/ssh-config.js";

export async function deleteProject(cfg, { keepSecrets = false } = {}) {
  const ns = cfg.k8s.namespace;
  await run("kubectl", ["delete", "deployment", cfg.project, "-n", ns, "--ignore-not-found"]);
  await run("kubectl", ["delete", "service", cfg.project, "-n", ns, "--ignore-not-found"]);
  await run("kubectl", ["delete", "ingress", cfg.project, "-n", ns, "--ignore-not-found"]);
  if (!keepSecrets) {
    await run("kubectl", ["delete", "configmap", `${cfg.project}-ssh`, "-n", ns, "--ignore-not-found"]);
    await run("kubectl", ["delete", "secret", `${cfg.project}-env`, "-n", ns, "--ignore-not-found"]);
  }
  console.log(`Deleted ${cfg.project} from namespace ${ns}`);

  // Drop the SSH alias for the container.
  try {
    const alias = sshAlias(cfg.project);
    if (removeHostEntry(alias)) {
      console.log(`Removed SSH alias "${alias}" from ${sshConfigPath()}`);
    }
  } catch (err) {
    console.warn(`Warning: could not update SSH config: ${err.message}`);
  }
}
