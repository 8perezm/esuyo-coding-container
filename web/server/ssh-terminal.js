#!/usr/bin/env node
/**
 * Browser SSH terminal transport for the web GUI.
 *
 * Serves `ws(s)://<host>/api/ssh/<projectId>` by opening the project's SSH
 * session server-side (kubectl port-forward to the project's service, then
 * an SSH shell channel with a real pty size via the `ssh2` dependency) and
 * bridging raw bytes between that session and the browser.
 *
 * A real pty size matters: the channel is opened with the browser's current
 * columns/rows and every browser resize is forwarded as an SSH
 * window-change, so programs inside the container that query the terminal
 * size (full-screen apps, prompts, installers) see a usable, non-zero grid.
 *
 * The WebSocket transport itself is node:builtins only: a minimal RFC 6455
 * server (upgrade handshake + frame codec) on top of the existing node:http
 * server. Wire protocol:
 *   browser -> server : text frames; terminal input, except a JSON control
 *                       message {"type":"resize","cols":N,"rows":M}
 *   server -> browser : binary frames with raw session output
 * Session end (or pre-handshake failure) is signalled with a close frame
 * carrying a human-readable reason.
 *
 * Wiring (see web/server/server.js):
 *   import { attachSshTerminal } from "./ssh-terminal.js";
 *   attachSshTerminal(server, {
 *     isAuthenticated: (req) => Boolean(session),
 *     loadTarget: (projectId) => ({ name, namespace, service, sshPort,
 *                                   user, privateKey }),
 *     // Optional, for tests: openShell defaults to openSshShell below.
 *   });
 *
 * kubectl honours `KUBECTL_BIN` via src/utils/system-config.js.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
import { kubectlExec } from "../../src/utils/system-config.js";

const { Client } = ssh2;

export const SSH_WS_PREFIX = "/api/ssh/";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PORT_FORWARD_TIMEOUT_MS = 15000;
const SSH_READY_TIMEOUT_MS = 15000;
const SSH_KEEPALIVE_MS = 15000;

// ------------------------------------------------------------------ routing ---

/**
 * Extract the project id from an upgrade pathname of the form
 * `/api/ssh/<projectId>`. Returns null for anything else (including
 * `/api/ssh/info`, which is plain HTTP, and nested paths).
 */
export function extractTerminalProjectId(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith(SSH_WS_PREFIX)) return null;
  const rest = pathname.slice(SSH_WS_PREFIX.length);
  if (!rest || rest.includes("/")) return null;
  let id;
  try {
    id = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (!id || id === "info") return null;
  return id;
}

/** RFC 6455 accept header for a client's Sec-WebSocket-Key. */
export function computeAcceptKey(clientKey) {
  return crypto.createHash("sha1").update(`${clientKey}${WS_GUID}`).digest("base64");
}

// --------------------------------------------------------------- frame codec ---

const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** Encode one server-to-client frame (never masked). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

export function encodeCloseFrame(code = 1000, reason = "") {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return encodeFrame(OPCODE_CLOSE, body);
}

/**
 * Incrementally decode client-to-server frames (masked per RFC 6455).
 * Returns { messages, leftover }: messages is [{ opcode, payload }] with
 * continuation frames reassembled; leftover is the unconsumed tail.
 */
export function decodeFrames(buffer, leftover = Buffer.alloc(0)) {
  const buf = Buffer.concat([leftover, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)]);
  const messages = [];
  let offset = 0;
  let pendingOpcode = null;
  let pendingParts = [];
  const pushPending = () => {
    messages.push({ opcode: pendingOpcode, payload: Buffer.concat(pendingParts) });
    pendingOpcode = null;
    pendingParts = [];
  };
  while (true) {
    if (buf.length - offset < 2) break;
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (buf.length - pos < 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) break;
      const big = buf.readBigUInt64BE(pos);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket frame too large");
      len = Number(big);
      pos += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - pos < 4) break;
      mask = buf.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buf.length - pos < len) break;
    let payload = buf.subarray(pos, pos + len);
    if (mask) {
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    offset = pos + len;
    if (opcode === 0x0) {
      if (pendingOpcode === null) throw new Error("unexpected websocket continuation frame");
      pendingParts.push(payload);
      if (fin) pushPending();
    } else if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      if (pendingOpcode !== null) throw new Error("interleaved websocket data frame");
      if (fin) messages.push({ opcode, payload });
      else {
        pendingOpcode = opcode;
        pendingParts = [payload];
      }
    } else {
      // Control frames are never fragmented; surface them directly.
      messages.push({ opcode, payload });
    }
  }
  return { messages, leftover: buf.subarray(offset) };
}

// ------------------------------------------------------------ session plumbing ---

