import { useSyncExternalStore } from "react";
import { msUntilRelativeTimeChange, relativeTime } from "../lib/time";

// The React Compiler caches inline relativeTime calls on the timestamp alone.
export function useRelativeTime(timestamp: string) {
  const t = useT(); // fork: i18n
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delayMs = msUntilRelativeTimeChange(timestamp);
      if (delayMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const getSnapshot = () => relativeTime(timestamp, undefined, t);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function RelativeTime(props: { timestamp: string }) {
  return useRelativeTime(props.timestamp);
}
