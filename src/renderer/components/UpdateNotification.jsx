import { useEffect, useState } from 'react';

const STATUS_LABELS = {
  checking: 'Checking for updates…',
  available: 'Update available',
  'not-available': 'You’re up to date',
  progress: 'Downloading update…',
  downloaded: 'Update ready to install',
  error: 'Update error',
};

export default function UpdateNotification({ updater }) {
  const { status, info, check, download, install } = updater;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (status === 'available' || status === 'downloaded') {
      setDismissed(false);
    }
  }, [status]);

  if (!status) return null;
  if (dismissed && status !== 'downloaded') return null;

  const label = STATUS_LABELS[status] || status;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-edge bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink">
        {status === 'progress' && (
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-hover">
            <div
              className="h-full bg-danger transition-all duration-200"
              style={{ width: `${info.percent || 0}%` }}
            />
          </div>
        )}
        <span className="truncate">
          {label}
          {info.version && <span className="ml-1 text-ink-dim">{info.version}</span>}
          {status === 'progress' && info.percent !== undefined && (
            <span className="ml-1 text-ink-dim">{info.percent}%</span>
          )}
          {status === 'error' && info.message && (
            <span className="ml-1 text-danger">{info.message}</span>
          )}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {status === 'available' && (
          <button
            type="button"
            onClick={download}
            className="rounded bg-danger px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-danger/90"
          >
            Download
          </button>
        )}
        {status === 'downloaded' && (
          <button
            type="button"
            onClick={install}
            className="rounded bg-danger px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-danger/90"
          >
            Install & Restart
          </button>
        )}
        {(status === 'not-available' || status === 'error') && (
          <button
            type="button"
            onClick={check}
            className="rounded border border-edge bg-hover/40 px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-hover"
          >
            Check again
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-[12px] text-ink-dim hover:text-white"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
