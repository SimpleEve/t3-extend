// fork: a tab a non-desktop client opens renders in headless Chromium, never in the host desktop window.
import type { PreviewOpenInput } from "@t3tools/contracts";

/**
 * A phone or browser client views a server tab through the preview stream. If the host's own
 * desktop window took the tab instead, a locked or sleeping host would draw no frame at all.
 * Only the desktop app (surface "desktop") has a window that can show the tab itself; agent
 * tabs open through ServerBrowser, not this RPC, so they are never marked here.
 */
export function withClientBrowserRouting<Input extends PreviewOpenInput>(
  surface: unknown,
  input: Input,
): Input & { readonly headless?: true } {
  const streamedClient = typeof surface === "string" && surface !== "desktop";
  return input.runtime === "server" && streamedClient ? { ...input, headless: true } : input;
}
