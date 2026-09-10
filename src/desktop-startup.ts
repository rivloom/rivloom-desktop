import { useEffect, useRef } from 'react';
import { confirmDesktopStartup, desktop } from './desktop';

/** Backup cleanup requires a rendered, authenticated workspace and healthy runtime. */
export function useDesktopStartup(ready: boolean) {
  const complete = useRef(false);
  const pending = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    if (!desktop || !ready || complete.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const confirm = async () => {
      const request = pending.current ??= confirmDesktopStartup();
      try { if (await request === true) complete.current = true; }
      catch { /* Keep backups and retry a busy native operation or locked files. */ }
      finally { if (pending.current === request) pending.current = null; }
      if (!stopped && !complete.current) timer = setTimeout(() => void confirm(), 60_000);
    };
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => void confirm()); });
    return () => { stopped = true; cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [ready]);
}
