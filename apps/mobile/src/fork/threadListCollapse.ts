// fork: the stored fold list of the thread list's project view.

/**
 * Fold keys are never pruned by looking at projects, because an environment that is offline has
 * none loaded and its folds would be lost. The newest folds win instead, which also ages out the
 * keys of deleted projects.
 */
export const MAX_COLLAPSED_GROUPS = 200;

export function newestCollapsedKeys(collapsed: readonly string[]): string[] {
  return collapsed.slice(-MAX_COLLAPSED_GROUPS);
}

export function toggleCollapsedKey(collapsed: readonly string[], key: string): string[] {
  return collapsed.includes(key)
    ? collapsed.filter((candidate) => candidate !== key)
    : newestCollapsedKeys([...collapsed, key]);
}

/** Sets a key to the fold state the user chose, whatever the stored list had. */
export function setCollapsedKey(
  collapsed: readonly string[],
  key: string,
  folded: boolean,
): string[] {
  const without = collapsed.filter((candidate) => candidate !== key);
  return folded ? newestCollapsedKeys([...without, key]) : without;
}
