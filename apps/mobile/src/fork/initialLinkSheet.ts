import type { NavigationState, PartialState } from "@react-navigation/native";
import { CommonActions } from "@react-navigation/native";
import { Platform } from "react-native";

import { rootNavigationRef, whenRootNavigationReady } from "../lib/rootNavigation";

type LinkState = PartialState<NavigationState>;
type LinkRoute = LinkState["routes"][number];

/** Splits a link's top root route off when it is a sheet, leaving the routes under it. */
export function splitInitialLinkSheet(
  state: LinkState | undefined,
  isSheet: (name: string) => boolean,
): { readonly state: LinkState | undefined; readonly sheet?: LinkRoute } {
  const sheet = state?.routes.at(-1);
  if (!state || !sheet || state.routes.length < 2 || !isSheet(sheet.name)) return { state };
  const routes = state.routes.slice(0, -1);
  return { state: { ...state, index: routes.length - 1, routes }, sheet };
}

let markSplashHidden: () => void = () => {};
const splashHidden = new Promise<void>((resolve) => {
  markSplashHidden = resolve;
});

/** Called once the native splash screen no longer holds the first draw. */
export function splashScreenHidden(): void {
  markSplashHidden();
}

/**
 * Android's splash screen blocks the window's draws, and a form sheet presented meanwhile settles
 * below the screen. So the state a cold-start link opens leaves its sheet out, and the sheet is
 * navigated to once the splash screen is gone. Later links navigate normally.
 */
export function deferInitialLinkSheet(
  state: LinkState | undefined,
  isSheet: (name: string) => boolean,
): LinkState | undefined {
  if (Platform.OS !== "android" || rootNavigationRef.isReady()) return state;
  const { state: rest, sheet } = splitInitialLinkSheet(state, isSheet);
  if (sheet) {
    void splashHidden.then(() =>
      whenRootNavigationReady(() =>
        rootNavigationRef.dispatch(
          CommonActions.navigate({ name: sheet.name, params: sheet.params }),
        ),
      ),
    );
  }
  return rest;
}
