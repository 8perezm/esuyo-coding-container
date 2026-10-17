"use strict";
// Runs in the window before the web UI loads (context isolation on, no Node
// access for the page itself).
//
// Two jobs:
//   1. Tag every /api request so the server knows it is the desktop app
//      (long-lived session). Browsers never send this header.
//   2. Watch the page's own sign-in / password-change / sign-out requests and
//      report them to the main process, so the encrypted stored sign-in
//      stays in sync. The server and the web UI are unchanged.

const { contextBridge, ipcRenderer } = require("electron");

const DESKTOP_HEADER = "X-Esuyo-Desktop";

const AUTH_PATHS = new Set(["/api/login", "/api/register", "/api/logout", "/api/change-password"]);

function pathnameOf(input) {
  try {
    if (typeof input === "string") return new URL(input, window.location.href).pathname;
    if (input instanceof Request) return new URL(input.url, window.location.href).pathname;
    if (input instanceof URL) return input.pathname;
  } catch {
    // Not a parseable URL: not ours.
  }
  return "";
}

function methodOf(input, init) {
  const method =
    (init && init.method) || (input instanceof Request && input.method) || "GET";
  return String(method).toUpperCase();
}

async function requestPayload(input, init) {
  try {
    let raw = init && init.body;
    if (raw === undefined && input instanceof Request) raw = await input.clone().text();
    if (typeof raw !== "string" || !raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function reportAuthRequest(pathname, payload) {
  try {
    if (pathname === "/api/logout") {
      ipcRenderer.send("desktop:auth-logged-out");
    } else if (
      (pathname === "/api/login" || pathname === "/api/register") &&
      payload &&
      typeof payload.email === "string" &&
      typeof payload.password === "string"
    ) {
      ipcRenderer.send("desktop:auth-login", {
        email: payload.email,
        password: payload.password,
      });
    } else if (
      pathname === "/api/change-password" &&
      payload &&
      typeof payload.newPassword === "string"
    ) {
      ipcRenderer.send("desktop:auth-password-changed", { password: payload.newPassword });
    }
  } catch {
    // Sync is best effort; never disturb the page.
  }
}

if (typeof window.fetch === "function") {
  const originalFetch = window.fetch.bind(window);
  const withDesktopHeader = (input, init) => {
    try {
      if (!pathnameOf(input).startsWith("/api/")) return [input, init];
      const base = init?.headers ?? (input instanceof Request ? input.headers : {});
      const headers = new Headers(base);
      headers.set(DESKTOP_HEADER, "1");
      return [input, { ...(init ?? {}), headers }];
    } catch {
      return [input, init];
    }
  };
  window.fetch = async function desktopFetch(input, init) {
    const [markedInput, markedInit] = withDesktopHeader(input, init);
    const response = await originalFetch(markedInput, markedInit);
    try {
      const pathname = pathnameOf(input);
      if (AUTH_PATHS.has(pathname) && methodOf(input, init) === "POST" && response.ok) {
        reportAuthRequest(pathname, await requestPayload(input, init));
      }
    } catch {
      // Never disturb the page.
    }
    return response;
  };
}

// Frameless window controls for the main window. Only present inside the
// desktop app: in a normal browser this bridge never loads, so the web UI
// checks `window.desktop?.isDesktop` before showing the buttons.
contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  minimize: () => ipcRenderer.send("desktop:window-minimize"),
  toggleMaximize: () => ipcRenderer.send("desktop:window-toggle-maximize"),
  close: () => ipcRenderer.send("desktop:window-close"),
  isMaximized: () => ipcRenderer.invoke("desktop:window-is-maximized"),
  onMaximizedChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on("desktop:window-maximized", listener);
    return () => ipcRenderer.removeListener("desktop:window-maximized", listener);
  },
  checkForUpdates: () => ipcRenderer.invoke("desktop:update-check"),
  installUpdate: () => ipcRenderer.send("desktop:update-install"),
  openDownloadPage: () => ipcRenderer.send("desktop:open-download-page"),
  onUpdateStatus: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("desktop:update-status", listener);
    return () => ipcRenderer.removeListener("desktop:update-status", listener);
  },
});
