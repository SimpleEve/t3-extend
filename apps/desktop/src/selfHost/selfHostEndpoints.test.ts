import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import { describe, expect, it } from "vite-plus/test";

import { selfHostAdvertisedEndpoints } from "./selfHostEndpoints.ts";

describe("selfHostAdvertisedEndpoints", () => {
  it("adds saved public addresses as pairing endpoints without duplicating existing ones", () => {
    const existing = createAdvertisedEndpoint({
      id: "manual:https://existing.example.com/",
      label: "existing.example.com",
      provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
      httpBaseUrl: "https://existing.example.com",
      reachability: "public",
      source: "user",
    });

    expect(
      selfHostAdvertisedEndpoints({
        publicUrls: ["https://existing.example.com/", "https://t3.example.com/"],
        existing: [existing],
      }),
    ).toEqual([
      createAdvertisedEndpoint({
        id: "self-host:https://t3.example.com/",
        label: "t3.example.com",
        provider: { id: "self-host", label: "Public address", kind: "manual", isAddon: false },
        httpBaseUrl: "https://t3.example.com/",
        reachability: "public",
        source: "user",
        status: "unknown",
        description: "Public address you set up for this desktop.",
      }),
    ]);
  });
});
