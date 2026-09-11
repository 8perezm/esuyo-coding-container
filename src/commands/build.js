import { dockerExec, run } from "../utils/exec.js";
import { imageRef } from "../config.js";

/**
 * The raw docker build of cfg's image (cfg.image.tag must be set). Used by
 * custom-mode projects and by `system create` (the only writer of the
 * global image).
 */
export async function buildImage(cfg) {
  const ref = imageRef(cfg);
  const args = ["build", "-t", ref, "-f", cfg.image.dockerfilePath];
  for (const [key, value] of Object.entries(cfg.image.buildArgs || {})) {
    args.push("--build-arg", `${key}=${value}`);
  }
  args.push(cfg.image.contextPath);
  console.log(`Building image ${ref} ...`);
  const { cmd, opts } = dockerExec();
  await run(cmd, args, opts);
  console.log(`Built ${ref}`);
}

export async function build(cfg) {
  if (cfg.imageMode === "global") {
    throw new Error(
      "this project uses the shared global image — building here would tag the global repo. " +
        "Publish a new global version with: coding-container system create --tag vX.Y.Z"
    );
  }
  if (!cfg.image.tag) {
    throw new Error(
      "custom image mode requires a tag: set image.tag in the project config or pass --tag"
    );
  }
  await buildImage(cfg);
}
