import { useEffect, useState } from 'react';

// The banner that shows up along the top of the app when there's news about
// app updates — for example "A new version is available" with a Download
// button, similar to the update banners you sometimes see at the top of a
// web browser.

// Translates the short internal status codes (like "checking" or
// "downloaded") into the friendly sentences actually shown to the user.
const STATUS_LABELS = {
  checking: 'Checking for updates…',
  available: 'Update available',
  'not-available': 'You’re up to date',
  progress: 'Downloading update…',
  downloaded: 'Update downloaded — restarting to install…',
  error: 'Update error',
};

export default function UpdateNotification({ updater }) {
  // "updater" comes from the useUpdater hook and contains the current
  // status/info plus the three actions (check/download/install).
  const { status, info, check, download, install } = updater;
  // Whether the user has manually closed ("dismissed") this banner.
  const [dismissed, setDismissed] = useState(false);

  // If the status changes to "an update is ready to download" or "an
  // update is ready to install," automatically un-dismiss the banner so
  // the user doesn't miss it, even if they'd dismissed an earlier, less
  // important message (like "checking for updates").
  useEffect(() => {
    if (status === 'available' || status === 'downloaded') {
      setDismissed(false);
    }
  }, [status]);

  // Nothing to show if there's no status yet, or if the user dismissed it
  // (unless it's the "downloaded" status, which we always want to keep
  // showing since it's important — the user needs to know an install is
  // ready and waiting).
  if (!status) return null;
  if (dismissed && status !== 'downloaded') return null;

  const label = STATUS_LABELS[status] || status;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-edge bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink">
        {/* While downloading, show a small progress bar that fills up as
            the download percentage increases. */}
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

      {/* Show a different action button depending on where we are in the
          update process: "Update & Restart" once an update is found (one
          click downloads it, then the app restarts itself automatically),
          "Install & Restart" as a manual fallback if the automatic restart
          didn't happen, or "Check again" if the check failed or found
          nothing new. */}
      <div className="flex shrink-0 items-center gap-2">
        {status === 'available' && (
          <button
            type="button"
            onClick={download}
            className="rounded bg-danger px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-danger/90"
          >
            Update & Restart
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
