import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";

import type { ThemeDefinition } from "../../themePalette";

// fork: asks the studio page to open on a theme. The theme library's Edit, Duplicate and Create
// buttons, and the command palette, all land in the studio instead of a second editor.

export type ThemeStudioIntent = Readonly<{
  /** The theme to show; null keeps the one in use. */
  themeId: string | null;
  /** Start a copy of `themeId` instead of showing it. */
  duplicate: boolean;
  /** The copy's name. */
  name: string | null;
}>;

type ThemeStudioIntentStore = {
  intent: ThemeStudioIntent | null;
  request: (intent: ThemeStudioIntent | null) => void;
  take: () => ThemeStudioIntent | null;
};

export const useThemeStudioIntent = create<ThemeStudioIntentStore>((set, get) => ({
  intent: null,
  request: (intent) => set({ intent }),
  take: () => {
    const { intent } = get();
    if (intent !== null) set({ intent: null });
    return intent;
  },
}));

type ThemeStudioDraftStore = {
  /** The scheme being edited and not saved yet. */
  draft: ThemeDefinition | null;
  /** The draft is a copy someone asked for, worth saving before it differs from its original. */
  explicitCopy: boolean;
  setDraft: (
    update: ThemeDefinition | null | ((current: ThemeDefinition | null) => ThemeDefinition | null),
  ) => void;
  setExplicitCopy: (explicitCopy: boolean) => void;
};

/**
 * The draft outlives the page: leaving the studio for Appearance and coming back shows it again
 * with its unsaved changes. Revert, Apply and choosing another scheme clear it.
 */
export const useThemeStudioDraft = create<ThemeStudioDraftStore>((set) => ({
  draft: null,
  explicitCopy: false,
  setDraft: (update) =>
    set((state) => ({ draft: typeof update === "function" ? update(state.draft) : update })),
  setExplicitCopy: (explicitCopy) => set({ explicitCopy }),
}));

/** What the theme library's editor buttons used to open, as a studio intent. */
export function intentFromEditorSession(session: {
  editingThemeId: string | null;
  seedThemeId: string | null;
  seedName: string | null;
}): ThemeStudioIntent {
  if (session.editingThemeId !== null) {
    return { themeId: session.editingThemeId, duplicate: false, name: null };
  }
  return { themeId: session.seedThemeId, duplicate: true, name: session.seedName };
}

export function useOpenThemeStudio(): (intent?: ThemeStudioIntent) => void {
  const navigate = useNavigate();
  return (intent) => {
    useThemeStudioIntent.getState().request(intent ?? null);
    void navigate({ to: "/settings/theme" });
  };
}
