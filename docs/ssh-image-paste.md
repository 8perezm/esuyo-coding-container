# SSH image paste into opencode

Pasting a clipboard image with `Ctrl+V` into the `opencode` TUI works locally but does nothing when `opencode` runs in a container shell. This is expected and it is not a container bug.

## Why this happens

* Local `opencode` reads your local clipboard directly.
* In a container shell, `opencode` only sees a terminal byte stream. The remote container has no display server or clipboard service, and plain SSH does not forward image bytes.
* Text paste works because terminals send text bytes. Image paste needs extra help.

For anything below, use a vision capable model with image input on, otherwise even a file reference fails.

## Easy path that always works

This works in the browser terminal, in VS Code, and in any SSH client:

1. Save the screenshot to a file locally.
2. Copy it into `/workspace` with `scp`, or with drag and drop into the Explorer when connected with Remote SSH.
3. Reference it in `opencode` with `@/workspace/image.png`.

When connected with Zed Remote or any Remote SSH client, step 2 is just saving into the opened `/workspace`, which is already remote.

## Windows Terminal

Use a clipboard bridge. It watches local `Ctrl+V`, uploads the PNG over SSH with your existing key, and inserts the remote path so `opencode` shows `[Image #1]`.

Options people use:

* `Empty-Jing/opencode-ssh-image-paste` built for Windows Terminal plus `opencode` plus SSH, keeps `Ctrl+V` for text
* `cc-clip --opencode`, `clipssh`, `cssh` for a generic upload and paste path flow, Windows support is experimental for some

The `coding-<project>` alias in `~/.ssh/config` written at Deploy time already carries `IdentityFile` and `StrictHostKeyChecking no`, so it usually satisfies the non interactive key auth need of these bridges. You can verify the alias answers without a prompt:

```sh
ssh -o BatchMode=yes -n -T coding-<project> "printf ready"
```

It should print `ready` with no password or host key prompt. Open a fresh `ssh coding-<project>` once first when it does not.

You can see and refresh these aliases any time on the SSH and Keys page.

## Zed and VS Code Remote

Connect Zed Remote or VS Code Remote SSH to `coding-<project>` and open `/workspace`. Both read `~/.ssh/config`, so the alias works as is.

Same limit in both: the integrated terminal runs the remote `opencode` TUI, and neither editor forwards local clipboard images into it.

* Paste an image into the Zed Agent Panel or VS Code Chat input: works, because that UI runs locally.
* Press `Ctrl+V` for an image in the integrated terminal running remote `opencode`: does not work.
* Drag a saved workspace file into the terminal, or type `@image.png`: works.

So in Zed or VS Code Remote: save the screenshot into `/workspace`. In VS Code you can drag a local file into the Explorer to upload it. Then drag it from the Explorer into the terminal running `opencode` or type `@image.png`. For one press `Ctrl+V` inside the terminal you still need a bridge from the Windows Terminal section running beside it. Note that the Windows Terminal `sendInput` bridge only applies to Windows Terminal, not to the VS Code or Zed integrated terminal.

## See also

* [SSH and VS Code](./ssh-and-vscode.md) for the `coding-<project>` alias and key rotation
* [Troubleshooting](./troubleshooting.md) for connection fixes
* [Web GUI](./gui.md) for the browser terminal
