import { assert, describe, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import {
  DRIVER_SIGNATURES,
  NO_SIGNATURE,
  hasAgentMarker,
  hasDebugFlag,
  matchRoot,
  matchesRuntime,
} from "./RuntimeSignatures.ts";

// What `ps -ww -o args=` shows for each launcher on this machine's installs, and look-alikes.
const ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["claudeAgent", "/Users/x/.local/bin/claude --output-format stream-json --verbose"],
  ["claudeAgent", "claude --print"],
  ["claudeAgent", "/Users/x/.local/share/claude/versions/2.1.316 --print"],
  ["claudeAgent", "node /x/node_modules/@anthropic-ai/claude-agent-sdk/cli.js --print"],
  ["codex", "node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js app-server"],
  ["codex", "/x/codex-darwin-arm64/vendor/codex/codex -c a=b app-server"],
  ["opencode", "/Users/x/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=4096"],
  ["grok", "/Users/x/.grok/bin/grok --permission-mode auto agent stdio"],
  ["kiro", "kiro-cli acp --agent-engine=v3 --auth-method=cli"],
  ["fx", "/usr/local/bin/fx acp"],
  [
    "pi",
    "node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --mode rpc",
  ],
  ["pi", "/opt/homebrew/bin/pi --mode rpc"],
  ["muse", "/usr/local/bin/muse"],
];

const NOT_ROOTS = [
  "node server.mjs",
  "/bin/zsh -l",
  "npm run dev",
  "node vite.js --port 5173",
  "grep claude notes.txt",
  "vim claude-notes.md",
  "/usr/bin/open codex.html",
  "tail -f opencode.log",
  "python -m http.server",
  "cat pi.txt",
];

describe("runtime signatures", () => {
  it.each(ROOTS)("%s: %s is a root and a runtime", (driver, args) => {
    assert.equal(matchRoot(args)?.driver, driver);
    assert.isTrue(matchesRuntime(args));
  });

  it.each(NOT_ROOTS)("%s is neither", (args) => {
    assert.isNull(matchRoot(args));
    assert.isFalse(matchesRuntime(args));
  });

  it("recognizes a configured binary by its basename in the first two words", () => {
    const extra = [{ driver: "codex", binaryPath: "/opt/custom/my-codex" }];
    assert.equal(matchRoot("/opt/custom/my-codex app-server", extra)?.driver, "codex");
    assert.equal(matchRoot("node /opt/custom/my-codex app-server", extra)?.driver, "codex");
    assert.isNull(matchRoot("node server.mjs my-codex", extra));
  });

  it("only Claude and Codex have agent jobs, the two drivers that set the thread marker", () => {
    assert.deepEqual(
      DRIVER_SIGNATURES.filter((signature) => signature.agentJobs).map((s) => s.driver),
      ["claudeAgent", "codex"],
    );
  });

  it("reads debug flags and the marker", () => {
    for (const text of [
      "node a.js --inspect",
      "node a.js --inspect=0",
      "node a.js --inspect-brk=9230",
      "node --inspect-port=1 a.js",
      "x NODE_OPTIONS=--inspect=0",
      'x NODE_OPTIONS="--require y --inspect"',
      "chrome --remote-debugging-port=9222",
      "java -agentlib:jdwp=transport=dt_socket,server=y,address=5005 Main",
      "java -Xrunjdwp:transport=dt_socket Main",
    ]) {
      assert.isTrue(hasDebugFlag(text), text);
    }
    for (const text of ["node a.js", "node a.js --inspector-note", "vite --host", "x INSPECT=1"]) {
      assert.isFalse(hasDebugFlag(text), text);
    }
    assert.isTrue(hasAgentMarker("node a.js HOME=/x T3CODE_THREAD_ID=thread%3A1"));
    assert.isFalse(hasAgentMarker("node a.js NOT_T3CODE_THREAD_ID=1"));
    assert.isFalse(hasAgentMarker("node a.js T3CODE_THREAD_ID="));
  });

  it("covers every built-in driver: a signature, or a written reason it has none", () => {
    const covered = new Set([
      ...DRIVER_SIGNATURES.map((signature) => signature.driver),
      ...NO_SIGNATURE.map((entry) => entry.driver),
    ]);
    for (const entry of NO_SIGNATURE) assert.isAbove(entry.reason.length, 20, entry.driver);
    const missing = BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)).filter(
      (kind) => !covered.has(kind),
    );
    assert.deepEqual(missing, []);
    const known = new Set(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)));
    assert.deepEqual(
      [...covered].filter((kind) => !known.has(kind)),
      [],
    );
  });
});
