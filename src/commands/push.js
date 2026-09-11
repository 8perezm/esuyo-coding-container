import { dockerExec, run } from "../utils/exec.js";
import { imageRef } from "../config.js";

/**
 * The raw docker push of cfg's image (cfg.image.tag must be set). Used by
 * custom-mode projects and by `system create` (the only writer of the
 * global image).
 */
export async function pushImage(cfg) {
  const ref = imageRef(cfg);
  console.log(`Pushing ${ref} to ${cfg.image.registry} ...`);
  const { cmd, opts } = dockerExec();
  try {
    await run(cmd, ["push", ref], opts);
  } catch (err) {
    throw new Error(
      `Push failed for ${ref}. Make sure you are logged in to ${cfg.image.registry} (docker login ${cfg.image.registry}).\n${err.message}`
    );
  }
  console.log(`Pushed ${ref}`);
}

export async function push(cfg) {
  if (cfg.imageMode === "global") {
    throw new Error(
      "this project uses the shared global image — pushing here would publish to the global repo. " +
        "Publish a new global version with: coding-container system create --tag vX.Y.Z"
    );
  }
  if (!cfg.image.tag) {
    throw new Error(
      "custom image mode requires a tag: set image.tag in the project config or pass --tag"
    );
  }
  await pushImage(cfg);
}
