import type { EnvironmentId, PromptShortcut } from "@t3tools/contracts";
import { create } from "zustand";

export interface PromptShortcutEditorTarget {
  readonly environmentId: EnvironmentId;
  /** The shortcut being edited; null creates one. */
  readonly shortcut: PromptShortcut | null;
  /** Prefilled content for a new shortcut. */
  readonly content?: string;
  /** Lets `@` find files while the content is written. */
  readonly cwd?: string | undefined;
}

export const usePromptShortcutEditorStore = create<{
  target: PromptShortcutEditorTarget | null;
}>(() => ({ target: null }));

export function openPromptShortcutEditor(target: PromptShortcutEditorTarget) {
  usePromptShortcutEditorStore.setState({ target });
}

export function closePromptShortcutEditor() {
  usePromptShortcutEditorStore.setState({ target: null });
}
