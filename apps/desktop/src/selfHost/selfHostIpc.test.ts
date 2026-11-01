import { describe, expect, it } from "vite-plus/test";

import { isMainRendererSender } from "./selfHostIpc.ts";

const APPLICATION_URL = "t3x://app/";
const mainFrame = { url: "t3x://app/settings/connections" };
const main = { id: 1, mainFrame };
const event = (senderId: number, senderFrame: unknown) => ({
  sender: { id: senderId },
  senderFrame,
});

describe("isMainRendererSender", () => {
  it("accepts only the main window's top frame showing the app", () => {
    const allows = (input: Partial<Parameters<typeof isMainRendererSender>[0]>) =>
      isMainRendererSender({
        event: event(1, mainFrame),
        main,
        applicationUrl: APPLICATION_URL,
        ...input,
      });

    expect(allows({})).toBe(true);
    expect(allows({ event: event(2, mainFrame) })).toBe(false);
    expect(allows({ event: event(1, { url: mainFrame.url }) })).toBe(false);
    expect(allows({ event: { sender: { id: 1 } } })).toBe(false);
    expect(allows({ event: undefined })).toBe(false);
    expect(allows({ main: undefined })).toBe(false);
    const navigatedAway = { url: "https://evil.example/" };
    expect(
      allows({ event: event(1, navigatedAway), main: { id: 1, mainFrame: navigatedAway } }),
    ).toBe(false);
    expect(allows({ applicationUrl: "t3x-dev://app/" })).toBe(false);
  });
});
