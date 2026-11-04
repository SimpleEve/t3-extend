// The ownership and exclusion rules, row by row, over hand-built process tables.
import { assert, describe, it } from "@effect/vitest";

import { classifyListener, type ShellEntry } from "./GatewayExclusions.ts";
import type { ProcessRow } from "./ProcessInspector.ts";

const SERVER = 100;
const MARKER = "T3CODE_THREAD_ID=thread-1";

const table = (...rows: ReadonlyArray<readonly [number, number, string, string?]>) =>
  new Map<number, ProcessRow>(
    rows.map(([pid, ppid, args, startTime]) => [
      pid,
      { pid, ppid, args, startTime: startTime ?? `start-${pid}` },
    ]),
  );

const base = [
  [1, 0, "/sbin/launchd"],
  [50, 1, "/Applications/T3 Extend.app/Contents/MacOS/T3 Extend"],
  [SERVER, 50, "node server.mjs"],
] as const;

const run = (
  rows: ReadonlyArray<readonly [number, number, string, string?]>,
  listenerPid: number,
  options: { readonly launch?: string; readonly shells?: ReadonlyArray<number> } = {},
) =>
  classifyListener({
    serverPid: SERVER,
    table: table(...base, ...rows),
    listenerPid,
    launchText: options.launch ?? "",
    shells: new Map<number, ShellEntry>(
      (options.shells ?? []).map((pid) => [pid, { startTime: `start-${pid}` }]),
    ),
  });

const denied = (verdict: ReturnType<typeof run>) =>
  verdict.allow ? "allowed" : `${verdict.code}/${verdict.rule}`;

