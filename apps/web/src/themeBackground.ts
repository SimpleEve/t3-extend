import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry, subscribeAtomChanges } from "./rpc/atomRegistry";
import { assetEnvironment } from "./state/assets";
import { themeEnvironmentIdAtom } from "./state/primaryEnvironment";
import { themeServerEnvironmentThemesAtom } from "./state/server";
import { environmentSession } from "./state/session";

const THEME_BACKGROUND_VARIABLE = "--theme-background-image";
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

let shownKey: string | null = null;
let loading: AbortController | null = null;
let objectUrl: string | null = null;
// fork: what was last asked for, so coming back online can ask again for exactly that
let requested: { themeId: string | undefined; hash: string | undefined } = {
  themeId: undefined,
  hash: undefined,
};
// fork: the last image downloaded. A preview that is left again must not download a large image twice.
let lastLoaded: { key: string; image: Blob } | null = null;

function show(nextUrl: string | null): void {
  const root = document.documentElement;
  if (nextUrl === null) root.style.removeProperty(THEME_BACKGROUND_VARIABLE);
  else root.style.setProperty(THEME_BACKGROUND_VARIABLE, `url("${nextUrl}")`);
  if (nextUrl === null) delete root.dataset.themeBackground; // fork: theme look
  else root.dataset.themeBackground = ""; // fork: theme look
  if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  objectUrl = nextUrl;
}

async function loadBackground(
  environmentId: EnvironmentId,
  resource: AssetResource, // fork: a stored image is asked for by its hash
  signal: AbortSignal,
): Promise<Blob | null> {
  const minted = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource },
    }),
    { label: "theme background", reportFailure: false, refresh: true, signal },
  );
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (minted._tag !== "Success" || connection._tag === "None") return null;
  const url = resolveAssetUrl(connection.value.httpBaseUrl, minted.value.relativeUrl);
  if (url === null) return null;
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const image = await response.blob();
  return image.type.startsWith("image/") ? image : null;
}

const storedKey = (environmentId: EnvironmentId, hash: string) =>
  JSON.stringify([environmentId, "stored", hash]);

/** fork: the picture the theme studio stored under `hash`, for its thumbnail. */
export async function loadStoredThemeBackground(
  hash: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  if (environmentId === null) return null;
  const key = storedKey(environmentId, hash);
  if (lastLoaded?.key === key) return lastLoaded.image;
  const image = await loadBackground(
    environmentId,
    { _tag: "theme-background-image", hash },
    signal,
  );
  if (image !== null) lastLoaded = { key, image };
  return image;
}

/**
 * Sets `--theme-background-image` to the image the theme asks for, or clears it. A look's stored
 * image (`hash`) wins over the image published beside `themeId`.
 * The image is copied into a blob URL once per revision, so the signed URL may expire.
 */
export function applyThemeBackground(themeId: string | undefined, hash?: string): void {
  if (typeof document === "undefined") return;
  requested = { themeId, hash };
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  const revision =
    hash !== undefined
      ? hash
      : themeId === undefined
        ? undefined
        : appAtomRegistry
            .get(themeServerEnvironmentThemesAtom)
            ?.find((theme) => theme.id === themeId)?.background;
  const key =
    environmentId === null || revision === undefined
      ? null
      : hash !== undefined
        ? storedKey(environmentId, hash)
        : JSON.stringify([environmentId, themeId, revision]);
  if (key === shownKey) return;
  shownKey = key;
  loading?.abort();
  loading = null;
  // The previous image must not show under the next theme while it loads.
  show(null);
  const resource: AssetResource | null =
    hash !== undefined
      ? { _tag: "theme-background-image", hash }
      : themeId === undefined
        ? null
        : { _tag: "environment-theme-background", themeId };
  if (environmentId === null || key === null || resource === null) return;
  if (lastLoaded?.key === key) {
    show(URL.createObjectURL(lastLoaded.image));
    return;
  }
  const controller = new AbortController();
  loading = controller;
  let retries = 0;
  const failed = () => {
    if (controller.signal.aborted) return;
    const delay = RETRY_DELAYS_MS[retries++];
    if (delay !== undefined) {
      // Transient HTTP failures may never produce a browser online event.
      const timer = setTimeout(load, delay);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      return;
    }
    loading = null;
    // Lets the next repaint or `online` event try again.
    shownKey = null;
  };
  const load = () => {
    loadBackground(environmentId, resource, controller.signal).then((image) => {
      if (controller.signal.aborted) return;
      if (image === null) failed();
      else {
        loading = null;
        lastLoaded = { key, image };
        show(URL.createObjectURL(image));
      }
    }, failed);
  };
  load();
}

/**
 * A new image revision does not change the palette, so it does not repaint the theme.
 * Coming back online retries a download that failed; a shown image is left alone.
 */
export function startThemeBackground(): () => void {
  const reapply = () => applyThemeBackground(requested.themeId, requested.hash);
  const unsubscribe = subscribeAtomChanges(themeServerEnvironmentThemesAtom, reapply);
  window.addEventListener("online", reapply);
  return () => {
    unsubscribe();
    window.removeEventListener("online", reapply);
    loading?.abort();
    loading = null;
    shownKey = null;
    lastLoaded = null;
    show(null);
  };
}
