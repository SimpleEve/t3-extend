export type OutputFileActionId = "preview" | "browser" | "open" | "reveal" | "copy";
export type OutputLinkActionId = "preview" | "external" | "copy";

/**
 * Open and reveal act on the machine the server runs on, so only the desktop app's own server is
 * the user's machine. A remote server's file manager would open on a computer they cannot see.
 */
export function isUsersOwnMachine(input: {
  readonly isElectron: boolean;
  readonly environmentId: string | null;
  readonly hostEnvironmentId: string | null;
}): boolean {
  return (
    input.isElectron &&
    input.environmentId !== null &&
    input.environmentId === input.hostEnvironmentId
  );
}

/**
 * What a file's menu offers, in order. Preview needs a path the server may read; browser hands an
 * HTML or PDF file to the desktop's default browser, wherever the server runs.
 */
export function outputFileActionIds(input: {
  readonly inWorkspace: boolean;
  readonly canOpenInSystemBrowser: boolean;
  readonly onThisMachine: boolean;
  readonly hasFileManager: boolean;
  readonly canReveal: boolean;
}): OutputFileActionId[] {
  const local = input.onThisMachine && input.hasFileManager;
  return [
    ...(input.inWorkspace ? (["preview"] as const) : []),
    ...(input.canOpenInSystemBrowser ? (["browser"] as const) : []),
    ...(local ? (["open"] as const) : []),
    ...(local && input.canReveal ? (["reveal"] as const) : []),
    "copy",
  ];
}

export function outputLinkActionIds(input: {
  readonly canPreviewLinks: boolean;
}): OutputLinkActionId[] {
  return [...(input.canPreviewLinks ? (["preview"] as const) : []), "external", "copy"];
}

/** What a click does: the first action that is not a copy, so a row and its menu agree. */
export function primaryOutputAction<T extends string>(ids: ReadonlyArray<T>): T | null {
  return ids.find((id) => id !== "copy") ?? null;
}
