import { useEffect, useRef } from "react";

// Runs `tick` every `intervalMs` while `active` is true. `tick` returning true
// (or throwing) stops the loop. Cleans up on unmount / when active flips off.
export function usePolling(
  active: boolean,
  intervalMs: number,
  tick: () => Promise<boolean | void> | boolean | void,
) {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const run = async () => {
      if (stopped) return;
      try {
        const done = await tickRef.current();
        if (done) {
          stopped = true;
          if (timer) clearInterval(timer);
        }
      } catch {
        stopped = true;
        if (timer) clearInterval(timer);
      }
    };

    void run();
    timer = setInterval(() => void run(), intervalMs);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [active, intervalMs]);
}
