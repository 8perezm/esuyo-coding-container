import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static regression guard for the rootless half of the shared image. The image
// has one entrypoint with two branches: root (historical behavior) and
// non-root (sshd as the image user on an unprivileged port). A real container
// run is the integration check; these assertions keep the pieces from silently
// disappearing.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = fs.readFileSync(path.resolve(__dirname, "..", "Dockerfile"), "utf8");
const ENTRYPOINT = fs.readFileSync(path.resolve(__dirname, "..", "entrypoint.sh"), "utf8");

test("Dockerfile: declares the non-root build args and creates the user", () => {
  assert.match(DOCKERFILE, /ARG APP_USER=ubuntu/);
  assert.match(DOCKERFILE, /ARG APP_UID=1000/);
  assert.match(DOCKERFILE, /ARG APP_GID=1000/);
  assert.match(DOCKERFILE, /useradd --uid "\$\{APP_UID\}" --gid "\$\{APP_GID\}"/);
  assert.match(DOCKERFILE, /"\$\{APP_UID\}:\$\{APP_GID\}"/);
  assert.match(DOCKERFILE, /is already used by/);
  assert.match(DOCKERFILE, /gpasswd -d "\$\{APP_USER\}" sudo/);
});

test("Dockerfile: prepares the non-root home for agents and tools", () => {
  assert.match(DOCKERFILE, /\.npm-global/);
  assert.match(DOCKERFILE, /\.opencode\/bin/);
  assert.match(DOCKERFILE, /su -l -s \/bin\/bash "\$\{APP_USER\}"/);
  assert.match(DOCKERFILE, /home\/\$\{APP_USER\}\/\.pi\/agent\/extensions/);
  assert.match(DOCKERFILE, /home\/\$\{APP_USER\}\/\.config\/opencode/);
  assert.match(DOCKERFILE, /home\/\$\{APP_USER\}\/\.bashrc/);
});

test("Dockerfile: copies the entrypoint script from the build context", () => {
  assert.match(DOCKERFILE, /COPY entrypoint\.sh \/entrypoint\.sh/);
});

test("entrypoint: branches on UID and starts non-root sshd on 2222", () => {
  assert.match(ENTRYPOINT, /if \[ "\$\(id -u\)" -ne 0 \]; then/);
  assert.match(ENTRYPOINT, /CODING_CONTAINER_SSH_PORT:-2222/);
  assert.match(ENTRYPOINT, /\/workspace is not writable by uid/);
  assert.match(ENTRYPOINT, /sshd -D -e -f "\$home\/\.ssh\/sshd_config"/);
  assert.match(ENTRYPOINT, /AuthorizedKeysFile \$home\/\.ssh\/authorized_keys/);
  assert.match(ENTRYPOINT, /UsePAM no/);
  assert.match(ENTRYPOINT, /AllowTcpForwarding yes/);
  assert.match(ENTRYPOINT, /Subsystem sftp internal-sftp/);
});

test("entrypoint: root branch keeps the historical sshd start", () => {
  assert.match(ENTRYPOINT, /mkdir -p \/run\/sshd/);
  assert.match(ENTRYPOINT, /publish_env \/etc\/profile\.d\/99-container-env\.sh/);
  assert.match(ENTRYPOINT, /exec \/usr\/sbin\/sshd -D "\$@"\n/);
});
