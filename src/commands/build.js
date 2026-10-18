import fs from "node:fs";
import { dockerExec, ensureDockerAvailable, run } from "../utils/exec.js";
import { imageRef } from "../config.js";

/**
 * The raw docker build of cfg's image (cfg.image.tag must be set). Used by
 * custom-mode projects and by `system create` (the only writer of the
 * global image).
 */
export async function buildImage(cfg) {
  if (!cfg.image.dockerfilePath || !fs.existsSync(cfg.image.dockerfilePath)) {
    throw new Error(
      `config: dockerfile not found: ${cfg.image.dockerfilePath ?? "(unset)"}. ` +
        `Run 'coding-container setup' to provision one, or fix image.dockerfile in your config.`
    );
  }
  if (!cfg.image.contextPath || !fs.existsSync(cfg.image.contextPath)) {
    throw new Error(
      `config: build context not found: ${cfg.image.contextPath ?? "(unset)"}. ` +
        `Fix image.context in your config.`
    );
  }
  // A Dockerfile with Windows (CRLF) line endings bakes '\r' into the
  // /entrypoint.sh heredoc, and the image then fails at boot with
  // `exec /entrypoint.sh: no such file or directory` (exit 255).
  // Normalizing line endings is content-preserving for the build, so fix
  // it in place here (with a visible warning) instead of failing and
  // asking the user to hand-edit the file.
  const dockerfileText = fs.readFileSync(cfg.image.dockerfilePath, "utf8");
  if (dockerfileText.includes("\r")) {
    fs.writeFileSync(
      cfg.image.dockerfilePath,
      dockerfileText.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    );
    console.warn(
      `warning: normalized Windows (CRLF) line endings to Unix (LF) in ${cfg.image.dockerfilePath}`
    );
  }
  const ref = imageRef(cfg);
  const args = ["build", "-t", ref, "-f", cfg.image.dockerfilePath];
  for (const [key, value] of Object.entries(cfg.image.buildArgs || {})) {
    args.push("--build-arg", `${key}=${value}`);
  }
  args.push(cfg.image.contextPath);
  console.log(`Building image ${ref} ...`);
  try {
    ensureDockerAvailable();
  } catch (err) {
    throw new Error(
      `${err.message}\n(Build of ${ref} did not start — no image was built.)`
    );
  }
  const { cmd, opts } = dockerExec();
  try {
    await run(cmd, args, opts);
  } catch (err) {
    throw new Error(
      `${err.message}\n(Build of ${ref} failed. If the output above mentions the Docker API, npipe, or daemon, Docker isn't running — start Docker Desktop (or the Docker daemon) and try again.)`
    );
  }
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
