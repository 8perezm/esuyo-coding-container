import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import {
  attachSshTerminal,
  computeAcceptKey,
  decodeFrames,
  encodeCloseFrame,
  encodeFrame,
  extractTerminalProjectId,
  openSshShell,
  parseControlMessage,
} from "./ssh-terminal.js";
import { createServer } from "./server.js";

const { Server: SshServer } = ssh2;

// ------------------------------------------------------------- unit: routing ---

test("extractTerminalProjectId: only /api/ssh/<id>", () => {
  assert.equal(extractTerminalProjectId("/api/ssh/ecca359d-13e4-4579-9f45-93eb7839dde0"), "ecca359d-13e4-4579-9f45-93eb7839dde0");
  assert.equal(extractTerminalProjectId("/api/ssh/abc"), "abc");
  assert.equal(extractTerminalProjectId("/api/ssh/a%20b"), "a b");
  assert.equal(extractTerminalProjectId("/api/ssh/info"), null);
  assert.equal(extractTerminalProjectId("/api/ssh-list"), null);
  assert.equal(extractTerminalProjectId("/api/ssh/"), null);
  assert.equal(extractTerminalProjectId("/api/ssh/a/b"), null);
  assert.equal(extractTerminalProjectId("/api/other"), null);
  assert.equal(extractTerminalProjectId("/"), null);
  assert.equal(extractTerminalProjectId(null), null);
});

test("computeAcceptKey: RFC 6455 example", () => {
  assert.equal(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("parseControlMessage: resize only, validated", () => {
  assert.deepEqual(parseControlMessage('{"type":"resize","cols":120,"rows":40}'), { cols: 120, rows: 40 });
  assert.equal(parseControlMessage("ls -la\n"), null);
  assert.equal(parseControlMessage("not json"), null);
  assert.equal(parseControlMessage('{"type":"other"}'), null);
  assert.equal(parseControlMessage('{"type":"resize","cols":0,"rows":5}'), null);
  assert.equal(parseControlMessage('{"type":"resize","cols":"wide","rows":5}'), null);
});

// --------------------------------------------------------------- unit: codec ---

/** Hand-built masked client frame (payloads < 126 bytes). */
function maskedFrame(opcode, payload, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const out = Buffer.alloc(2 + 4 + data.length);
  out[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  out[1] = 0x80 | data.length;
  mask.copy(out, 2);
  for (let i = 0; i < data.length; i++) out[6 + i] = data[i] ^ mask[i % 4];
  return out;
}

test("codec: RFC 6455 masked 'Hello' decodes", () => {
  const raw = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  const { messages, leftover } = decodeFrames(raw);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].opcode, 0x1);
  assert.equal(messages[0].payload.toString(), "Hello");
  assert.equal(leftover.length, 0);
});

test("codec: server frame round-trips through the decoder", () => {
  for (const opcode of [0x1, 0x2]) {
    const payload = Buffer.from("output-\u00e9-\n");
    const { messages } = decodeFrames(encodeFrame(opcode, payload));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].opcode, opcode);
    assert.deepEqual(messages[0].payload, payload);
  }
});

test("codec: 16-bit extended length", () => {
  const payload = Buffer.alloc(200, "a");
  const { messages } = decodeFrames(encodeFrame(0x2, payload));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].payload, payload);
});

test("codec: TCP fragmentation across chunks reassembles", () => {
  const full = maskedFrame(0x1, "split-payload");
  const cut = 5;
  const first = decodeFrames(full.subarray(0, cut));
  assert.equal(first.messages.length, 0);
  const second = decodeFrames(full.subarray(cut), first.leftover);
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].payload.toString(), "split-payload");
  assert.equal(second.leftover.length, 0);
});

test("codec: websocket continuations reassemble", () => {
  const full = Buffer.concat([maskedFrame(0x1, "he", false), maskedFrame(0x0, "llo")]);
  const { messages } = decodeFrames(full);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].opcode, 0x1);
  assert.equal(messages[0].payload.toString(), "hello");
});

test("codec: ping surfaces as a control message; close encodes", () => {
  const { messages } = decodeFrames(maskedFrame(0x9, "ping"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].opcode, 0x9);
  const close = encodeCloseFrame(1000, "bye");
  assert.equal(close[0], 0x88);
});

// ------------------------------------------------------- integration: upgrade ---

