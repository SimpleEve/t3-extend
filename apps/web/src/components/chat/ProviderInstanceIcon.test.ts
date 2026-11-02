import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { resolveBadgeInitials } from "../../fork/hanBadgeInitial"; // fork: Han initial
import { resolveProviderInstanceAcpRegistryIconUrl } from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });
});

describe("resolveBadgeInitials", () => {
  const badge = (label: string) => resolveBadgeInitials(providerInstanceInitials(label));

  it("shows one Han grapheme and leaves every other name on upstream's initials", () => {
    expect(badge("工作账号")).toEqual({ text: "工", han: true });
    expect(badge("Work")).toEqual({ text: "WO", han: false });
    expect(badge("A中")).toEqual({ text: "A中", han: false });
    expect(badge("𠮷野家")).toEqual({ text: "𠮷", han: true });
    expect(badge("葛\u{E0100}野")).toEqual({ text: "葛\u{E0100}", han: true });
  });
});
