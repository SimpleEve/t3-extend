import { describe, expect, it } from "vite-plus/test";

import {
  managedCapabilityDenial,
  managedNightlyDeniedMessage,
  managedRuntimeModeDenial,
  managedUpdatesDenial,
  type ManagedPolicySummary,
} from "./managedPolicy.ts";

const summary = (limits: NonNullable<ManagedPolicySummary["limits"]>): ManagedPolicySummary => ({
  organization: "Example Corp",
  lockedSettings: [],
  limits,
});

// Stands in for a client's `t`: every source (and each label inside it) goes through it.
const marked = (source: string, params?: Readonly<Record<string, string | number>>) =>
  `«${source.replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name]))}»`;

describe("managed policy messages", () => {
  it("default to English and give the client's translator every sentence and label", () => {
    const off = summary({ updates: { mode: "off" } });
    expect(managedUpdatesDenial(off)).toBe("Example Corp manages T3 Extend updates.");
    expect(managedUpdatesDenial(off, marked)).toBe("«Example Corp manages T3 Extend updates.»");
    expect(managedNightlyDeniedMessage("Example Corp", marked)).toBe(
      "««Example Corp manages T3 Extend updates.» Only stable releases can be installed.»",
    );

    const webhooksOff = summary({ webhookTasks: false });
    expect(managedCapabilityDenial(webhooksOff, "webhookTasks")).toBe(
      "Example Corp's policy does not allow webhook tasks.",
    );
    expect(managedCapabilityDenial(webhooksOff, "webhookTasks", marked)).toBe(
      "«Example Corp's policy does not allow «webhook tasks».»",
    );

    const capped = summary({ maxRuntimeMode: "approval-required" });
    expect(managedRuntimeModeDenial(capped, "full-access")).toBe(
      "Example Corp limits threads to Supervised.",
    );
    expect(managedRuntimeModeDenial(capped, "full-access", marked)).toBe(
      "«Example Corp limits threads to «Supervised».»",
    );
  });
});
