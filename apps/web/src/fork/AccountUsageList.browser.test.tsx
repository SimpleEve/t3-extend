import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../test/render";
import { UsageLimitsPooled } from "../components/usage/UsageLimitsPooled";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = (id: string, label: string, usedPercent: number, resetsAt: string) => ({
  id,
  kind: "session" as const,
  label,
  usedPercent,
  resetsAt,
  windowDurationMins: 300,
});

function antigravity(
  accounts: ServerProvider["auth"]["accounts"],
  live?: ServerProvider["usageLimits"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", accounts },
    checkedAt: "2026-09-03T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: live,
  };
}

const saved = (id: string, email: string, usedPercent: number, extra = {}) => ({
  id: id.padEnd(16, "0"),
  email,
  current: false,
  refreshable: true,
  usageLimits: {
    checkedAt: "2026-09-03T11:20:00.000Z",
    windows: [window("gemini-5h", "Gemini · 5-hour", usedPercent, "2026-09-03T15:00:00.000Z")],
  },
  ...extra,
});

const environment = (label: string, providers: ServerProvider[]) => ({
  entry: { target: { label } },
  serverConfig: { providers },
});

describe("Antigravity accounts listed by machine", () => {
  it("names each machine over its accounts, and a shared account after them", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("env-a"),
        environment("Laptop", [
          antigravity(
            [
              { ...saved("a1", "mine@example.com", 30), current: true },
              saved("a2", "both@example.com", 45),
            ],
            {
              checkedAt: "2026-09-03T11:59:00.000Z",
              windows: [window("gemini-5h", "Gemini · 5-hour", 30, "2026-09-03T15:00:00.000Z")],
            },
          ),
        ]),
      ],
      [
        EnvironmentId.make("env-b"),
        environment("Desk-Mini", [
          antigravity([
            { ...saved("b1", "mini@example.com", 10), current: true },
            saved("b2", "both@example.com", 45),
          ]),
        ]),
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={now} />,
    );

    const headings = screen.container.querySelectorAll("h4");
    expect([...headings].map((heading) => heading.textContent)).toEqual([
      "Desk-Mini",
      "Laptop",
      "Desk-Mini, Laptop",
    ]);
    await expect.element(screen.getByText("On 2 machines")).toBeVisible();
    // Each account is listed once, under its machine.
    for (const email of ["mine@example.com", "mini@example.com", "both@example.com"]) {
      expect(screen.container.textContent?.split(email).length).toBe(2);
    }
  });

  it("is unchanged for one machine: no machine headings", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("env-a"),
        environment("Laptop", [
          antigravity([
            { ...saved("a1", "mine@example.com", 30), current: true },
            saved("a2", "other@example.com", 45),
          ]),
        ]),
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={now} />,
    );
    await expect.element(screen.getByText("mine@example.com")).toBeVisible();
    expect(screen.container.querySelectorAll("h4")).toHaveLength(0);
  });
});
