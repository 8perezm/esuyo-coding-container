"use strict";
// Desktop shell for the coding-container web GUI.
//
// The GUI server (web/server/server.js) and the CLI (src/index.js) run
// exactly as they do under plain Node: this process launches the bundled
// server on a loopback port and shows it in a window. It only adds what a
// desktop install needs:
//
//   - first-run sign-in setup (email + password, stored encrypted with the
//     OS keychain via Electron safeStorage)
//   - automatic sign-in on launch (stays signed in until sign-out)
//   - startup warnings when external tools are missing
//   - auto-updates for packaged builds (skipped for Store packages)

const { app, BrowserWindow, dialog, ipcMain, session, safeStorage, Menu } = require("electron");
const { utilityProcess } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const { spawnSync } = require("node:child_process");

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  // Optional: dev checkouts without installed dependencies.
}

const SESSION_COOKIE = "gui_session";
const HEALTH_TIMEOUT_MS = 20000;
const HEALTH_INTERVAL_MS = 250;
const CREDENTIALS_FILE = "credentials.enc";

const isDev = !app.isPackaged;
// Dev: this file lives in <repo>/electron, the app root is the repo root.
// Packaged: this file lives at the app root inside the install folder.
const APP_ROOT = isDev ? path.resolve(__dirname, "..") : app.getAppPath();
const SERVER_ENTRY = path.join(APP_ROOT, "web", "server", "server.js");

let mainWindow = null;
let setupWindow = null;
let serverChild = null;
let quitting = false;

// ------------------------------------------------------------ user data ---

function userFiles() {
  const dir = app.getPath("userData");
  return {
    dir,
    credsPath: path.join(dir, CREDENTIALS_FILE),
  };
}

// ----------------------------------------------- encrypted credentials ---

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function weakBackend() {
  // Linux without a keyring falls back to a hardcoded key ("basic_text"):
  // still obfuscated, but not OS-keychain protected.
  try {
    return (
      process.platform === "linux" &&
      typeof safeStorage.getSelectedStorageBackend === "function" &&
      safeStorage.getSelectedStorageBackend() === "basic_text"
    );
  } catch {
    return false;
  }
}

function loadCredentials(credsPath) {
  try {
    if (!fs.existsSync(credsPath) || !encryptionAvailable()) return null;
    const raw = fs.readFileSync(credsPath, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(raw, "base64")));
    if (
      typeof parsed?.email !== "string" ||
      !parsed.email ||
      typeof parsed?.password !== "string" ||
      parsed.password.length < 8
    ) {
      return null;
    }
    return { email: parsed.email, password: parsed.password };
  } catch {
    return null;
  }
}

