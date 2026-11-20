import { create } from "zustand";

import type { ThemeAppearance } from "../../themePalette";

export type ThemeEditorSessionInput = {
  editingThemeId: string | null;
  seedThemeId: string | null;
  seedName: string | null;
  initialAppearance: ThemeAppearance;
};

export type ThemeEditorSession = ThemeEditorSessionInput & {
  id: number;
};

type ThemeEditorStore = {
  session: ThemeEditorSession | null;
  openThemeEditor: (session: ThemeEditorSessionInput) => void;
  closeThemeEditor: () => void;
};

let nextSessionId = 0;

export const useThemeEditorStore = create<ThemeEditorStore>((set) => ({
  session: null,
  openThemeEditor: (session) => set({ session: { ...session, id: ++nextSessionId } }),
  closeThemeEditor: () => set({ session: null }),
}));
