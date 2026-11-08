// @effect-diagnostics nodeBuiltinImport:off -- Reads this repository's sources as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

// Electron keeps one listener per `webRequest` event per session, and a second registration
// replaces the first. The gateway owns `onHeadersReceived` on the preview sessions; see FORK.md.
const DESKTOP_SRC = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const FORK_DIR = NodePath.join(DESKTOP_SRC, "fork") + NodePath.sep;
// Only the events the gateway registers can collide with it; upstream's preview session also
// registers `onBeforeSendHeaders` (Teams user agent), a different event with its own listener.
const WEB_REQUEST_LISTENER = /\bwebRequest\s*\??\.\s*onHeadersReceived\s*\(/u;
const TEST_FILE = /\.(?:test|testkit)\.[cm]?[jt]sx?$/u;

const sourceFiles = (directory: string): Array<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) && !TEST_FILE.test(entry.name) ? [full] : [];
  });

describe("webRequest listeners in the desktop app", () => {
  it("are only registered under src/fork, so the gateway's onHeadersReceived is not overwritten", () => {
    const offenders = sourceFiles(DESKTOP_SRC)
      .filter((file) => !file.startsWith(FORK_DIR))
      .filter((file) => WEB_REQUEST_LISTENER.test(NodeFS.readFileSync(file, "utf8")))
      .map((file) => NodePath.relative(DESKTOP_SRC, file));
    expect(
      offenders,
      "webRequest.onHeadersReceived() replaces the loopback gateway's listener on the same session. Merge the two handlers instead; see the loopback gateway section of FORK.md.",
    ).toEqual([]);
  });

  it("recognizes the calls it is looking for", () => {
    for (const sample of [
      "session.webRequest.onHeadersReceived(listener)",
      "browserSession.webRequest.onHeadersReceived(null)",
      "session.webRequest\n  .onHeadersReceived(fn)",
      "session.webRequest?.onHeadersReceived(fn)",
    ]) {
      expect(WEB_REQUEST_LISTENER.test(sample)).toBe(true);
    }
    expect(WEB_REQUEST_LISTENER.test("session.webRequest.onBeforeSendHeaders(filter, fn)")).toBe(
      false,
    );
    expect(WEB_REQUEST_LISTENER.test("const webRequestCount = on(x)")).toBe(false);
  });
});
