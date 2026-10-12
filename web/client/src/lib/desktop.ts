export interface DesktopWindowApi {
  isDesktop: true;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
}

export function getDesktopApi(): DesktopWindowApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { desktop?: DesktopWindowApi }).desktop;
  return api?.isDesktop === true ? api : null;
}

export function isDesktopApp(): boolean {
  return getDesktopApi() !== null;
}