/** Pick an unused 127.0.0.1 TCP port. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn `kubectl port-forward svc/<service>`; resolves when forwarding. */
function startPortForward({ namespace, service, sshPort }, localPort) {
  const { cmd, args, opts } = kubectlExec();
  const child = spawn(
    cmd,
    [...args, "-n", namespace, "port-forward", `svc/${service}`, `${localPort}:${sshPort}`],
    { windowsHide: true, ...opts, stdio: ["ignore", "pipe", "pipe"] }
  );
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`port-forward to "${service}" did not start in time`));
    }, PORT_FORWARD_TIMEOUT_MS);
    timer.unref?.();
    const onOutput = (chunk) => {
      if (settled) return;
      if (String(chunk).includes("Forwarding from")) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`port-forward failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`port-forward exited before forwarding (code ${code ?? "?"})`));
    });
  });
}

/** Map low-level SSH failures onto GUI-friendly terminal messages. */
export function describeSshError(err) {
  const firstLine = String(err?.message ?? err ?? "unknown error").split("\n")[0];
  if (/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENOTFOUND|EPIPE/i.test(firstLine)) {
    return new Error("cannot reach the project container (is it running?)");
  }
  if (/timed out|timeout/i.test(firstLine)) {
    return new Error("the project container did not answer in time (is it running?)");
  }
  if (/authentication|auth|key|password|signature|publickey/i.test(firstLine)) {
    return new Error("the container refused the connection (key not accepted)");
  }
  return new Error(`cannot open terminal: ${firstLine}`);
}

/**
 * Open an interactive shell channel with a real pty size. Resolves
 * { stream, conn }: `stream` is the ssh2 Channel (stdout as 'data',
 * stderr as stream.stderr 'data', stdin via write(), resizes via
 * setWindow(rows, cols)), `conn` the owning Client (end() to release).
 */
export function openSshShell({ host, port, username, privateKeyPath, cols, rows }) {
  return new Promise((resolve, reject) => {
    let privateKey;
    try {
      privateKey = fs.readFileSync(privateKeyPath);
    } catch (err) {
      reject(new Error(`cannot read terminal key: ${err.message}`));
      return;
    }
    const conn = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      reject(describeSshError(err));
    };
    conn.on("ready", () => {
      if (settled) return;
      conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
        if (err || !stream) {
          fail(err ?? new Error("shell channel was not accepted"));
          return;
        }
        settled = true;
        resolve({ stream, conn });
      });
    });
    conn.on("error", fail);
    conn.on("close", () => {
      fail(new Error("connection closed before the terminal session started"));
    });
    try {
      conn.connect({
        host,
        port,
        username,
        privateKey,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        keepaliveInterval: SSH_KEEPALIVE_MS,
        // Pod host keys are ephemeral (regenerated on every image build),
        // so they are never persisted — same rationale the CLI documents
        // for pointing UserKnownHostsFile at the OS null device.
        hostVerifier: () => true,
      });
    } catch (err) {
      fail(err);
    }
  });
}

/** True when the text frame body is a resize control message. */
export function parseControlMessage(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.type !== "resize") return null;
  const cols = Number.parseInt(parsed.cols, 10);
  const rows = Number.parseInt(parsed.rows, 10);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  return { cols: Math.min(cols, 1000), rows: Math.min(rows, 1000) };
}

// ------------------------------------------------------------------ upgrade ---

function failUpgrade(socket, status, message) {
  const body = `${JSON.stringify({ error: message })}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Error"}\r\n` +
      "content-type: application/json; charset=utf-8\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n\r\n" +
      body
  );
  socket.destroy();
}

/**
 * Attach the SSH terminal upgrade handler to an node:http server.
 * Non-matching upgrade paths are ignored (socket destroyed, as without a
 * listener). `hooks.loadTarget(projectId)` must resolve the SSH target or
 * throw (err.code === "NOT_FOUND" -> 404). `hooks.openShell` defaults to
 * openSshShell and exists so tests can substitute the shell transport.
 */
