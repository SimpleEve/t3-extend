// fork: a tab a non-desktop client opens renders in headless Chromium, never in the host desktop window.
import type { PreviewOpenInput } from "@t3tools/contracts";

/**
 * A streamed client's server tab must not go to the host's desktop window, which draws nothing
 * while the host is locked. The desktop app always sends surface "desktop"; a connection with no
 * surface (an older phone's device-key connection) is a streamed client. Agent tabs skip this RPC.
 */
export function withClientBrowserRouting<Input extends PreviewOpenInput>(
  surface: unknown,
  input: Input,
): Input & { readonly headless?: true } {
  const streamedClient = surface !== "desktop";
  return input.runtime === "server" && streamedClient ? { ...input, headless: true } : input;
}