describe("classifyListener", () => {
  it("excludes this server and its ancestors (E1)", () => {
    assert.equal(denied(run([], SERVER)), "reserved/E1");
    assert.equal(denied(run([], 50)), "reserved/E1");
    assert.equal(denied(run([], 1)), "reserved/E1");
  });

  it("excludes a process that is not in the table, whatever the snapshot said", () => {
    assert.equal(denied(run([], 999)), "not-owned/none");
  });

  it("excludes debug processes whole (E7), from argv or from NODE_OPTIONS", () => {
    const rows = [
      [200, SERVER, "-zsh"],
      [300, 200, "node dev.js --inspect=0"],
    ] as const;
    assert.equal(denied(run(rows, 300, { shells: [200] })), "debug-process/E7");
    assert.equal(
      denied(
        run(
          [
            [200, SERVER, "-zsh"],
            [300, 200, "node dev.js"],
          ],
          300,
          {
            shells: [200],
            launch: "node dev.js NODE_OPTIONS=--inspect-brk=9230 HOME=/x",
          },
        ),
      ),
      "debug-process/E7",
    );
    assert.equal(
      denied(
        run(
          [
            [200, SERVER, "-zsh"],
            [300, 200, "java -agentlib:jdwp=transport=dt_socket Main"],
          ],
          300,
          { shells: [200] },
        ),
      ),
      "debug-process/E7",
    );
  });

  it("allows what runs under a running terminal shell, or is that shell (terminal owner)", () => {
    const rows = [
      [200, SERVER, "-zsh"],
      [300, 200, "npm run dev"],
      [310, 300, "node vite.js"],
    ] as const;
    assert.deepEqual(run(rows, 310, { shells: [200] }), { allow: true, owner: "terminal" });
    assert.deepEqual(run(rows, 200, { shells: [200] }), { allow: true, owner: "terminal" });
  });

  it("refuses a pid that only looks like the terminal shell: its start time differs", () => {
    const rows = [
      [200, SERVER, "node reused.js", "later"],
      [310, 200, "node vite.js"],
    ] as const;
    assert.equal(denied(run(rows, 310, { shells: [200] })), "reserved/E2");
  });

  it("excludes the whole subtree of an unrecognized direct child (E2), marker or not", () => {
    const rows = [
      [210, SERVER, "node hub.js --port 5000"],
      [211, 210, "node agent-device-daemon.js"],
    ] as const;
    assert.equal(denied(run(rows, 210)), "reserved/E2");
    assert.equal(denied(run(rows, 211, { launch: MARKER })), "reserved/E2");
  });

  it("excludes a provider root's own listeners (E3)", () => {
    const rows = [[400, SERVER, "/Users/x/.local/bin/claude --output-format stream-json"]] as const;
    // Its runtime signature fires first for a runtime; either way it is reserved.
    assert.equal(denied(run(rows, 400, { launch: MARKER })).startsWith("reserved/"), true);
    const hub = [[410, SERVER, "/opt/bin/some-tool serve"]] as const;
    assert.equal(denied(run(hub, 410)), "reserved/E2");
  });

  it("takes a configured binary for a root by its real path only, and a look-alike for an unknown child (E2)", () => {
    const configured = [{ driver: "codex", binaryPath: "/opt/acme/my-codex" }];
    const real = new Map([["/opt/acme/my-codex", "/opt/acme/my-codex"]]);
    const resolvePath = (path: string) => real.get(path) ?? null;
    const run2 = (root: string) =>
      classifyListener({
        serverPid: SERVER,
        table: table(...base, [400, SERVER, `${root} app-server`], [460, 400, "node vite.js"]),
        listenerPid: 460,
        launchText: `node vite.js ${MARKER}`,
        shells: new Map(),
        extraExecutables: configured,
        resolvePath,
      });
    // The configured file is a Codex root, so an agent's job under it is allowed.
    assert.deepEqual(run2("/opt/acme/my-codex"), { allow: true, owner: "agent" });
    // The same name from elsewhere is nobody's provider: the whole subtree is excluded.
    assert.equal(denied(run2("/tmp/my-codex")), "reserved/E2");
  });

  it("allows an agent's job under a live Claude root when it carries the marker", () => {
    const rows = [
      [400, SERVER, "/Users/x/.local/bin/claude --output-format stream-json"],
      [450, 400, "/bin/zsh -c eval npm run dev"],
      [460, 450, "node vite.js"],
    ] as const;
    assert.deepEqual(run(rows, 460, { launch: `node vite.js ${MARKER}` }), {
      allow: true,
      owner: "agent",
    });
    assert.equal(denied(run(rows, 460, { launch: "node vite.js" })), "not-owned/E5");
  });

  it("allows a job under Codex's native runtime, which sits below its node launcher", () => {
    const rows = [
      [420, SERVER, "node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js app-server"],
      [
        421,
        420,
        "/opt/homebrew/lib/node_modules/@openai/codex-darwin-arm64/vendor/codex/codex app-server",
      ],
      [430, 421, "node vite.js"],
    ] as const;
    assert.deepEqual(run(rows, 430, { launch: MARKER }), { allow: true, owner: "agent" });
    assert.equal(denied(run(rows, 421, { launch: MARKER })), "reserved/E4");
    assert.equal(denied(run(rows, 420, { launch: MARKER })), "reserved/E4");
  });

  it("ignores the marker under a driver that does not set it, even an inherited one (E5)", () => {
    const rows = [
      [440, SERVER, "/Users/x/.opencode/bin/opencode serve --hostname=127.0.0.1 --port=4096"],
      [441, 440, "node vite.js"],
    ] as const;
    assert.equal(denied(run(rows, 441, { launch: MARKER })), "not-owned/E5");
    assert.equal(denied(run(rows, 440, { launch: MARKER })), "reserved/E4");
  });

  it("refuses leftovers of a crashed server: no longer anyone's child (E4/E5)", () => {
    const orphanRuntime = [[500, 1, "codex app-server"]] as const;
    assert.equal(denied(run(orphanRuntime, 500, { launch: MARKER })), "reserved/E4");
    const underOrphanRuntime = [
      [500, 1, "node /x/codex/bin/codex.js app-server"],
      [510, 500, "node vite.js"],
    ] as const;
    assert.equal(denied(run(underOrphanRuntime, 510, { launch: MARKER })), "reserved/E4");
    // An adopted job whose parent is gone cannot be tied to this server's agent or terminal.
    assert.equal(denied(run([[520, 1, "node vite.js"]], 520, { launch: MARKER })), "not-owned/E5");
  });

  it("does not let a descendant of a non-shell, non-provider child pass because of a shell elsewhere", () => {
    const rows = [
      [200, SERVER, "-zsh"],
      [210, SERVER, "node frpc-wrapper.js"],
      [211, 210, "node something.js"],
    ] as const;
    assert.equal(denied(run(rows, 211, { shells: [200] })), "reserved/E2");
  });

  it("survives a parent cycle in the table", () => {
    const cyclic = table(...base, [600, 601, "node a"], [601, 600, "node b"]);
    const verdict = classifyListener({
      serverPid: SERVER,
      table: cyclic,
      listenerPid: 600,
      launchText: MARKER,
      shells: new Map(),
    });
    assert.equal(denied(verdict), "not-owned/E5");
  });
});
