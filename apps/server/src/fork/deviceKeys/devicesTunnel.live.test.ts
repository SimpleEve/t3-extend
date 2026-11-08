// `t3x devices tunnel` as a process on a temp home: where frpc is looked for, what status says,
// and that a download that does not match the pinned SHA-256 installs nothing.
// @effect-diagnostics nodeBuiltinImport:off -- Subprocess, files, a local HTTP server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { FRP_VERSION } from "@t3tools/shared/forkFrp";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeFakeFrpc } from "./fakeFrpc.testkit.ts";
import { homeDir, seedHome } from "./homeSeed.testkit.ts";
import { TUNNEL_DIR, TUNNEL_STATUS_FILE } from "@t3tools/shared/forkDeviceKeys/tunnelStatusFile";

const ENTRY = NodePath.resolve(import.meta.dirname, "../../bin.ts");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const run = (baseDir: string, env: Record<string, string>, ...args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<{ readonly code: number | null; readonly out: string; readonly err: string }>(
        (resolve) => {
          const { T3X_FRPC_PATH: _path, T3X_FRP_BASE_URL: _mirror, ...inherited } = process.env;
          NodeChildProcess.execFile(
            process.execPath,
            [ENTRY, "devices", "tunnel", ...args, "--base-dir", baseDir],
            { env: { ...inherited, T3CODE_HOME: baseDir, ...env } },
            (error, out, err) =>
              resolve({
                code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                out,
                err,
              }),
          );
        },
      ),
  );

interface Report {
  readonly frpc: {
    readonly ok: boolean;
    readonly problem?: string;
    readonly message?: string;
    readonly source?: string;
    readonly path?: string;
  };
  readonly joined: boolean;
  readonly server: {
    readonly running: boolean;
    readonly lastUpdatedAt?: number | null;
    readonly tunnel?: string;
    readonly lastError?: string | null;
  };
}
const status = (baseDir: string, env: Record<string, string>) =>
  run(baseDir, env, "status", "--json").pipe(
    Effect.map((result) => {
      assert.equal(result.code, 0, result.err);
      return decodeJson(result.out) as Report;
    }),
  );

describe("t3x devices tunnel", () => {
  it.live(
    "looks for frpc only in T3X_FRPC_PATH and the T3 home, never on PATH, and checks the version",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* homeDir;
        const good = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        const old = yield* makeFakeFrpc({ version: "0.70.0", scripts: [] });

        const onPathOnly = yield* status(baseDir, {
          // @effect-diagnostics-next-line processEnvInEffect:off - fork: the real CLI under test inherits the host PATH; a test fixture.
          PATH: `${good.dir}${NodePath.delimiter}${process.env.PATH ?? ""}`,
        });
        assert.equal(onPathOnly.frpc.ok, false);
        assert.equal(onPathOnly.frpc.problem, "not-found");
        assert.include(onPathOnly.frpc.message ?? "", "t3x devices tunnel install");

        const configured = yield* status(baseDir, { T3X_FRPC_PATH: good.path });
        assert.equal(configured.frpc.ok, true);
        assert.equal(configured.frpc.source, "T3X_FRPC_PATH");
        assert.equal(configured.joined, false);
        assert.equal(configured.server.running, false);

        const wrong = yield* status(baseDir, { T3X_FRPC_PATH: old.path });
        assert.equal(wrong.frpc.problem, "wrong-version");

        const text = yield* run(baseDir, { T3X_FRPC_PATH: good.path }, "status");
        assert.include(text.out, `frpc ${FRP_VERSION}: ${good.path}`);
        assert.include(text.out, "has not joined a server");
      }).pipe(Effect.scoped),
  );

  it.live(
    "reports the tunnel of a running server, and says when the file is stale or the pid is gone",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* homeDir;
        const good = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        yield* seedHome(baseDir);
        const stateDir = NodePath.join(baseDir, "userdata", TUNNEL_DIR);
        NodeFS.mkdirSync(stateDir, { recursive: true });
        const write = (serverPid: number, updatedAt: number) =>
          NodeFS.writeFileSync(
            NodePath.join(stateDir, TUNNEL_STATUS_FILE),
            JSON.stringify({
              serverPid,
              frpcPid: null,
              status: "connected",
              lastError: null,
              updatedAt,
            }),
          );
        const env = { T3X_FRPC_PATH: good.path };
        const now = yield* Clock.currentTimeMillis;

        write(process.pid, now);
        const running = yield* status(baseDir, env);
        assert.equal(running.joined, true);
        assert.deepEqual(running.server.running ? running.server.tunnel : null, "connected");

        // The pid is alive (it is this process) but the server stopped writing: a reused pid.
        write(process.pid, now - 10 * 60_000);
        const stale = yield* status(baseDir, env);
        assert.equal(stale.server.running, false);
        assert.equal(stale.server.lastUpdatedAt, now - 10 * 60_000);
        const text = yield* run(baseDir, env, "status");
        assert.include(text.out, "the server is not running (it last reported at ");

        // Fresh file, but a pid that is certainly not a live process.
        write(2 ** 22 + 1, now);
        assert.equal((yield* status(baseDir, env)).server.running, false);
      }).pipe(Effect.scoped),
  );

  it.live(
    "install refuses bytes that do not match the pinned SHA-256 and leaves the home alone",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* homeDir;
        const server = NodeHttp.createServer(
          (_request, response) => void response.writeHead(200).end("not frp"),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => void server.close()));
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;

        const result = yield* run(
          baseDir,
          { T3X_FRP_BASE_URL: `http://127.0.0.1:${port}` },
          "install",
        );
        assert.notEqual(result.code, 0);
        assert.include(result.err + result.out, "SHA-256");
        assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "bin")));
      }).pipe(Effect.scoped),
  );
});
