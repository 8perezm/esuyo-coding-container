import { useEffect, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { getDesktopApi, type DesktopUpdateStatus } from '../../lib/desktop';
import { getUpdateNotice } from '../../lib/update-notice';

// Bottom-left sidebar line, desktop app only. Appears when the main
// process reports a newer release: selecting it installs the downloaded
// update, or opens the download location when it still has to be fetched.
export function DesktopUpdateNotice() {
  const [status, setStatus] = useState<DesktopUpdateStatus>({ state: 'unknown' });
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api) return;
    setIsDesktop(true);
    const unsubscribe = api.onUpdateStatus((next) => {
      if (next && typeof next.state === 'string') setStatus(next);
    });
    api.checkForUpdates().catch(() => {
      // Offline or no releases yet: stay quiet.
    });
    return unsubscribe;
  }, []);

  if (!isDesktop) return null;
  const notice = getUpdateNotice(status);
  if (!notice.visible) return null;

  const onSelect = () => {
    const api = getDesktopApi();
    if (!api) return;
    if (notice.action === 'install') api.installUpdate();
    else api.openDownloadPage();
  };

  return (
    <div className="update-notice" data-ref="update-notice">
      <button
        type="button"
        className="update-notice-button"
        onClick={onSelect}
        data-ref="update-notice-button"
        title={notice.action === 'install' ? 'Restart now to install the update' : 'Open the download location'}
      >
        <ArrowDownToLine size={16} aria-hidden="true" />
        <span>{notice.label}</span>
      </button>
    </div>
  );
}
