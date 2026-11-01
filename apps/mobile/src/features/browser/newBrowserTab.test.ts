import type { DiscoveredLocalServer, ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { localServerRows, projectPreviewTargets, resolveBrowserAddress } from "./newBrowserTab";

describe("resolveBrowserAddress", () => {
  it.each([
    ["localhost:5173", "http://localhost:5173/"],
    ["  127.0.0.1:3000/docs ", "http://127.0.0.1:3000/docs"],
    ["[::1]:8080", "http://[::1]:8080/"],
    ["example.com", "https://example.com/"],
    ["example.com/path?q=1", "https://example.com/path?q=1"],
    ["devbox:3000", "https://devbox:3000/"],
    ["http://example.com", "http://example.com/"],
    ["HTTPS://Example.com/a", "https://example.com/a"],
  ])("opens %s as %s", (input, url) => {
    expect(resolveBrowserAddress(input)).toEqual({ ok: true, url });
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.com", "view-source:x.com"])(
    "refuses the non-web scheme in %s",
    (input) => {
      expect(resolveBrowserAddress(input)).toEqual({ ok: false, reason: "unsupported" });
    },
  );

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["hello world", "invalid"],
    ["devbox", "invalid"],
    [`example.com/${"a".repeat(2_100)}`, "invalid"],
  ])("rejects %j", (input, reason) => {
    expect(resolveBrowserAddress(input)).toEqual({ ok: false, reason });
  });
});

const script = (name: string, previewUrl?: string): ProjectScript =>
  ({
    id: name,
    name,
    command: "vp run dev",
    icon: "play",
    runOnWorktreeCreate: false,
    ...(previewUrl === undefined ? {} : { previewUrl }),
  }) as ProjectScript;

const server = (port: number, extra: Partial<DiscoveredLocalServer> = {}): DiscoveredLocalServer =>
  ({
    host: "127.0.0.1",
    port,
    url: `http://localhost:${port}/`,
    processName: "node",
    pid: 100 + port,
    terminal: null,
    ...extra,
  }) as DiscoveredLocalServer;

describe("projectPreviewTargets", () => {
  it("keeps the first loopback Preview URL per resource", () => {
    expect(
      projectPreviewTargets([
        script("Web", "http://localhost:5173/app#top"),
        script("Again", "http://localhost:5173/app"),
        script("Remote", "https://example.com"),
        script("Padded", " http://localhost:3000"),
        script("No preview"),
        script("Docs", "http://127.0.0.1:4000/docs"),
      ]),
    ).toEqual([
      { name: "Web", url: "http://localhost:5173/app#top" },
      { name: "Docs", url: "http://127.0.0.1:4000/docs" },
    ]);
  });
});

describe("localServerRows", () => {
  it("lists Preview URL servers first and labels them with their script", () => {
    const rows = localServerRows(
      {
        scannedAt: "2026-11-01T00:00:00.000Z",
        servers: [
          server(3000),
          server(8080, { host: "0.0.0.0" }),
          server(5173, { url: "http://localhost:5173/app" }),
        ],
      },
      [{ name: "Web", url: "http://localhost:5173/app" }],
    );
    expect(rows.map((row) => [row.port, row.scriptName, row.url])).toEqual([
      [5173, "Web", "http://localhost:5173/app"],
      [3000, null, "http://localhost:3000/"],
      [8080, null, "http://localhost:8080/"],
    ]);
  });

  it("shows nothing before the first scan", () => {
    expect(localServerRows(null, [])).toEqual([]);
  });
});
