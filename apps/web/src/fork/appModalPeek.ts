import { create } from "zustand";

// fork: lets a feature on a Settings page look at the app behind the Settings modal. The modal
// is hidden, not unmounted, so drafts, focus and scroll positions stay where they were.

type AppModalPeek = {
  peeking: boolean;
  setPeeking: (peeking: boolean) => void;
};

export const useAppModalPeek = create<AppModalPeek>((set) => ({
  peeking: false,
  setPeeking: (peeking) => set({ peeking }),
}));
