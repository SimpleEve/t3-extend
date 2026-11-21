import { ThreadId, type PreviewOpenInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withClientBrowserRouting } from "./clientBrowserRouting.ts";

const threadId = ThreadId.make("thread-1");
const serverTab: PreviewOpenInput = { threadId, runtime: "server" };

describe("withClientBrowserRouting", () => {
  it.each(["mobile", "web", "cli"])("opens a %s client's server tab headless", (surface) => {
    expect(withClientBrowserRouting(surface, serverTab)).toEqual({ ...serverTab, headless: true });
  });

  it("leaves the desktop app's own tab for its window to draw", () => {
    expect(withClientBrowserRouting("desktop", serverTab)).toEqual(serverTab);
  });

  // An installed phone that connects with a device key reports no surface.
  it("opens a server tab headless for a client that reports no surface", () => {
    expect(withClientBrowserRouting(undefined, serverTab)).toEqual({
      ...serverTab,
      headless: true,
    });
  });

  it.each([undefined, "desktop" as const])(
    "leaves a %s-runtime tab for the desktop even from a phone",
    (runtime) => {
      const input: PreviewOpenInput = { threadId, ...(runtime === undefined ? {} : { runtime }) };
      expect(withClientBrowserRouting("mobile", input)).toEqual(input);
    },
  );
});
