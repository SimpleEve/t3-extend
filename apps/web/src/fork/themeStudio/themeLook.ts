import type { ThemeLook } from "@t3tools/contracts";
import {
  THEME_LOOK_VARIABLES,
  themeLookCssVariables,
  themeLooksEqual,
} from "@t3tools/shared/forkThemeLook";

// fork: writes a theme's look onto the document. Fonts and chat width are not set here: they
// have a user setting of their own, so appInit asks for the active look and decides which wins.

let activeLook: ThemeLook | undefined;
const listeners = new Set<() => void>();

export function getActiveThemeLook(): ThemeLook | undefined {
  return activeLook;
}

export function subscribeToThemeLook(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Static: only custom properties and one attribute change, nothing animates. */
export function applyThemeLook(look: ThemeLook | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const variables = themeLookCssVariables(look);
  for (const name of THEME_LOOK_VARIABLES) {
    const value = variables[name];
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  if (look?.glass) root.dataset.themeGlass = "";
  else delete root.dataset.themeGlass;

  if (themeLooksEqual(activeLook, look)) return;
  activeLook = look;
  for (const listener of listeners) listener();
}
