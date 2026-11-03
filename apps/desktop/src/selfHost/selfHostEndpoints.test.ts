import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import { describe, expect, it } from "vite-plus/test";

import { deviceAdvertisedEndpoints, selfHostAdvertisedEndpoints } from "./selfHostEndpoints.ts";

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

describe("deviceAdvertisedEndpoints", () => {
  const listed = createAdvertisedEndpoint({
    id: "manual:https://mac.t3.example.com/",
    label: "mac.t3.example.com",
    provider: { id: "manual", label: "Manual", kind: "manual", isAddon: false },
    httpBaseUrl: "https://mac.t3.example.com",
    reachability: "public",
    source: "user",
  });

  it("offers this computer's address on the joined server as a pairing endpoint", () => {
    expect(
      deviceAdvertisedEndpoints({ deviceUrl: "https://mac.t3.example.com/", existing: [] }),
    ).toMatchObject([
      {
        id: "self-host-device:https://mac.t3.example.com/",
        label: "mac.t3.example.com",
        httpBaseUrl: "https://mac.t3.example.com/",
        reachability: "public",
        status: "unknown",
      },
    ]);
  });

  it("offers nothing while this computer has not joined a server, or when it is already listed", () => {
    expect(deviceAdvertisedEndpoints({ deviceUrl: null, existing: [] })).toEqual([]);
    expect(
      deviceAdvertisedEndpoints({ deviceUrl: "https://mac.t3.example.com/", existing: [listed] }),
    ).toEqual([]);
  });
});
