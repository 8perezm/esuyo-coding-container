import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Maximize2, Minimize2, RotateCcw, SquareTerminal } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../lib/api';
import { useProjects } from '../lib/projects';
import { Badge, Button, Card, PageHeader, Spinner } from '../components/ui';

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

export function SshTerminalPage() {
  const { id } = useParams<{ id: string }>();
  const { projects, loading: projectsLoading } = useProjects();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const fullscreenTargetRef = useRef<HTMLDivElement | null>(null);

  const [info, setInfo] = useState<SshInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [connMessage, setConnMessage] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

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
  // refit once the layout has settled.
  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) setFullscreenError(null);
      requestAnimationFrame(() => {
        window.setTimeout(refitAndNotify, 60);
      });
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [refitAndNotify]);

  const connect = useCallback(
    (attempt: number) => {
      const container = containerRef.current;
      const term = termRef.current;
      if (!container || !term || !id) return;

      fitTerminal();
      const cols = term.cols || 80;
      const rows = term.rows || 24;

      setConnState('connecting');
      setConnMessage(null);

      const ws = new WebSocket(socketUrl(id, cols, rows));
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
    [id, fitTerminal, refitAndNotify],
  );

  // Terminal lifecycle: create once, reconnect on demand.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !id) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
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

    const onWindowResize = () => {
      refitAndNotify();
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      attemptRef.current += 1;
      window.removeEventListener('resize', onWindowResize);
      disposable.dispose();
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
  }, [id, connect, refitAndNotify]);

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
              onClick={reconnect}
              disabled={connState === 'connecting'}
              data-ref="page-project-ssh-reconnect"
              aria-label="Reconnect terminal"
            >
              <RotateCcw size={16} aria-hidden="true" />{' '}
              {connState === 'connecting' ? 'Connecting…' : 'Reconnect'}
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--gray-200)',
          }}
          data-ref="page-project-ssh-statusbar"
        >
          <SquareTerminal size={16} aria-hidden="true" />
          {connState === 'open' ? (
            <Badge tone="accent" data-ref="page-project-ssh-status">Connected</Badge>
          ) : connState === 'connecting' ? (
            <Badge data-ref="page-project-ssh-status">Connecting…</Badge>
          ) : (
            <Badge data-ref="page-project-ssh-status">Disconnected</Badge>
          )}
          {connMessage && connState === 'closed' && (
            <span
              style={{ fontSize: 'var(--font-size-md)', color: 'var(--text-muted)' }}
              role="status"
              data-ref="page-project-ssh-close-message"
            >
              {connMessage}
            </span>
          )}
          {fullscreenError && (
            <span
              style={{ fontSize: 'var(--font-size-md)', color: 'var(--color-error, #b3261e)' }}
              role="alert"
              data-ref="page-project-ssh-fullscreen-error"
            >
              {fullscreenError}
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
            <Button
              variant="secondary"
              onClick={() => void toggleFullscreen()}
              data-ref="page-project-ssh-fullscreen"
              aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
              aria-pressed={isFullscreen}
              title={isFullscreen ? 'Exit full screen (Esc)' : 'Fill the screen with the terminal'}
            >
              {isFullscreen ? (
                <Minimize2 size={16} aria-hidden="true" />
              ) : (
                <Maximize2 size={16} aria-hidden="true" />
              )}{' '}
              {isFullscreen ? 'Exit full screen' : 'Full screen'}
            </Button>
          </span>
        </div>
        <div
          ref={containerRef}
          style={
            isFullscreen
              ? { flex: 1, minHeight: 0, background: '#18181b', padding: 8 }
              : { height: 480, background: '#18181b', padding: 8 }
          }
          data-ref="page-project-ssh-terminal"
        />
      </Card>
      </div>
    </div>
  );
}