function saveCredentials(credsPath, email, password) {
  if (!encryptionAvailable()) return false;
  const err = validateCredentials(email, password);
  if (err) return false;
  try {
    fs.mkdirSync(path.dirname(credsPath), { recursive: true });
    const sealed = safeStorage.encryptString(JSON.stringify({ email, password }));
    fs.writeFileSync(credsPath, sealed.toString("base64"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function clearCredentials(credsPath) {
  try {
    fs.unlinkSync(credsPath);
  } catch {
    // Already gone.
  }
}

function validateCredentials(email, password) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return "Enter a valid email address.";
  }
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  return null;
}

// ----------------------------------------------- projects registry ---
// The server owns the projects registry: it defaults to a store next to the
// global config (shared by every GUI on this machine), migrates the legacy
// dev registry once, and seeds a starter project when empty. The desktop app
// passes no PROJECTS_FILE override, so both stay on the same store.

// ------------------------------------------------------- binary check ---

function commandExists(cmd) {
  try {
    if (process.platform === "win32") {
      return spawnSync("where", [cmd], { windowsHide: true, timeout: 8000 }).status === 0;
    }
    return (
      spawnSync("sh", ["-c", `command -v ${cmd}`], { timeout: 8000 }).status === 0
    );
  } catch {
    return false;
  }
}

// GUI-visible copy: tool names and what they are needed for, no commands.
const REQUIRED_TOOLS = [
  { cmd: "docker", label: "Docker", why: "needed to build and publish images" },
  { cmd: "kubectl", label: "Kubernetes access (kubectl)", why: "needed to deploy and inspect workloads" },
  { cmd: "ssh-keygen", label: "SSH key generator (ssh-keygen)", why: "needed to create connection keys" },
];

function checkRequiredTools() {
  return REQUIRED_TOOLS.filter((tool) => !commandExists(tool.cmd));
}

async function warnMissingTools(missing) {
  const lines = missing.map((tool) => `- ${tool.label} — ${tool.why}.`);
  await dialog.showMessageBox({
    type: "warning",
    title: "Esuyo Coding Container",
    message:
      missing.length === REQUIRED_TOOLS.length
        ? "Required tools were not found on this computer"
        : "Some tools were not found on this computer",
    detail:
      `${lines.join("\n")}\n\nInstall the missing tools, then restart the app. ` +
      `The dashboard will still open, but affected pages will show errors until then.`,
    buttons: ["Continue"],
    defaultId: 0,
  });
}

// ------------------------------------------------------------- server ---

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function startServer({ port, email, password }) {
  // No ELECTRON_RUN_AS_NODE here: the fork must start as a normal utility
  // process (with the flag it rejects the runtime's internal flags and exits
  // at once). server-launcher.mjs sets the flag in-child, where it only
  // affects the CLI job processes it spawns.
  // No PROJECTS_FILE either: the server defaults to the shared store next
  // to the global config, which is what keeps every GUI on the same data.
  const env = {
    ...process.env,
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
    PORT: String(port),
  };
  // Persist the dashboard output: GUI apps have no visible console, so
  // without this a startup failure leaves nothing to diagnose.
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "gui-server.log");
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  logStream.write(`\n--- dashboard started ${new Date().toISOString()} ---\n`);
  const child = utilityProcess.fork(path.join(__dirname, "server-launcher.mjs"), [SERVER_ENTRY], {
    env,
    serviceName: "gui-server",
    stdio: "pipe",
  });
  const pipe = (chunk) => {
    process.stdout.write(`[gui] ${chunk}`);
    logStream.write(chunk);
  };
  if (child.stdout) child.stdout.on("data", pipe);
  if (child.stderr) child.stderr.on("data", pipe);
  child.on("exit", (code) => {
    logStream.end();
    if (!quitting && code !== 0) {
      dialog.showErrorBox(
        "Esuyo Coding Container",
        `The dashboard stopped unexpectedly (exit code ${code ?? "?"}). ` +
          `Details were saved to ${logFile}. Restart the app to try again.`
      );
      app.quit();
    }
  });
  child.on("error", () => logStream.end());
  return child;
}

function fetchHealth(baseUrl) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (await fetchHealth(baseUrl)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
}

// Sign in with the stored account and seed the window's session cookie, so
// launch lands on the dashboard instead of the sign-in page. Best effort:
// any failure just falls through to the manual sign-in page.
async function seedLoginCookie(baseUrl, email, password) {
  const payload = JSON.stringify({ email, password });
  const token = await new Promise((resolve) => {
    const req = http.request(
      `${baseUrl}/api/login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode !== 200) return resolve(null);
        const cookies = res.headers["set-cookie"] ?? [];
        const match = cookies
          .map((line) => line.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`)))
          .find(Boolean);
        resolve(match ? match[1] : null);
      }
    );
    req.once("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
    req.end(payload);
  });
  if (!token) return false;
  try {
    await session.defaultSession.cookies.set({
      url: baseUrl,
      name: SESSION_COOKIE,
      value: decodeURIComponent(token),
      httpOnly: true,
      sameSite: "lax",
    });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ windows ---

function broadcastMaximized() {
  try {
    mainWindow?.webContents.send("desktop:window-maximized", mainWindow.isMaximized());
  } catch {
    // Window gone.
  }
}

function registerWindowControls() {
  ipcMain.handle("desktop:window-is-maximized", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.isMaximized() : false;
  });
  ipcMain.on("desktop:window-minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on("desktop:window-toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("desktop:window-close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function createMainWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Esuyo Coding Container",
    // Frameless: the native title bar and menu are removed. Window
    // controls (minimize / maximize / close) live in the web UI header
    // and talk back over the desktop:window-* IPC channels.
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("maximize", broadcastMaximized);
  mainWindow.on("unmaximize", broadcastMaximized);
  mainWindow.loadURL(baseUrl);
}

function showSetupWindow() {
  return new Promise((resolve) => {
    setupWindow = new BrowserWindow({
      width: 460,
      height: 600,
      resizable: false,
      title: "Esuyo Coding Container",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler("desktop:save-setup");
      try {
        setupWindow?.close();
      } catch {
        // Already closed.
      }
      setupWindow = null;
      resolve(value);
    };
    setupWindow.on("closed", () => finish(null));
    setupWindow.loadFile(path.join(__dirname, "setup.html"));
    // Plain handle (not once): a validation failure returns an error and
    // the form can be submitted again.
    ipcMain.handle("desktop:save-setup", (_event, { email, password } = {}) => {
      const err = validateCredentials(email, password);
      if (err) return { ok: false, error: err };
      finish({ email: String(email).trim(), password });
      return { ok: true };
    });
  });
}

// ---------------------------------------------------------------- app ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function registerAuthSync(credsPath) {
  // The web UI is unchanged: the preload script observes its own sign-in,
  // password-change and sign-out requests and reports them here so the
  // encrypted copy stays in sync.
  ipcMain.on("desktop:auth-login", (_event, { email, password } = {}) => {
    if (!validateCredentials(email, password)) saveCredentials(credsPath, String(email).trim(), password);
  });
  ipcMain.on("desktop:auth-password-changed", (_event, { password } = {}) => {
    const current = loadCredentials(credsPath);
    if (current && typeof password === "string" && password.length >= 8) {
      saveCredentials(credsPath, current.email, password);
    }
  });
  ipcMain.on("desktop:auth-logged-out", () => {
    // Signed out on purpose: forget the account so the next launch asks
    // for sign-in again instead of signing straight back in.
    clearCredentials(credsPath);
  });
}

app.whenReady().then(async () => {
  const { credsPath } = userFiles();
  try {
    Menu.setApplicationMenu(null);
  } catch {
    // No menu to clear.
  }
  registerAuthSync(credsPath);
  registerWindowControls();

  const missing = checkRequiredTools();
  if (missing.length > 0) await warnMissingTools(missing);

  if (!encryptionAvailable()) {
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "Esuyo Coding Container",
      message: "Secure storage is unavailable",
      detail:
        "This computer could not provide encrypted storage, so your sign-in cannot be kept safely. " +
        "Continue without staying signed in, or quit and try again.",
      buttons: ["Quit", "Continue"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 0) {
      app.quit();
      return;
    }
  } else if (weakBackend()) {
    await dialog.showMessageBox({
      type: "warning",
      title: "Esuyo Coding Container",
      message: "Sign-in will be stored with reduced protection",
      detail:
        "No system keyring was found, so your sign-in can only be lightly protected on this computer. " +
        "Consider installing a keyring (for example gnome-keyring) for stronger protection.",
      buttons: ["Continue"],
      defaultId: 0,
    });
  }

  let credentials = loadCredentials(credsPath);
  if (!credentials) {
    const created = await showSetupWindow().catch(() => null);
    if (!created) {
      app.quit();
      return;
    }
    saveCredentials(credsPath, created.email, created.password);
    credentials = created;
  }

  let port;
  try {
    port = await getFreePort();
  } catch {
    dialog.showErrorBox("Esuyo Coding Container", "Could not find a free local port. Restart the app to try again.");
    app.quit();
    return;
  }
  const baseUrl = `http://127.0.0.1:${port}`;

  if (!fs.existsSync(SERVER_ENTRY)) {
    dialog.showErrorBox(
      "Esuyo Coding Container",
      `The dashboard files were not found (${SERVER_ENTRY}). Reinstall the app to repair it.`
    );
    app.quit();
    return;
  }
  serverChild = startServer({
    port,
    email: credentials.email,
    password: credentials.password,
  });

  if (!(await waitForHealth(baseUrl))) {
    dialog.showErrorBox(
      "Esuyo Coding Container",
      "The dashboard did not start in time. Check the app logs and restart to try again."
    );
    app.quit();
    return;
  }

  // If the stored sign-in no longer matches (for example it was changed in
  // another browser), this quietly fails and the sign-in page appears.
  await seedLoginCookie(baseUrl, credentials.email, credentials.password);

  createMainWindow(baseUrl);

  if (autoUpdater && app.isPackaged && !process.windowsStore) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // Offline or no releases yet: stay on the current version.
    });
  }
}).catch(() => {
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  try {
    serverChild?.kill();
  } catch {
    // Already gone.
  }
});
