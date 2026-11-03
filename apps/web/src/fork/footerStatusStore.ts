import { create } from "zustand";

// fork: per-device switches for the sidebar footer status chips and the desktop keep-awake guard.
// Kept out of ClientSettings so contracts stay upstream's.
const STORAGE_KEY = "t3extend:footer-status:v1";

const FOOTER_STATUS_KEYS = ["limits", "resources", "ports", "keepAwake"] as const;
export type FooterStatusKey = (typeof FOOTER_STATUS_KEYS)[number];
export type FooterStatusToggles = Readonly<Record<FooterStatusKey, boolean>>;

const DEFAULT_TOGGLES: FooterStatusToggles = {
  limits: true,
  resources: true,
  ports: true,
  keepAwake: true,
};

/** Anything unreadable falls back to on, so a bad entry never hides a feature for good. */
export function parseFooterStatusToggles(raw: string | null): FooterStatusToggles {
  if (raw === null) return DEFAULT_TOGGLES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_TOGGLES;
    const record = parsed as Record<string, unknown>;
    const read = (key: FooterStatusKey) =>
      typeof record[key] === "boolean" ? record[key] : DEFAULT_TOGGLES[key];
    return {
      limits: read("limits"),
      resources: read("resources"),
      ports: read("ports"),
      keepAwake: read("keepAwake"),
    };
  } catch {
    return DEFAULT_TOGGLES;
  }
}

function readPersisted(): FooterStatusToggles {
  try {
    return parseFooterStatusToggles(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_TOGGLES;
  }
}

function persist(state: FooterStatusToggles) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

const useFooterStatusStore = create<FooterStatusToggles>(() =>
  typeof window === "undefined" ? DEFAULT_TOGGLES : readPersisted(),
);

export function useFooterStatusToggle(key: FooterStatusKey): boolean {
  return useFooterStatusStore((state) => state[key]);
}

export function setFooterStatusToggle(key: FooterStatusKey, enabled: boolean) {
  if (useFooterStatusStore.getState()[key] === enabled) return;
  useFooterStatusStore.setState({ [key]: enabled });
  persist(useFooterStatusStore.getState());
}
