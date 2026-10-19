import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClipboardPaste, Copy, Maximize2, Minimize2, Plus, RotateCcw, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import { FONT_SETTINGS_EVENT, fontCss, readFontFamily, readFontSize } from '../theme/fonts';
import {
  Button,
  Card,
  PageHeader,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../components/ui';

interface SshInfo {
  project: { id: string; name: string };
  user: string;
  namespace: string;
  service: string;
  sshPort: number;
  nodePort: number;
}

type ConnState = 'connecting' | 'open' | 'closed';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

function socketUrl(projectId: string, cols: number, rows: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ssh/${encodeURIComponent(projectId)}?cols=${cols}&rows=${rows}`;
}

function stateDotColor(state: ConnState | undefined): string {
  if (state === 'open') return 'var(--color-success, #16a34a)';
  if (state === 'closed') return 'var(--color-error, #b3261e)';
  return 'var(--color-warning, #d97706)';
}

/** Imperative controls one terminal pane exposes to the page (active tab). */
interface SessionHandle {
  reconnect: () => void;
  refit: () => void;
  copy: () => Promise<boolean>;
  paste: () => Promise<boolean>;
}

/**
 * Best-effort clipboard write that works outside secure contexts.
 * navigator.clipboard.writeText needs HTTPS/localhost + permission; the
 * textarea + execCommand fallback covers plain-HTTP LAN hosts where the
 * async API is unavailable or denied.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the execCommand fallback below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Clipboard read for toolbar/menu paste. Keyboard paste uses the paste event (no permission needed). */
async function readFromClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Decode an OSC 52 (remote copy-to-clipboard) payload: `Pc ; base64`.
 * Returns the decoded text, or null for queries, clears and junk.
 * Full-screen apps (multiplexers, editors) push their own selection this
 * way; without a handler that text never reaches the local clipboard.
 */
function decodeOsc52(data: string): string | null {
  const semi = data.indexOf(';');
  if (semi === -1) return null;
  const payload = data.slice(semi + 1).replace(/\s+/g, '');
  if (!payload || payload === '?') return null;
  if (payload.length > 1400000) return null; // ~1 MB cap against clipboard bombs
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

interface TerminalTab {
  id: string;
  title: string;
}

interface TerminalPaneProps {
  projectId: string;
  tabId: string;
  active: boolean;
  fillHeight: boolean;
  onConnChange: (tabId: string, state: ConnState, message: string | null) => void;
  registerHandle: (tabId: string, handle: SessionHandle | null) => void;
}

/**
 * One terminal session: its own xterm instance plus its own WebSocket (and
 * therefore its own server-side port-forward + SSH shell channel). Panes stay
 * mounted while hidden so background tabs keep running; only the visible pane
 * measures its container.
 */
function SshTerminalPane({
  projectId,
  tabId,
  active,
  fillHeight,
  onConnChange,
  registerHandle,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const [connState, setConnState] = useState<ConnState>('connecting');
  const [connMessage, setConnMessage] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipMsg, setClipMsg] = useState<string | null>(null);
  const [pendingRemote, setPendingRemote] = useState<string | null>(null);
  const clipTimer = useRef<number | null>(null);

  useEffect(() => {
    onConnChange(tabId, connState, connMessage);
  }, [tabId, connState, connMessage, onConnChange]);

  const showClipMsg = useCallback((message: string) => {
    setClipMsg(message);
    if (clipTimer.current !== null) window.clearTimeout(clipTimer.current);
    clipTimer.current = window.setTimeout(() => {
      setClipMsg(null);
      clipTimer.current = null;
    }, 2200);
  }, []);

  useEffect(
    () => () => {
      if (clipTimer.current !== null) window.clearTimeout(clipTimer.current);
    },
    [],
  );

  // Fit the grid to the container. Wraps the fit addon with a correction:
  // the addon's scrollbar allowance can read 0 in this layout, leaving
  // .xterm-screen wider than the viewport client area so it covers the
  // scrollbar strip and the thumb can't be grabbed. Shrink column by
  // column until the screen fits (a no-op where it already fits, e.g.
  // overlay scrollbars). Uses public APIs only.
  const fitTerminal = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) return;
    // Hidden panes (background tabs) have no size; fitting now would collapse
    // the grid to a couple of columns. Skip it — showing the tab refits.
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    const viewport = container.querySelector('.xterm-viewport');
    const screen = container.querySelector('.xterm-screen');
    if (!(viewport instanceof HTMLElement) || !(screen instanceof HTMLElement)) return;
    for (let i = 0; i < 5 && term.cols > 2; i++) {
      if (screen.getBoundingClientRect().width <= viewport.clientWidth + 1) break;
      try {
        term.resize(term.cols - 1, term.rows);
      } catch {
        break;
      }
    }
  }, []);

  // Refit the terminal to its container and tell the session about the
  // new size. Used by window resizes and full-screen switches.
  const refitAndNotify = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    fitTerminal();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {
        /* session keeps working at the previous size */
      }
    }
  }, [fitTerminal]);

  const connect = useCallback(
    (attempt: number) => {
      const container = containerRef.current;
      const term = termRef.current;
      if (!container || !term || !projectId) return;

      fitTerminal();
      const cols = term.cols || 80;
      const rows = term.rows || 24;

      setConnState('connecting');
      setConnMessage(null);

      const ws = new WebSocket(socketUrl(projectId, cols, rows));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws || attemptRef.current !== attempt) {
          ws.close();
          return;
        }
        setConnState('open');
        refitAndNotify();
      };
      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        const data = event.data;
        if (typeof data === 'string') {
          term.write(data);
        } else if (data instanceof ArrayBuffer) {
          term.write(new Uint8Array(data));
        } else if (data instanceof Blob) {
          void data
            .arrayBuffer()
            .then((buffer) => term.write(new Uint8Array(buffer)))
            .catch(() => {});
        }
      };
      ws.onclose = (event) => {
        if (wsRef.current !== ws || attemptRef.current !== attempt) return;
        wsRef.current = null;
        setConnState('closed');
        setConnMessage(
          event.reason || (event.wasClean ? 'Session ended.' : 'Connection lost.'),
        );
      };
      ws.onerror = () => {
        // onclose follows with the details; keep the state change in one place.
      };
    },
    [projectId, fitTerminal, refitAndNotify],
  );

  const reconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    termRef.current?.clear();
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    connect(attempt);
  }, [connect]);

  // Copy the current xterm selection. Uses the async clipboard API when the
  // browser grants it, otherwise falls back to a hidden textarea so plain-HTTP
  // hosts (no secure context) still work. Inside full-screen apps the app
  // itself captures the mouse, so there is no local selection unless the user
  // holds Shift while dragging (xterm force-selection bypass).
  const copySelection = useCallback(async (): Promise<boolean> => {
    const term = termRef.current;
    if (!term) return false;
    if (!term.hasSelection()) {
      showClipMsg('Nothing selected — drag to select (hold Shift inside full-screen apps)');
      return false;
    }
    const text = term.getSelection();
    const ok = await writeToClipboard(text);
    showClipMsg(
      ok ? 'Copied to clipboard' : 'Copy blocked — allow clipboard access in the browser',
    );
    return ok;
  }, [showClipMsg]);

  // Remote copy: full-screen apps push their own selection via OSC 52. OSC
  // sequences arrive without a user gesture, so the browser may deny the
  // write — in that case keep the text and let one click on the notice
  // (a real gesture) complete the copy.
  const handleRemoteCopy = useCallback(
    async (text: string): Promise<void> => {
      if (!text) return;
      const ok = await writeToClipboard(text);
      if (ok) {
        setPendingRemote(null);
        showClipMsg('Copied from the terminal app to clipboard');
      } else {
        setPendingRemote(text);
        showClipMsg('Terminal app copied — click here to save it to the clipboard');
      }
    },
    [showClipMsg],
  );

  const confirmRemoteCopy = useCallback(async (): Promise<boolean> => {
    if (!pendingRemote) return false;
    const ok = await writeToClipboard(pendingRemote);
    if (ok) {
      setPendingRemote(null);
      showClipMsg('Copied from the terminal app to clipboard');
    } else {
      showClipMsg('Copy still blocked — allow clipboard access, then press Copy');
    }
    return ok;
  }, [pendingRemote, showClipMsg]);

  // Paste from the clipboard button / context menu. Keyboard paste (Ctrl+V,
  // Ctrl+Shift+V, Cmd+V, Shift+Insert) arrives via the paste event below so
  // it never needs clipboard-read permission.
  const pasteFromClipboard = useCallback(async (): Promise<boolean> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showClipMsg('Not connected — cannot paste yet');
      return false;
    }
    const text = await readFromClipboard();
    if (text == null) {
      showClipMsg('Paste blocked — focus the terminal and press Ctrl+V');
      termRef.current?.focus();
      return false;
    }
    if (!text) return false;
    try {
      ws.send(text);
    } catch {
      showClipMsg('Paste failed — connection lost');
      return false;
    }
    termRef.current?.focus();
    return true;
  }, [showClipMsg]);

  useEffect(() => {
    registerHandle(tabId, { reconnect, refit: refitAndNotify, copy: copySelection, paste: pasteFromClipboard });
    return () => {
      registerHandle(tabId, null);
    };
  }, [tabId, reconnect, refitAndNotify, copySelection, pasteFromClipboard, registerHandle]);

  // Terminal lifecycle: create once, reconnect on demand.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !projectId) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: readFontSize('terminal'),
      fontFamily: fontCss(readFontFamily('terminal')),
      rightClickSelectsWord: true,
      theme: {
        background: '#18181b',
        foreground: '#f4f4f5',
        cursor: '#f4f4f5',
        selectionBackground: 'rgba(37, 99, 235, 0.4)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    connect(attempt);

    // Copy/paste shortcuts. Copy never needs permission-gated reads; paste
    // via the keyboard arrives as a paste event (no clipboard permission),
    // so the key handler only swallows the control code here.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key?.toLowerCase();
      if (e.key === 'Insert' && e.ctrlKey && !e.shiftKey) {
        if (!term.hasSelection()) return true;
        void copySelection();
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'c') {
        if (e.shiftKey || e.metaKey) {
          void copySelection();
          return false;
        }
        if (term.hasSelection()) {
          void copySelection();
          return false;
        }
        return true;
      }
      if (e.key === 'Insert' && e.shiftKey) return false;
      if ((e.ctrlKey || e.metaKey) && key === 'v') return false;
      return true;
    });

    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      e.preventDefault();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(text);
        } catch {
          /* onclose will surface the failure */
        }
      }
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      setMenu({
        x: Math.min(e.clientX - rect.left, Math.max(rect.width - 170, 0)),
        y: Math.min(e.clientY - rect.top, Math.max(rect.height - 90, 0)),
      });
    };
    container.addEventListener('paste', onPaste as EventListener);
    container.addEventListener('contextmenu', onContextMenu);

    // OSC 52: remote copy-to-clipboard from full-screen apps. Without this
    // the app's own "copied" notice fires but nothing reaches the local
    // clipboard (the sequence would otherwise be swallowed silently).
    const osc52 = term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data);
      if (text == null) return false;
      void handleRemoteCopy(text);
      return true;
    });

    const disposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          /* onclose will surface the failure */
        }
      }
    });

    return () => {
      attemptRef.current += 1;
      disposable.dispose();
      osc52.dispose();
      container.removeEventListener('paste', onPaste as EventListener);
      container.removeEventListener('contextmenu', onContextMenu);
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [projectId, connect, refitAndNotify, copySelection, handleRemoteCopy]);

  // Live-apply Theme page terminal font/size changes to open sessions.
  useEffect(() => {
    const onFontsChanged = () => {
      const term = termRef.current;
      if (!term) return;
      const nextFamily = fontCss(readFontFamily('terminal'));
      const nextSize = readFontSize('terminal');
      let changed = false;
      if (term.options.fontFamily !== nextFamily) {
        term.options.fontFamily = nextFamily;
        changed = true;
      }
      if (term.options.fontSize !== nextSize) {
        term.options.fontSize = nextSize;
        changed = true;
      }
      if (changed) refitAndNotify();
    };
    window.addEventListener(FONT_SETTINGS_EVENT, onFontsChanged);
    window.addEventListener('storage', onFontsChanged);
    return () => {
      window.removeEventListener(FONT_SETTINGS_EVENT, onFontsChanged);
      window.removeEventListener('storage', onFontsChanged);
    };
  }, [refitAndNotify]);

  // The container has no size while hidden, so refit once it becomes visible.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      window.setTimeout(refitAndNotify, 30);
    });
    return () => cancelAnimationFrame(raf);
  }, [active, refitAndNotify]);

  // Window resizes only affect the visible tab; hidden panes have no size.
  useEffect(() => {
    const onWindowResize = () => {
      if (activeRef.current) refitAndNotify();
    };
    window.addEventListener('resize', onWindowResize);
    return () => {
      window.removeEventListener('resize', onWindowResize);
    };
  }, [refitAndNotify]);

  return (
    <div
      ref={containerRef}
      style={
        fillHeight
          ? { flex: 1, minHeight: 0, background: '#18181b', padding: 8, position: 'relative' }
          : { height: 480, background: '#18181b', padding: 8, position: 'relative' }
      }
      data-ref="page-project-ssh-terminal"
      data-tab-id={tabId}
      onClick={() => {
        if (menu) setMenu(null);
      }}
    >
      {menu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            role="menu"
            aria-label="Terminal clipboard"
            data-ref="page-project-ssh-context-menu"
            style={{
              position: 'absolute',
              left: menu.x,
              top: menu.y,
              zIndex: 41,
              minWidth: 168,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              boxShadow: 'var(--shadow-dropdown)',
              padding: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              data-ref="page-project-ssh-context-copy"
              onClick={() => {
                setMenu(null);
                void copySelection();
              }}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                borderRadius: 6,
                fontSize: 'var(--font-size-md)',
              }}
            >
              <Copy size={14} aria-hidden="true" /> Copy selection
            </button>
            <button
              type="button"
              role="menuitem"
              data-ref="page-project-ssh-context-paste"
              onClick={() => {
                setMenu(null);
                void pasteFromClipboard();
              }}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                borderRadius: 6,
                fontSize: 'var(--font-size-md)',
              }}
            >
              <ClipboardPaste size={14} aria-hidden="true" /> Paste
            </button>
          </div>
        </>
      )}
      {clipMsg && (
        <div
          role="status"
          data-ref="page-project-ssh-clipboard-msg"
          onClick={() => {
            if (pendingRemote) void confirmRemoteCopy();
          }}
          title={pendingRemote ? 'Click to save the copied text to the clipboard' : undefined}
          style={{
            position: 'absolute',
            left: 16,
            bottom: 16,
            zIndex: 30,
            background: 'rgba(24, 24, 27, 0.92)',
            color: '#f4f4f5',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 'var(--font-size-md)',
            maxWidth: 'calc(100% - 32px)',
            cursor: pendingRemote ? 'pointer' : 'default',
          }}
        >
          {clipMsg}
        </div>
      )}
    </div>
  );
}

export function SshTerminalPage() {
  const { id } = useParams<{ id: string }>();
  const { projects, loading: projectsLoading } = useProjects();

  const fullscreenTargetRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef(new Map<string, SessionHandle>());
  const tabCounter = useRef(1);

  const [info, setInfo] = useState<SshInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [{ id: 'tab-1', title: 'Tab 1' }]);
  const [activeId, setActiveId] = useState('tab-1');
  const [tabStates, setTabStates] = useState<Record<string, { state: ConnState; message: string | null }>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copyHintOpen, setCopyHintOpen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const projectName =
    info?.project.name ?? projects.find((p) => p.id === id)?.name ?? 'Project terminal';

  // Connection summary for the header (name, namespace, user).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setInfo(null);
    setInfoError(null);
    api
      .get<SshInfo>(`/api/ssh/info?projectId=${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err) => {
        if (!cancelled) setInfoError(errMsg(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Start over with a single fresh tab when navigating between projects, so a
  // session opened for one project never follows into another. Skipped on the
  // initial mount (tabs already start fresh).
  const firstProjectRef = useRef(id);
  useEffect(() => {
    if (firstProjectRef.current === id) return;
    firstProjectRef.current = id;
    tabCounter.current = 1;
    handlesRef.current.clear();
    setTabStates({});
    setTabs([{ id: 'tab-1', title: 'Tab 1' }]);
    setActiveId('tab-1');
  }, [id]);

  const handleConnChange = useCallback((tabId: string, state: ConnState, message: string | null) => {
    setTabStates((prev) => {
      const current = prev[tabId];
      if (current && current.state === state && current.message === message) return prev;
      return { ...prev, [tabId]: { state, message } };
    });
  }, []);

  const registerHandle = useCallback((tabId: string, handle: SessionHandle | null) => {
    if (handle) handlesRef.current.set(tabId, handle);
    else handlesRef.current.delete(tabId);
  }, []);

  const addTab = useCallback(() => {
    tabCounter.current += 1;
    const n = tabCounter.current;
    const tab = { id: `tab-${n}`, title: `Tab ${n}` };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      if (tabs.length <= 1) return;
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      const remaining = tabs.filter((t) => t.id !== tabId);
      setTabs(remaining);
      setTabStates((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      handlesRef.current.delete(tabId);
      if (tabId === activeId) {
        const next = remaining[Math.min(idx, remaining.length - 1)];
        if (next) setActiveId(next.id);
      }
    },
    [tabs, activeId],
  );

  const reconnectActive = useCallback(() => {
    handlesRef.current.get(activeId)?.reconnect();
  }, [activeId]);

  const copyActive = useCallback(() => {
    void handlesRef.current.get(activeId)?.copy();
  }, [activeId]);

  const pasteActive = useCallback(() => {
    void handlesRef.current.get(activeId)?.paste();
  }, [activeId]);

  const toggleFullscreen = useCallback(async () => {
    const target = fullscreenTargetRef.current;
    if (!target) return;
    setFullscreenError(null);
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (typeof target.requestFullscreen === 'function') {
        await target.requestFullscreen();
      } else {
        setFullscreenError('Full screen is not supported in this browser.');
      }
    } catch {
      setFullscreenError('Could not switch full screen mode.');
    }
  }, []);

  // Track full-screen switches (including Escape exiting natively) and
  // refit the visible tab once the layout has settled.
  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) setFullscreenError(null);
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          handlesRef.current.get(activeIdRef.current)?.refit();
        }, 60);
      });
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  const activeState: ConnState = tabStates[activeId]?.state ?? 'connecting';
  const activeMessage: string | null = tabStates[activeId]?.message ?? null;

  if (!id) {
    return (
      <div data-ref="page-project-ssh">
        <PageHeader
          title="Project terminal"
          description="Live terminal for the project container."
          actions={
            <Link to="/projects" className="btn btn-secondary" data-ref="page-project-ssh-back">
              Back to projects
            </Link>
          }
        />
        <Card data-ref="page-project-ssh-missing-card">
          <p role="alert" style={{ margin: 0 }} data-ref="page-project-ssh-missing">
            Missing project id in URL.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div data-ref="page-project-ssh">
      <PageHeader
        title={projectName}
        description={
          info
            ? `Live terminal — signed in as ${info.user} in workspace ${info.namespace}.`
            : 'Live terminal for the project container.'
        }
        actions={
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              onClick={reconnectActive}
              disabled={activeState === 'connecting'}
              data-ref="page-project-ssh-reconnect"
              aria-label="Reconnect terminal"
            >
              <RotateCcw size={16} aria-hidden="true" />{' '}
              {activeState === 'connecting' ? 'Connecting…' : 'Reconnect'}
            </Button>
            <Link
              to={`/projects/${encodeURIComponent(id)}/edit`}
              className="btn btn-secondary"
              data-ref="page-project-ssh-back-edit"
            >
              Project settings
            </Link>
            <Link to="/projects" className="btn btn-secondary" data-ref="page-project-ssh-back">
              Back to projects
            </Link>
          </span>
        }
      />

      {(infoError || projectsLoading) && !info && (
        <Card style={{ marginBottom: 16 }} data-ref="page-project-ssh-info-card">
          {infoError ? (
            <p role="alert" style={{ margin: 0 }} data-ref="page-project-ssh-info-error">
              Could not load connection details: {infoError}
            </p>
          ) : (
            <Spinner label="Loading connection details…" />
          )}
        </Card>
      )}

      <div
        ref={fullscreenTargetRef}
        data-ref="page-project-ssh-fullscreen-target"
        style={isFullscreen ? { display: 'flex', flexDirection: 'column', height: '100%' } : undefined}
      >
      <Card
        style={
          isFullscreen
            ? {
                padding: 0,
                overflow: 'hidden',
                border: 0,
                borderRadius: 0,
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }
            : { padding: 0, overflow: 'hidden' }
        }
        data-ref="page-project-ssh-terminal-card"
      >
        <Tabs
          value={activeId}
          onValueChange={setActiveId}
          style={
            isFullscreen
              ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }
              : undefined
          }
          data-ref="page-project-ssh-tabs"
        >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: 6,
            borderBottom: '1px solid var(--gray-200)',
          }}
          data-ref="page-project-ssh-unified-bar"
        >
          <TabsList
            aria-label="Terminal sessions"
            data-ref="page-project-ssh-tablist"
            style={{
              flex: 1,
              minWidth: 0,
              gap: 6,
              padding: 2,
              background: 'transparent',
              border: 0,
              borderRadius: 0,
            }}
          >
            {tabs.map((t) => {
              const state = tabStates[t.id]?.state;
              const isActive = t.id === activeId;
              return (
                <span
                  key={t.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    flex: 'none',
                    padding: tabs.length > 1 ? '5px 6px 5px 12px' : '5px 12px',
                    border: `1px solid ${isActive ? 'var(--text-muted)' : 'var(--gray-200)'}`,
                    borderRadius: 0,
                    background: isActive ? 'var(--bg-card)' : 'transparent',
                  }}
                >
                  <TabsTrigger
                    value={t.id}
                    data-ref="page-project-ssh-tab"
                    data-tab-id={t.id}
                    title={`${t.title} — ${state ?? 'connecting'}`}
                    style={{
                      border: 0,
                      background: 'transparent',
                      padding: 0,
                      minHeight: 0,
                      borderRadius: 0,
                      boxShadow: 'none',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: stateDotColor(state),
                        flexShrink: 0,
                      }}
                    />
                    {t.title}
                    {isActive && (
                      <span
                        data-ref="page-project-ssh-status"
                        style={{ fontSize: 'var(--font-size-xs)' }}
                      >
                        ·{' '}
                        {state === 'open'
                          ? 'Connected'
                          : state === 'closed'
                            ? 'Disconnected'
                            : 'Connecting…'}
                      </span>
                    )}
                  </TabsTrigger>
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => closeTab(t.id)}
                      aria-label={`Close ${t.title}`}
                      title={`Close ${t.title}`}
                      data-ref="page-project-ssh-close-tab"
                      data-tab-id={t.id}
                      style={{
                        border: 0,
                        background: 'transparent',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: 4,
                        lineHeight: 0,
                        borderRadius: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                      }}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </span>
              );
            })}
          </TabsList>
          {activeMessage && activeState === 'closed' && (
            <span
              style={{
                fontSize: 'var(--font-size-md)',
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 260,
                flex: 'none',
              }}
              role="status"
              title={activeMessage}
              data-ref="page-project-ssh-close-message"
            >
              {activeMessage}
            </span>
          )}
          {fullscreenError && (
            <span
              style={{
                fontSize: 'var(--font-size-md)',
                color: 'var(--color-error, #b3261e)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 260,
                flex: 'none',
              }}
              role="alert"
              title={fullscreenError}
              data-ref="page-project-ssh-fullscreen-error"
            >
              {fullscreenError}
            </span>
          )}
          <span
            style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}
            data-ref="page-project-ssh-copy-wrap"
            onMouseEnter={() => setCopyHintOpen(true)}
            onMouseLeave={() => setCopyHintOpen(false)}
            onFocus={() => setCopyHintOpen(true)}
            onBlur={() => setCopyHintOpen(false)}
          >
            <Button
              variant="secondary"
              onClick={copyActive}
              data-ref="page-project-ssh-copy"
              aria-label="Copy terminal selection"
              aria-describedby="ssh-copy-hint"
              title="Copy selection (Ctrl+Shift+C, or Ctrl+C when text is selected; hold Shift to select inside full-screen apps)"
              style={{ padding: '6px 8px', flex: 'none' }}
            >
              <Copy size={16} aria-hidden="true" />
            </Button>
            {copyHintOpen && (
              <span
                role="tooltip"
                id="ssh-copy-hint"
                data-ref="page-project-ssh-clipboard-hint"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  minWidth: 220,
                  maxWidth: 300,
                  padding: '8px 10px',
                  whiteSpace: 'normal',
                  backgroundColor: 'var(--text-primary)',
                  color: 'var(--bg-card)',
                  borderRadius: 6,
                  fontSize: 'var(--font-size-xs)',
                  lineHeight: 1.5,
                  zIndex: 10,
                  pointerEvents: 'none',
                  boxShadow: 'var(--shadow-dropdown)',
                }}
              >
                Drag to select, then Copy or right-click. Inside full-screen apps hold
                Shift while dragging — otherwise the app captures the mouse and there
                is nothing to copy. Apps can also copy directly to your clipboard.
              </span>
            )}
          </span>
          <Button
            variant="secondary"
            onClick={pasteActive}
            data-ref="page-project-ssh-paste"
            aria-label="Paste into terminal"
            title="Paste (Ctrl+V or right-click > Paste)"
            style={{ padding: '6px 8px', flex: 'none' }}
          >
            <ClipboardPaste size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            onClick={addTab}
            data-ref="page-project-ssh-new-tab"
            aria-label="Open a new terminal tab"
            title="Open a new terminal tab"
            style={{ padding: '6px 8px', flex: 'none' }}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            onClick={() => void toggleFullscreen()}
            data-ref="page-project-ssh-fullscreen"
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            aria-pressed={isFullscreen}
            title={isFullscreen ? 'Exit full screen (Esc)' : 'Fill the screen with the terminal'}
            style={{ padding: '6px 8px', flex: 'none' }}
          >
            {isFullscreen ? (
              <Minimize2 size={16} aria-hidden="true" />
            ) : (
              <Maximize2 size={16} aria-hidden="true" />
            )}
          </Button>
        </div>
        {/*
          Every pane stays mounted so background tabs keep their session and
          scrollback; TabsContent hides the inactive ones. Each pane owns its
          own terminal + WebSocket, so each tab is an independent session.
        */}
          {tabs.map((t) => (
            <TabsContent
              key={t.id}
              value={t.id}
              // Flex only on the visible tab: an inline display would override
              // the `hidden` attribute that keeps background tabs out of view.
              style={
                isFullscreen && t.id === activeId
                  ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }
                  : undefined
              }
            >
              <SshTerminalPane
                projectId={id}
                tabId={t.id}
                active={t.id === activeId}
                fillHeight={isFullscreen}
                onConnChange={handleConnChange}
                registerHandle={registerHandle}
              />
            </TabsContent>
          ))}
        </Tabs>
      </Card>
      </div>
    </div>
  );
}