export function attachSshTerminal(server, hooks) {
  server.on("upgrade", (req, socket, head) => {
    void handleTerminalUpgrade(req, socket, head, hooks).catch(() => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
  });
}

async function handleTerminalUpgrade(req, socket, head, hooks) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const projectId = extractTerminalProjectId(url.pathname);
  if (projectId === null) {
    socket.destroy();
    return;
  }
  if (req.headers.upgrade === undefined || String(req.headers.upgrade).toLowerCase() !== "websocket") {
    failUpgrade(socket, 400, "websocket upgrade required");
    return;
  }
  const clientKey = req.headers["sec-websocket-key"];
  if (typeof clientKey !== "string" || !clientKey) {
    failUpgrade(socket, 400, "missing Sec-WebSocket-Key");
    return;
  }
  let authed = false;
  try {
    authed = Boolean(await hooks.isAuthenticated(req));
  } catch {
    authed = false;
  }
  if (!authed) {
    failUpgrade(socket, 401, "unauthorized");
    return;
  }
  let target;
  try {
    target = await hooks.loadTarget(projectId);
  } catch (err) {
    failUpgrade(socket, err?.code === "NOT_FOUND" ? 404 : 500, err?.message ?? "cannot open terminal");
    return;
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${computeAcceptKey(clientKey)}\r\n\r\n`
  );

  const session = {
    socket,
    shell: null,
    conn: null,
    portForward: null,
    localPort: null,
    closed: false,
    leftover: Buffer.alloc(0),
    initialCols: Number.parseInt(url.searchParams.get("cols") ?? "", 10),
    initialRows: Number.parseInt(url.searchParams.get("rows") ?? "", 10),
  };

  const closeSession = (code = 1000, reason = "") => {
    if (session.closed) return;
    session.closed = true;
    try {
      if (socket.writable) socket.write(encodeCloseFrame(code, reason));
    } catch {
      /* ignore */
    }
    try {
      session.shell?.close();
    } catch {
      /* ignore */
    }
    try {
      session.conn?.end();
    } catch {
      /* ignore */
    }
    if (session.portForward) {
      try {
        session.portForward.kill();
      } catch {
        /* ignore */
      }
    }
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  const sendOutput = (chunk) => {
    if (session.closed) return;
    try {
      socket.write(encodeFrame(OPCODE_BINARY, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    } catch {
      closeSession(1011, "failed to send output");
    }
  };

  socket.on("data", (chunk) => {
    if (session.closed) return;
    let decoded;
    try {
      decoded = decodeFrames(chunk, session.leftover);
    } catch {
      closeSession(1002, "invalid websocket frame");
      return;
    }
    session.leftover = decoded.leftover;
    for (const msg of decoded.messages) {
      if (msg.opcode === OPCODE_CLOSE) {
        closeSession(1000, "");
        return;
      }
      if (msg.opcode === OPCODE_PING) {
        try {
          socket.write(encodeFrame(OPCODE_PONG, msg.payload));
        } catch {
          closeSession(1011, "failed to send pong");
        }
        continue;
      }
      if (msg.opcode === OPCODE_PONG) continue;
      if (msg.opcode !== OPCODE_TEXT && msg.opcode !== OPCODE_BINARY) continue;
      const text = msg.payload.toString("utf8");
      const resize = parseControlMessage(text);
      if (resize) {
        // Forwarded as an SSH window-change, so the container-side pty
        // really changes size (programs querying it see the new grid).
        try {
          session.shell?.setWindow(resize.rows, resize.cols);
        } catch {
          /* session already gone; its close handler ends it */
        }
        continue;
      }
      try {
        session.shell?.write(msg.payload);
      } catch {
        /* session already gone; its close handler ends it */
      }
    }
  });
  socket.on("close", () => closeSession(1000, ""));
  socket.on("error", () => closeSession(1000, ""));

  // Past the handshake: bring up port-forward + shell channel.
  const openShell = hooks.openShell ?? openSshShell;
  try {
    session.localPort = await findFreePort();
    if (session.closed) return;
    session.portForward = await startPortForward(target, session.localPort);
    if (session.closed) {
      try {
        session.portForward.kill();
      } catch {
        /* ignore */
      }
      return;
    }
    const cols = Number.isInteger(session.initialCols) ? session.initialCols : 80;
    const rows = Number.isInteger(session.initialRows) ? session.initialRows : 24;
    const shell = await openShell({
      host: "127.0.0.1",
      port: session.localPort,
      username: target.user,
      privateKeyPath: target.privateKey,
      cols,
      rows,
    });
    if (session.closed) {
      try {
        shell.stream.close();
      } catch {
        /* ignore */
      }
      try {
        shell.conn.end();
      } catch {
        /* ignore */
      }
      return;
    }
    session.shell = shell.stream;
    session.conn = shell.conn;
    shell.stream.on("data", sendOutput);
    try {
      shell.stream.stderr?.on("data", sendOutput);
    } catch {
      /* stderr stream unavailable; stdout still flows */
    }
    shell.stream.on("close", () => {
      if (!session.closed) closeSession(1000, "");
    });
    shell.stream.on("error", () => {
      if (!session.closed) closeSession(1011, "connection lost");
    });
    shell.conn.on("error", () => {
      if (!session.closed) closeSession(1011, "connection lost");
    });
    session.portForward.on("close", () => {
      if (!session.closed) closeSession(1000, "connection lost");
    });
    session.portForward.on("error", () => {
      if (!session.closed) closeSession(1011, "connection lost");
    });
  } catch (err) {
    closeSession(1011, err?.message ?? "cannot open terminal");
  }
}
