import { useState } from "react";

/**
 * The latest non-null `value` for `key`, kept while `value` is null, so a chip does not blink out
 * while its subscription is dropped and reopened. A new `key` starts over.
 */
export function useHeldValue<T>(key: string | null, value: T | null): T | null {
  const [held, setHeld] = useState<{ readonly key: string | null; readonly value: T | null }>({
    key,
    value,
  });
  if (held.key !== key) {
    setHeld({ key, value });
    return value;
  }
  if (value !== null && held.value !== value) setHeld({ key, value });
  return value ?? held.value;
}
