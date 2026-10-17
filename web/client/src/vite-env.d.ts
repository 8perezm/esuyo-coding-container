/// <reference types="vite/client" />

interface DesktopUpdateStatus {
  state: 'unknown' | 'checking' | 'none' | 'available' | 'ready';
  version?: string | null;
}

interface DesktopWindowBridge {
  isDesktop: true;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  checkForUpdates: () => Promise<{ ok: boolean }>;
  installUpdate: () => void;
  openDownloadPage: () => void;
  onUpdateStatus: (callback: (status: DesktopUpdateStatus) => void) => () => void;
}

interface Window {
  desktop?: DesktopWindowBridge;
}