function readHandshake(socket) {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const onData = (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      const idx = acc.indexOf("\r\n\r\n");
      if (idx !== -1) {
        socket.off("data", onData);
        resolve({ head: acc.subarray(0, idx).toString("latin1"), rest: acc.subarray(idx + 4) });
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

function upgradeRequest(target, key = "dGhlIHNhbXBsZSBub25jZQ==") {
  return (
    `GET ${target} HTTP/1.1\r\n` +
    `Host: localhost\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n\r\n`
  );
}

async function startStubServer({ authed = true, loadTarget = null, openShell = null } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}\n");
  });
  attachSshTerminal(server, {
    isAuthenticated: () => authed,
    loadTarget: loadTarget ?? (async () => { throw new Error("no stub"); }),
    ...(openShell ? { openShell } : {}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

test("upgrade: unauthenticated websocket gets a 401, not a 101", async () => {
  const { server, port } = await startStubServer({ authed: false });
  try {
    const socket = net.connect(port, "127.0.0.1");
    socket.write(upgradeRequest("/api/ssh/p1"));
    const { head } = await readHandshake(socket);
    assert.match(head, /^HTTP\/1\.1 401 /m);
    socket.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upgrade: unknown project gets a 404, not a 101", async () => {
  const { server, port } = await startStubServer({
    loadTarget: async () => { throw Object.assign(new Error("unknown project: nope"), { code: "NOT_FOUND" }); },
  });
  try {
    const socket = net.connect(port, "127.0.0.1");
    socket.write(upgradeRequest("/api/ssh/nope"));
    const { head } = await readHandshake(socket);
    assert.match(head, /^HTTP\/1\.1 404 /m);
    socket.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upgrade: non-terminal paths are ignored (socket closes, no 101)", async () => {
  const { server, port } = await startStubServer();
  try {
    const socket = net.connect(port, "127.0.0.1");
    socket.write(upgradeRequest("/something-else"));
    const closed = await new Promise((resolve) => {
      let sawData = false;
      socket.on("data", () => { sawData = true; });
      socket.on("close", () => resolve({ sawData }));
      setTimeout(() => resolve({ sawData, timedOut: true }), 3000);
    });
    assert.equal(closed.sawData, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** In-memory shell transport: records writes + resizes, echoes input. */
function makeFakeShell() {
  const stream = new EventEmitter();
  const state = { received: [], setWindowCalls: [], closed: false };
  stream.write = (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    state.received.push(text);
    setImmediate(() => stream.emit("data", Buffer.from(`ECHO:${text}`)));
    return true;
  };
  stream.setWindow = (rows, cols) => {
    state.setWindowCalls.push({ rows, cols });
  };
  stream.close = () => {
    state.closed = true;
    stream.emit("close");
  };
  const conn = new EventEmitter();
  conn.end = () => {};
  return { stream, conn, state };
}

test("session: shell transport bridges bytes, resizes become window-changes", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-sshsess-"));
  const prevKubectl = process.env.KUBECTL_BIN;
  fs.writeFileSync(
    path.join(tmp, "kubectl-stub.js"),
    'process.stdout.write("Forwarding from 127.0.0.1:9999 -> 22\\n");\nsetInterval(() => {}, 1000);\n'
  );
  process.env.KUBECTL_BIN = path.join(tmp, "kubectl-stub.js");

  let fake = null;
  const { server, port } = await startStubServer({
    loadTarget: async () => ({
      name: "demo",
      namespace: "coding",
      service: "demo",
      sshPort: 22,
      user: "root",
      privateKey: path.join(tmp, "key"),
    }),
    openShell: async () => {
      fake = makeFakeShell();
      setImmediate(() => fake.stream.emit("data", Buffer.from("FAKE-READY\n")));
      return { stream: fake.stream, conn: fake.conn };
    },
  });
  t.after(async () => {
    if (prevKubectl === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = prevKubectl;
    await new Promise((resolve) => server.close(resolve));
  });

  const socket = net.connect(port, "127.0.0.1");
  t.after(() => { try { socket.destroy(); } catch { /* ignore */ } });
  socket.write(upgradeRequest("/api/ssh/demo?cols=80&rows=24"));
  const { head, rest } = await readHandshake(socket);
  assert.match(head, /^HTTP\/1\.1 101 /m);
  assert.match(head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/m);

  let acc = Buffer.alloc(0);
  let leftover = Buffer.alloc(0);
  let output = "";
  const waitFor = (needle, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      if (output.includes(needle)) return resolve();
      const timer = setTimeout(() => {
        socket.off("data", onData);
        reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(output)}`));
      }, timeoutMs);
      const onData = (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        const decoded = decodeFrames(chunk, leftover);
        leftover = decoded.leftover;
        for (const msg of decoded.messages) {
          if (msg.opcode === 0x2 || msg.opcode === 0x1) output += msg.payload.toString("utf8");
        }
        if (output.includes(needle)) {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve();
        }
      };
      socket.on("data", onData);
    });
  // Any frame bytes that arrived with the handshake belong to the session.
  if (rest.length) {
    const decoded = decodeFrames(rest, leftover);
    leftover = decoded.leftover;
    for (const msg of decoded.messages) {
      if (msg.opcode === 0x2 || msg.opcode === 0x1) output += msg.payload.toString("utf8");
    }
  }

  await waitFor("FAKE-READY");
  socket.write(maskedFrame(0x1, "hello\n"));
  await waitFor("ECHO:hello");

  // Resize control messages become SSH window-changes, never shell input.
  socket.write(maskedFrame(0x1, JSON.stringify({ type: "resize", cols: 100, rows: 30 })));
  socket.write(maskedFrame(0x1, "ping\n"));
  await waitFor("ECHO:ping");
  assert.ok(!output.includes("resize"), `resize must not reach the session; got ${JSON.stringify(output)}`);
  assert.deepEqual(fake.state.setWindowCalls, [{ rows: 30, cols: 100 }]);

  // Client close ends the session (socket closes, shell released).
  socket.write(maskedFrame(0x8, ""));
  await new Promise((resolve) => socket.on("close", resolve));
  assert.equal(fake.state.closed, true);
});

function streamTextUntil(stream, needle, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let acc = "";
    const timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(acc)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      acc += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (acc.includes(needle)) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve(acc);
      }
    };
    stream.on("data", onData);
  });
}

function waitForCondition(fn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = fn();
      } catch {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("pty: shell opens with a real non-zero size and resizes propagate", async (t) => {
  // Regression test: the previous `ssh`-binary transport never sent an SSH
  // window-change, so the container-side pty stayed 0x0 and programs
  // querying the terminal size refused to start ("zero-sized grid").
  const hostKey = crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" });
  const observed = { pty: null, windowChanges: [] };
  const sshServer = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty, reject, info) => {
          observed.pty = { term: info.term, cols: info.cols, rows: info.rows };
          acceptPty();
        });
        session.on("window-change", (acceptWin, reject, info) => {
          observed.windowChanges.push({ cols: info.cols, rows: info.rows });
          // Window-changes are sent fire-and-forget (no reply wanted), so
          // there is usually nothing to accept.
          if (typeof acceptWin === "function") acceptWin();
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("PTY-READY\n");
          stream.on("data", (d) => stream.write(`ECHO:${d}`));
        });
      });
    });
  });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  const sshPort = sshServer.address().port;
  let clientConn = null;
  t.after(async () => {
    // Ordered explicitly: end the client connection first so the server
    // close below never waits on it (after-hook order is not relied on).
    try {
      clientConn?.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => sshServer.close(resolve));
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-sshpty-"));
  const keyFile = path.join(tmp, "id_rsa");
  fs.writeFileSync(
    keyFile,
    crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" })
  );

  const { stream, conn } = await openSshShell({
    host: "127.0.0.1",
    port: sshPort,
    username: "root",
    privateKeyPath: keyFile,
    cols: 100,
    rows: 30,
  });
  clientConn = conn;

  await streamTextUntil(stream, "PTY-READY");
  // The server must see the requested size — never a zero-sized grid.
  assert.ok(observed.pty, "server must receive a pty request");
  assert.equal(observed.pty.term, "xterm-256color");
  assert.deepEqual({ cols: observed.pty.cols, rows: observed.pty.rows }, { cols: 100, rows: 30 });

  stream.write("hello\n");
  await streamTextUntil(stream, "ECHO:hello");

  stream.setWindow(40, 120);
  await waitForCondition(() => observed.windowChanges.length > 0);
  assert.deepEqual(observed.windowChanges.at(-1), { cols: 120, rows: 40 });
  conn.end();
});

// ------------------------------------------------------- http: /api/ssh/info ---

test("http: /api/ssh/info is gated and reports the saved-config target", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-sshinfo-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  try {
    const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
    fs.mkdirSync(path.join(globalDir, "keys"), { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.yaml"),
      "image:\n  registry: registry.example.com\nnfs:\n  server: nas.local\n  basePath: /data\n"
    );
    // Pre-created key pair so no ssh-keygen binary is needed.
    fs.writeFileSync(path.join(globalDir, "keys", "id_ed25519"), "dummy-private");
    fs.writeFileSync(path.join(globalDir, "keys", "id_ed25519.pub"), "dummy-public");
    const configPath = path.join(tmp, "config.yaml");
    fs.writeFileSync(configPath, "project: demo\n");
    const projectsFile = path.join(tmp, "projects.json");
    fs.writeFileSync(projectsFile, JSON.stringify([{ id: "p1", name: "demo", configPath }]));

    const env = {
      adminEmail: "admin@example.com",
      adminPassword: "s3cret",
      port: 0,
      projectsFile,
      allowedOrigin: "",
    };
    const server = createServer(env);
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/api/ssh/info?projectId=p1`)).status, 401);

      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

      let r = await fetch(`${base}/api/ssh/info`, { headers: { cookie } });
      assert.equal(r.status, 400);

      r = await fetch(`${base}/api/ssh/info?projectId=nope`, { headers: { cookie } });
      assert.equal(r.status, 404);

      r = await fetch(`${base}/api/ssh/info?projectId=p1`, { headers: { cookie } });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.deepEqual(body.project, { id: "p1", name: "demo" });
      assert.equal(body.namespace, "coding");
      assert.equal(body.service, "demo");
      assert.equal(body.user, "root");
      assert.equal(typeof body.sshPort, "number");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("wiring: real server upgrades an authenticated session into a live terminal", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gui-sshwire-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevKubectl = process.env.KUBECTL_BIN;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
  // Port-forward reports success, but nothing actually listens on the picked
  // port, so the shell dial fails like it would against a stopped project.
  fs.writeFileSync(
    path.join(tmp, "kubectl-stub.js"),
    'process.stdout.write("Forwarding from 127.0.0.1:9999 -> 22\\n");\nsetInterval(() => {}, 1000);\n'
  );
  process.env.KUBECTL_BIN = path.join(tmp, "kubectl-stub.js");
  t.after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevKubectl === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = prevKubectl;
  });

  const globalDir = path.join(process.env.XDG_CONFIG_HOME, "coding-container");
  fs.mkdirSync(path.join(globalDir, "keys"), { recursive: true });
  fs.writeFileSync(
    path.join(globalDir, "config.yaml"),
    "image:\n  registry: registry.example.com\nnfs:\n  server: nas.local\n  basePath: /data\n"
  );
  // A real (but useless) key: the dial must reach TCP and fail there, so the
  // test observes the unreachable-container message, not a key parse error.
  fs.writeFileSync(
    path.join(globalDir, "keys", "id_ed25519"),
    crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" })
  );
  fs.writeFileSync(path.join(globalDir, "keys", "id_ed25519.pub"), "dummy-public");
  const configPath = path.join(tmp, "config.yaml");
  fs.writeFileSync(configPath, "project: demo\n");
  const projectsFile = path.join(tmp, "projects.json");
  fs.writeFileSync(projectsFile, JSON.stringify([{ id: "p1", name: "demo", configPath }]));

  const server = createServer({
    adminEmail: "admin@example.com",
    adminPassword: "s3cret",
    port: 0,
    projectsFile,
    allowedOrigin: "",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // No session cookie -> the upgrade is rejected before any handshake.
  {
    const socket = net.connect(port, "127.0.0.1");
    socket.write(upgradeRequest("/api/ssh/p1"));
    const { head } = await readHandshake(socket);
    assert.match(head, /^HTTP\/1\.1 401 /m);
    socket.destroy();
  }

  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "s3cret" }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /gui_session=/);

  const socket = net.connect(port, "127.0.0.1");
  t.after(() => { try { socket.destroy(); } catch { /* ignore */ } });
  socket.write(
    upgradeRequest("/api/ssh/p1?cols=80&rows=24").replace("\r\n\r\n", `\r\nCookie: ${cookie}\r\n\r\n`)
  );
  const { head, rest } = await readHandshake(socket);
  assert.match(head, /^HTTP\/1\.1 101 /m);

  let output = "";
  let leftover = Buffer.alloc(0);
  if (rest.length) {
    const decoded = decodeFrames(rest, leftover);
    leftover = decoded.leftover;
    for (const msg of decoded.messages) output += msg.payload.toString("utf8");
  }
  const waitFor = (needle, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      if (output.includes(needle)) return resolve();
      const timer = setTimeout(() => {
        socket.off("data", onData);
        reject(new Error(`timed out waiting for ${JSON.stringify(needle)}`));
      }, timeoutMs);
      const onData = (chunk) => {
        const decoded = decodeFrames(chunk, leftover);
        leftover = decoded.leftover;
        for (const msg of decoded.messages) output += msg.payload.toString("utf8");
        if (output.includes(needle)) {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve();
        }
      };
      socket.on("data", onData);
    });

  await waitFor("cannot reach the project container");
  await new Promise((resolve) => socket.on("close", resolve));
});
