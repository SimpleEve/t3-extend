// fork: who may see a computer and sign in to it. Mirrors `isVisibleTo` and `normalizeVisibility` in
// registry/db.mjs; the computer applies it to its own saved setting, the registry to what it was told.
export type VisibilityMode =
  | "visible_to_all"
  | "hidden_from_all"
  | "hidden_from_selected"
  | "visible_to_selected";

export interface Visibility {
  readonly mode: VisibilityMode;
  readonly deviceIds: ReadonlyArray<string>;
}

export const DEFAULT_VISIBILITY: Visibility = { mode: "visible_to_all", deviceIds: [] };

/** Unique, sorted, and empty for the two modes that name no devices. */
export const normalizeVisibility = (visibility: Visibility): Visibility => {
  const selected =
    visibility.mode === "hidden_from_selected" || visibility.mode === "visible_to_selected";
  return {
    mode: visibility.mode,
    deviceIds: selected ? [...new Set(visibility.deviceIds)].sort() : [],
  };
};

export const sameVisibility = (a: Visibility, b: Visibility): boolean => {
  const left = normalizeVisibility(a);
  const right = normalizeVisibility(b);
  return left.mode === right.mode && left.deviceIds.join("\n") === right.deviceIds.join("\n");
};

/** Whether `deviceId` may see this computer and sign in to it. */
export const isVisibleTo = (visibility: Visibility, deviceId: string): boolean => {
  switch (visibility.mode) {
    case "hidden_from_all":
      return false;
    case "hidden_from_selected":
      return !visibility.deviceIds.includes(deviceId);
    case "visible_to_selected":
      return visibility.deviceIds.includes(deviceId);
    case "visible_to_all":
      return true;
  }
};
