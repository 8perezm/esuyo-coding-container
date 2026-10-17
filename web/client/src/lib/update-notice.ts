import type { DesktopUpdateStatus } from './desktop';

export type UpdateNoticeAction = 'install' | 'download';

export interface UpdateNotice {
  visible: boolean;
  label: string;
  action: UpdateNoticeAction;
}

// Decides what the sidebar update line shows. Hidden until the desktop
// shell reports an update; "ready" means it is downloaded and only needs
// a restart, "available" means it still has to be fetched.
export function getUpdateNotice(status: DesktopUpdateStatus | null | undefined): UpdateNotice {
  if (!status || status.state === 'unknown' || status.state === 'checking' || status.state === 'none') {
    return { visible: false, label: '', action: 'download' };
  }
  const version = typeof status.version === 'string' && status.version ? ` ${status.version}` : '';
  if (status.state === 'ready') {
    return { visible: true, label: `Update${version} ready — restart to install`, action: 'install' };
  }
  return { visible: true, label: `Update${version} available`, action: 'download' };
}
