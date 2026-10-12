/// <reference types="vite/client" />

interface DesktopWindowBridge {
  isDesktop: true;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
}

interface Window {
  desktop?: DesktopWindowBridge;
}
