import { useEffect, useState } from 'react';

// Time-based labels must keep expiring even when identical snapshots skip rendering.
// Tick only the mounted page that needs a clock, never the surrounding conversation.
export function useDisplayClock(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((value) => value + 1), 3000);
    return () => clearInterval(timer);
  }, [active]);
  return Date.now();
}
