import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dockerExec, exec, run, runWithInput, start } from "../src/utils/exec.js";
import { kubectlExec } from "../src/utils/system-config.js";
import { queryCredentialHelper } from "../src/utils/registry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("dockerExec: hides the console window", () => {
  const prev = process.env.DOCKER_BIN;
  delete process.env.DOCKER_BIN;
  try {
    const { opts } = dockerExec();
    assert.equal(opts.windowsHide, true);
  } finally {
    if (prev === undefined) delete process.env.DOCKER_BIN;
    else process.env.DOCKER_BIN = prev;
  }
});

test("kubectlExec: hides the console window (default, script and wrapper variants)", () => {
  const prev = process.env.KUBECTL_BIN;
  try {
    delete process.env.KUBECTL_BIN;
    assert.equal(kubectlExec().opts.windowsHide, true);

    process.env.KUBECTL_BIN = "/tmp/kubectl-stub.js";
    const jsVariant = kubectlExec();
    assert.equal(jsVariant.cmd, process.execPath);
    assert.equal(jsVariant.opts.windowsHide, true);

    process.env.KUBECTL_BIN = "C:\\tools\\kubectl.cmd";
    const cmdVariant = kubectlExec();
    assert.equal(cmdVariant.opts.windowsHide, true);
    if (process.platform === "win32") {
      assert.equal(cmdVariant.opts.shell, true);
    }
  } finally {
    if (prev === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = prev;
  }
});

test("exec/run/start: still run commands with the hidden-window default", async () => {
  const out = exec(process.execPath, ["-e", "process.stdout.write('hi')"]);
  assert.equal(out, "hi");

  await run(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await runWithInput(
    process.execPath,
    ["-e", "let d='';process.stdin.on('data',(c)=>(d+=c));process.stdin.on('end',()=>process.exit(0))"],
    "x"
  );

  const child = start(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
});

test("queryCredentialHelper: hides the console window", () => {
  let seenOpts = null;
  const spawn = (bin, args, opts) => {
    seenOpts = opts;
    return { error: null, status: 1, stdout: "", stderr: "" };
  };
  assert.equal(queryCredentialHelper("desktop", "example.com", spawn), null);
  assert.equal(seenOpts?.windowsHide, true);
});

test("job runner and port-forward: spawn without a terminal window", () => {
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, "web/server/server.js"), "utf8");
  assert.match(serverSrc, /spawn\(process\.execPath,\s*\[CLI_INDEX[\s\S]*?windowsHide:\s*true/);
  const terminalSrc = fs.readFileSync(
    path.join(REPO_ROOT, "web/server/ssh-terminal.js"),
    "utf8"
  );
  assert.match(terminalSrc, /windowsHide:\s*true/);
});
