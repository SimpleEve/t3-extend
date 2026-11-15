import { useState } from "react";

function shallowEqual(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => Object.is(value, (right as Record<string, unknown>)[key]))
  );
}

/** A derived object keeps its identity until a field changes, so a memoized child skips rebuilds. */
export function useShallowStable<T extends object>(value: T | null): T | null {
  const [stable, setStable] = useState(value);
  if (stable === value || (stable !== null && value !== null && shallowEqual(stable, value))) {
    return stable;
  }
  setStable(value);
  return value;
}
