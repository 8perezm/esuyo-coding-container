import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { getDesktopApi } from '../../lib/desktop';

// Custom frameless-window controls. Rendered only inside the desktop app
// (the preload script exposes window.desktop); a normal browser never
// sees these buttons.
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api) return;
    let cancelled = false;
    api
      .isMaximized()
      .then((value) => {
        if (!cancelled) setMaximized(value);
      })
      .catch(() => {
        /* stay in restore state */
      });
    const unsubscribe = api.onMaximizedChange((value) => setMaximized(value));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const api = getDesktopApi();
  if (!api) return null;

  return (
    <div className="window-controls" data-ref="window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="window-control-button"
        aria-label="Minimize window"
        title="Minimize"
        data-ref="window-minimize"
        onClick={() => api.minimize()}
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-control-button"
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        title={maximized ? 'Restore' : 'Maximize'}
        data-ref="window-toggle-maximize"
        onClick={() => api.toggleMaximize()}
      >
        {maximized ? <Copy size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="window-control-button window-control-close"
        aria-label="Close window"
        title="Close"
        data-ref="window-close"
        onClick={() => api.close()}
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
