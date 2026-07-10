import { useEffect, useState } from 'react';

export function useUpdater() {
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState({});

  useEffect(() => {
    if (!window.updater) return undefined;

    const unsubscribe = window.updater.onStatus((payload) => {
      setStatus(payload.status);
      setInfo(payload);
    });

    return unsubscribe;
  }, []);

  const check = () => {
    if (window.updater) window.updater.check();
  };

  const download = () => {
    if (window.updater) window.updater.download();
  };

  const install = () => {
    if (window.updater) window.updater.install();
  };

  return { status, info, check, download, install };
}
