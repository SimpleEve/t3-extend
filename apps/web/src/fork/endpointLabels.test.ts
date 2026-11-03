import { describe, expect, it } from "vite-plus/test";

import { endpointHint, endpointLabel } from "./endpointLabels";

describe("endpoint names in the interface language", () => {
  const t = (source: string) => `<${source}>`;

  it.each([
    ["This machine", "<This machine>"],
    ["Local network", "<Local network>"],
    ["Tailscale IP", "<Tailscale IP>"],
    ["Custom HTTPS", "<Custom HTTPS>"],
    ["Custom endpoint", "<Custom endpoint>"],
    // Not ours to translate: product names, and the host name of a computer on your server.
    ["Tailscale HTTPS", "Tailscale HTTPS"],
    ["mac-mini.t3.example.com", "mac-mini.t3.example.com"],
  ])("%s shows as %s", (label, expected) => {
    expect(endpointLabel(t, label)).toBe(expected);
  });
});

describe("share hints in the interface language", () => {
  const t = (source: string) => `<${source}>`;

  it.each([
    ["Opens the hosted app, no install needed", "<Opens the hosted app, no install needed>"],
    ["Devices on the same network", "<Devices on the same network>"],
    ["Devices on your private network", "<Devices on your private network>"],
    ["Reachable from anywhere", "<Reachable from anywhere>"],
    ["Clients on this machine", "<Clients on this machine>"],
    ["Something else", "Something else"],
  ])("%s shows as %s", (hint, expected) => {
    expect(endpointHint(t, hint)).toBe(expected);
  });
});
