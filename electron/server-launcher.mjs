/**
 * Fork entry for the bundled GUI server (web/server/server.js, unchanged).
 *
 * The fork itself must start WITHOUT ELECTRON_RUN_AS_NODE in its
 * environment: with that flag the subprocess runs as plain Node and rejects
 * the runtime's own internal flags, exiting immediately. The server's job
 * runner, however, spawns CLI processes that DO need the flag (the app
 * binary must behave as plain Node for them), so it is set here,
 * in-process, before the server module loads. Setting it now has no effect
 * on this already-running process; the job children inherit it.
 *
 * Usage: forked with the server entry file path as argv[2].
 */

process.env.ELECTRON_RUN_AS_NODE = "1";

import { pathToFileURL } from "node:url";

const serverEntry = process.argv[2];
if (!serverEntry) {
  console.error("server-launcher: missing server entry path argument");
  process.exit(1);
}

const { startServer } = await import(pathToFileURL(serverEntry).href);
startServer();
