# SSH image paste into opencode

Pasting a clipboard image (`Ctrl+V`) into the `opencode` TUI works locally but does nothing when `opencode` runs inside `coding-container ssh`. This is expected.

## Why

* Local `opencode` reads your local clipboard directly.
* Over `coding-container ssh`, `opencode` only sees a terminal byte-stream. The remote container has no display server or clipboard daemon, and plain SSH does not forward image bytes.
* This is a terminal/SSH limitation, not a container bug. Text paste works because terminals send text bytes; image paste needs extra bridging.

Prerequisite for anything below: use a vision-capable model (image input enabled), otherwise even a file reference fails.

## Workaround without extra tools (always works)

1. Save the screenshot to a file locally.
2. Copy it into `/workspace` (`scp`, or drag-drop into the Explorer when connected via Remote-SSH).
3. Reference it in `opencode` with `@/workspace/image.png`.

When connected with Zed Remote or any Remote-SSH client, step 2 is just saving into the opened `/workspace`, which is already remote.

## Windows Terminal

Use a clipboard bridge. It watches local `Ctrl+V`, uploads the PNG over SSH with your existing key, and injects the remote path so `opencode` shows `[Image #1]`.

Options:

* `Empty-Jing/opencode-ssh-image-paste`: built for Windows Terminal + `opencode` + SSH, keeps `Ctrl+V` for text.
* `cc-clip --opencode`, `clipssh`, `cssh`: generic upload-and-paste-path workflows (Windows support is experimental for some).

The `coding-<project>` alias in `~/.ssh/config` (written by `deploy`) already carries `IdentityFile` and `StrictHostKeyChecking no`, so it satisfies the usual bridge requirement of non-interactive key auth. Verify with:

```sh
ssh -o BatchMode=yes -n -T coding-<project> "printf ready"
```

It must print `ready` with no password/host-key prompt. Open a fresh `ssh coding-<project>` once first if it does not.

## Zed.dev and VS Code Remote

Connect Zed Remote / VS Code Remote-SSH to `coding-<project>` and open `/workspace`. Both read `~/.ssh/config`, so the alias works as-is.

Same limitation in both: the integrated terminal runs the remote `opencode` TUI, and neither editor forwards local clipboard images into it.

* Paste image into Zed Agent Panel / VS Code Chat input: works (native UI, runs locally).
* `Ctrl+V` image into the integrated terminal running remote `opencode`: does not work.
* Drag a saved workspace file into the terminal, or reference `@image.png`: works.

So in Zed / VS Code Remote: save the screenshot into `/workspace` (in VS Code, dragging a local file into the Explorer uploads it), then drag it from the Explorer into the terminal running `opencode` or type `@image.png`. For one-shot `Ctrl+V` inside the terminal you still need a bridge from the Windows Terminal section running alongside (note: the Windows Terminal `sendInput` bridge only applies to Windows Terminal, not to the VS Code/Zed integrated terminal).

## See also

* [SSH and VS Code](./ssh-and-vscode.md): `coding-<project>` alias, key rotation.
* [Troubleshooting](./troubleshooting.md): connection fixes.
