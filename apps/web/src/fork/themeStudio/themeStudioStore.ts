import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";

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
