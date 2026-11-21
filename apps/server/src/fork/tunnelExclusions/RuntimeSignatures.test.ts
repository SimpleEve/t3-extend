// @effect-diagnostics nodeBuiltinImport:off -- Real files and symlinks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, describe, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import {
  DRIVER_SIGNATURES,
  NO_SIGNATURE,
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

  describe("a configured binaryPath names a root by its real path, not its name", () => {
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-sig-")),
    );
    const real = NodePath.join(directory, "opt", "my-codex");
    const other = NodePath.join(directory, "tmp", "my-codex");
    const link = NodePath.join(directory, "bin", "codex-link");
    const shim = NodePath.join(directory, "shim", "run.js");
    for (const file of [real, other, shim]) {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "");
    }
    NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
    NodeFS.symlinkSync(real, link);
    NodeFS.symlinkSync(real, `${shim}.link`);
    const resolve = (path: string) => {
      try {
        return NodeFS.realpathSync(path);
      } catch {
        return null;
      }
    };
    const extra = [{ driver: "codex", binaryPath: real }];
    afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const driverOf = (args: string) => matchRoot(args, extra, resolve)?.driver ?? null;

    it("the configured file itself matches, on its own and behind an interpreter", () => {
      assert.equal(driverOf(`${real} app-server`), "codex");
      assert.equal(driverOf(`node ${real} app-server`), "codex");
      assert.equal(driverOf(`/usr/bin/env node ${real}`), null);
      assert.isTrue(matchesRuntime(`${real} app-server`, extra, resolve));
    });

    it("a symlink to the configured file matches, and so does the configured symlink", () => {
      assert.equal(driverOf(`${link} app-server`), "codex");
      assert.equal(driverOf(`node ${shim}.link run`), "codex");
      const viaLink = [{ driver: "codex", binaryPath: link }];
      assert.equal(matchRoot(`${real} x`, viaLink, resolve)?.driver, "codex");
    });

    it("the same name in another directory does not match", () => {
      assert.isNull(driverOf(`${other} app-server`));
      assert.isNull(driverOf(`node ${other} app-server`));
      assert.isFalse(matchesRuntime(`${other} app-server`, extra, resolve));
    });

    it("a word that is not an absolute path does not match, and neither does a third word", () => {
      assert.isNull(driverOf("my-codex app-server"));
      assert.isNull(driverOf("./my-codex app-server"));
      assert.isNull(driverOf(`node server.mjs ${real}`));
      assert.isNull(driverOf(`sleep 1 ${real}`));
      assert.isNull(driverOf(`cat ${real}`));
    });

    it("a configured path that does not resolve matches nothing", () => {
      const missing = [{ driver: "codex", binaryPath: NodePath.join(directory, "gone") }];
      assert.isNull(matchRoot(`${NodePath.join(directory, "gone")} x`, missing, resolve));
      const relative = [{ driver: "codex", binaryPath: "my-codex" }];
      assert.isNull(matchRoot("my-codex x", relative, resolve));
    });
  });

  it("reads debug flags", () => {
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
