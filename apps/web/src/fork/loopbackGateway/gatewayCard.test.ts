import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n";
import { LOOPBACK_GATEWAY_ERROR_CODES } from "@t3tools/shared/forkLoopbackGateway/protocol";
import { describe, expect, it } from "vite-plus/test";

import {
  describeGatewayCard,
  type GatewayCardKey,
  gatewayCardKeyForCode,
  gatewayCardKeyForState,
  gatewayCardOffersMove,
  gatewayCardPort,
} from "./gatewayCard";

await loadUiCatalog("zh-Hans");
const en = translatorFor("en");
const zh = translatorFor("zh-Hans");
const context = { environment: "Studio", port: 5173 };

describe("gateway card", () => {
  it("has a card for every error code the main process can report", () => {
    const keys = LOOPBACK_GATEWAY_ERROR_CODES.map((code) => [code, gatewayCardKeyForCode(code)]);
    expect(Object.fromEntries(keys)).toEqual({
      "bad-request": "failed",
      "ticket-in-url": "failed",
      unauthorized: "reconnecting",
      forbidden: "forbidden",
      "not-owned": "not-owned",
      reserved: "reserved",
      "debug-process": "debug-process",
      "discovery-disabled": "discovery-disabled",
      "owner-changed": "owner-changed",
      "rate-limited": "limit",
      "limit-reached": "limit",
      internal: "failed",
      "upstream-refused": "upstream-refused",
      offline: "offline",
      "unsupported-server": "unsupported-server",
      "unsupported-route": "failed",
      "insecure-transport": "insecure-transport",
      "tls-untrusted": "tls-untrusted",
      "unexpected-redirect": "failed",
    });
  });

  const states: ReadonlyArray<
    readonly [string, Parameters<typeof gatewayCardKeyForState>[0], GatewayCardKey | null]
  > = [
    ["old server", { state: "unsupported-server" }, "unsupported-server"],
    ["missing scopes", { state: "no-permission" }, "forbidden"],
    ["relay", { state: "unsupported-route", reason: "relay" }, "relay"],
    [
      "plain connection",
      { state: "unsupported-route", reason: "insecure-transport" },
      "insecure-transport",
    ],
    [
      "plain Tailscale address",
      { state: "unsupported-route", reason: "insecure-transport", hint: "tailscale-address" },
      "insecure-transport-tailscale",
    ],
    ["forwarding", { state: "active" }, null],
    ["stopped by the user", { state: "disabled-by-user" }, null],
    ["not applicable", { state: "not-applicable" }, null],
    ["unknown", { state: "unknown" }, null],
  ];
  it.each(states)("a tab that failed to load while %s", (_name, state, expected) => {
    expect(gatewayCardKeyForState(state)).toBe(expected);
  });

  it("offers the environment's own browser exactly where the table says", () => {
    const offered: GatewayCardKey[] = [
      "not-owned",
      "reserved",
      "debug-process",
      "unsupported-server",
      "insecure-transport",
      "insecure-transport-tailscale",
      "tls-untrusted",
      "relay",
      "discovery-disabled",
    ];
    const withheld: GatewayCardKey[] = [
      "owner-changed",
      "upstream-refused",
      "offline",
      "forbidden",
      "limit",
      "reconnecting",
      "waiting",
      "failed",
    ];
    expect(offered.filter((key) => !gatewayCardOffersMove(key))).toEqual([]);
    expect(withheld.filter(gatewayCardOffersMove)).toEqual([]);
  });

  it("explains a port that is not T3's, including a service that left its terminal", () => {
    const { description } = describeGatewayCard("not-owned", context, en);
    expect(description).toContain("nohup");
    expect(description).toContain("T3 terminal");
    expect(describeGatewayCard("not-owned", context, zh).description).toContain("nohup");
    expect(describeGatewayCard("not-owned", context, zh).description).toContain("T3 的终端");
  });

  it("tells a Tailscale IP address to use the MagicDNS name or https", () => {
    const { description } = describeGatewayCard("insecure-transport-tailscale", context, en);
    expect(description).toContain("MagicDNS");
    expect(description).toContain("https");
    expect(describeGatewayCard("insecure-transport", context, en).description).not.toContain(
      "Tailscale IP",
    );
    expect(describeGatewayCard("insecure-transport-tailscale", context, zh).description).toContain(
      "MagicDNS",
    );
  });

  it("says the certificate is not trusted", () => {
    expect(describeGatewayCard("tls-untrusted", context, en).title).toBe(
      "Studio's certificate isn't trusted",
    );
    expect(describeGatewayCard("tls-untrusted", context, zh).title).toBe("Studio 的证书不受信任");
  });

  it("names the environment and the port, and every card is translated", () => {
    const keys = Object.keys(
      Object.fromEntries(
        (
          [
            "not-owned",
            "reserved",
            "debug-process",
            "owner-changed",
            "upstream-refused",
            "offline",
            "forbidden",
            "unsupported-server",
            "insecure-transport",
            "insecure-transport-tailscale",
            "tls-untrusted",
            "relay",
            "discovery-disabled",
            "limit",
            "reconnecting",
            "waiting",
            "failed",
          ] satisfies GatewayCardKey[]
        ).map((key) => [key, key]),
      ),
    ) as GatewayCardKey[];
    expect(describeGatewayCard("upstream-refused", context, en).title).toBe(
      "Nothing is listening on port 5173 in Studio",
    );
    for (const key of keys) {
      const english = describeGatewayCard(key, context, en);
      const chinese = describeGatewayCard(key, context, zh);
      expect(chinese.title, key).not.toBe(english.title);
      expect(chinese.description, key).not.toBe(english.description);
      expect(`${chinese.title}${chinese.description}`, key).not.toMatch(/\{\w+\}/u);
    }
  });

  const ports: ReadonlyArray<readonly [string, string, number | null]> = [
    ["explicit port", "http://localhost:5173/x", 5173],
    ["http default", "http://localhost/", 80],
    ["https default", "https://localhost/", 443],
    ["not http", "file:///tmp/x", null],
    ["not a url", "nope", null],
  ];
  it.each(ports)("reads the port of %s", (_name, url, expected) => {
    expect(gatewayCardPort(url)).toBe(expected);
  });
});
