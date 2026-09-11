import { build } from "./build.js";
import { push } from "./push.js";
import { deploy } from "./deploy.js";

/**
 * Global mode: nothing is built or pushed here — the shared image is
 * managed by `system create`, and deploy floats on the cluster ConfigMap.
 * Custom mode: build + push the project's own image (coding-<project>),
 * then deploy.
 */
export async function create(cfg, { skipBuild = false, skipPush = false } = {}) {
  if (cfg.imageMode === "global") {
    if (skipBuild || skipPush) {
      console.log(
        "Global image mode: no build/push happens here — the shared image is managed by " +
          "'coding-container system create'."
      );
    }
    await deploy(cfg);
  } else {
    if (skipBuild) {
      console.log("Skipping build");
    } else {
      await build(cfg);
    }
    if (skipPush) {
      console.log("Skipping push");
    } else {
      await push(cfg);
    }
    await deploy(cfg);
  }

  console.log(`
Done. Connect with:
  coding-container ssh
`);
}
