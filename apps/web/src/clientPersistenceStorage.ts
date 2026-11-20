import {
  ClientSettingsSchema,
  migrateLegacyUiLanguage, // fork: legacy interface language
  type ClientSettings,
} from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

// fork: settings saved before the fork adopted `language` carry `uiLanguage`; rewrite them once.
function migrateStoredUiLanguage(): void {
  try {
    const raw = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    if (raw === null || !raw.includes('"uiLanguage"')) return;
    const migrated = migrateLegacyUiLanguage(JSON.parse(raw));
    window.localStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
  } catch {
    // Unreadable settings decode to defaults below, as before.
  }
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }
  migrateStoredUiLanguage(); // fork: legacy interface language

  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

/** Storage events fire only for other tabs' writes; a null key means storage was cleared. */
export function subscribeBrowserClientSettingsWrites(onChange: () => void): () => void {
  if (!hasWindow()) {
    return () => undefined;
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CLIENT_SETTINGS_STORAGE_KEY || event.key === null) {
      onChange();
    }
  };
  const target = window;
  target.addEventListener("storage", handleStorage);
  return () => target.removeEventListener("storage", handleStorage);
}
