# Agent guidelines

- The web GUI serves GUI users, who are not CLI users: never mention the CLI
  in GUI-visible copy. No commands (`node src/index.js ...`, npm commands),
  no "CLI args" / "CLI-parity" notes, no command-line renderings of job
  arguments. Describe actions and results in GUI terms (pages, buttons, jobs).

## Running commands (Windows)

- Foreground commands can hang with zero output: state the expected
  duration before running anything, and treat anything past ~60s as hung,
  not slow. Reference times: one backend test file ~3-15s, full `npm test`
  ~10-30s, `npm --prefix web/client run build` ~5-10s, quick `node -e`
  probes <5s.
- Bound every potentially-hanging call: pass `--test-timeout=<ms>` to
  `node --test`; otherwise launch detached via `Start-Process` with
  `-RedirectStandardOutput` / `-RedirectStandardError` to files, wait with
  `Wait-Process -Timeout`, then read the files.
- Scripts that wait on the network or child processes must enforce their
  own deadline (a `setTimeout(...process.exit...)` guard).
- `Start-Process npm` fails on Windows (`%1 is not a valid Win32
  application`); run the underlying script directly instead
  (e.g. `node web/dev.js` instead of `npm run dev`).
