// Where frpc is looked for, which version is accepted, and the headless install from a mirror.
// @effect-diagnostics nodeBuiltinImport:off -- A local HTTP server and `tar` stand in for the release host.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { FRP_VERSION, type FrpArchive } from "@t3tools/shared/forkFrp";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as ServerConfig from "../../config.ts";
import { makeFakeFrpc } from "./fakeFrpc.testkit.ts";
import * as FrpBinary from "./frpBinary.ts";

const tempDir = Effect.acquireRelease(
  Effect.sync(() =>
    NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-frpbinary-"))),
  ),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const homeBinary = (home: string) =>
  NodePath.join(home, "bin", HostProcess.Platform.defaultValue() === "win32" ? "frpc.exe" : "frpc");

const arrange = Effect.fn("arrange")(function* (
  env: Record<string, string>,
  seams: FrpBinary.FrpBinaryTestSeams = {},
  userId: number | undefined = HostProcess.UserId.defaultValue(),
) {
  const home = yield* tempDir;
  const layer = FrpBinary.layer(seams).pipe(
    Layer.provide(ServerConfig.ServerConfig.layerTest(home, home)),
    Layer.provide(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  const binary = yield* Effect.provide(FrpBinary.FrpBinary, layer).pipe(
    Effect.provideService(HostProcess.UserId, userId),
  );
  return { home, binary };
});

const copyFake = (from: string, to: string) => {
  NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true });
  // The fake finds its control file next to its own real path, so it is linked, not copied.
  NodeFS.symlinkSync(from, to);
};

describe("FrpBinary.locate", () => {
  it.effect("prefers T3X_FRPC_PATH over the file in the T3 home", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bundled = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        const installed = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        const { home, binary } = yield* arrange({ T3X_FRPC_PATH: bundled.path });
        copyFake(installed.path, homeBinary(home));
        assert.deepEqual(yield* binary.locate, { path: bundled.path, source: "T3X_FRPC_PATH" });
      }),
    ),
  );

  it.effect("falls back to the T3 home when the environment path is empty or missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const installed = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        const missing = yield* arrange({ T3X_FRPC_PATH: "/nonexistent/frpc" });
        copyFake(installed.path, homeBinary(missing.home));
        assert.equal((yield* missing.binary.locate).source, "t3-home");
        const empty = yield* arrange({ T3X_FRPC_PATH: "  " });
        copyFake(installed.path, homeBinary(empty.home));
        assert.equal((yield* empty.binary.locate).source, "t3-home");
      }),
    ),
  );

  it.effect("never looks on PATH: a good frpc there is not found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const onPath = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        const { binary } = yield* arrange({ PATH: onPath.dir });
        const error = yield* Effect.flip(binary.locate);
        assert.equal(error.problem, "not-found");
        assert.include(error.message, "t3x devices tunnel install");
      }),
    ),
  );

  it.effect("refuses any version but the pinned one, naming what it found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const old = yield* makeFakeFrpc({ version: "0.70.0", scripts: [] });
        const { binary } = yield* arrange({ T3X_FRPC_PATH: old.path });
        const error = yield* Effect.flip(binary.locate);
        assert.equal(error.problem, "wrong-version");
        assert.include(error.message, "0.70.0");
        assert.include(error.message, FRP_VERSION);
      }),
    ),
  );

  it.effect("reports a file that cannot be run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* tempDir;
        const broken = NodePath.join(home, "broken");
        NodeFS.writeFileSync(broken, "not a program", { mode: 0o755 });
        const { binary } = yield* arrange({ T3X_FRPC_PATH: broken });
        assert.equal((yield* Effect.flip(binary.locate)).problem, "not-runnable");
      }),
    ),
  );
});

describe("FrpBinary.locate when T3X_FRPC_PATH exists but fails", () => {
  it.effect("uses <T3 home>/bin/frpc instead, whatever is wrong with the first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const installed = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        const home = yield* tempDir;
        const broken = NodePath.join(home, "broken");
        NodeFS.writeFileSync(broken, "not a program", { mode: 0o755 });
        const old = yield* makeFakeFrpc({ version: "0.70.0", scripts: [] });
        for (const bad of [old.path, broken]) {
          const { home: bundledHome, binary } = yield* arrange({ T3X_FRPC_PATH: bad });
          copyFake(installed.path, homeBinary(bundledHome));
          assert.deepEqual(yield* binary.locate, {
            path: homeBinary(bundledHome),
            source: "t3-home",
          });
        }
      }),
    ),
  );

  it.effect("reports the first candidate's problem, and installing really does fix it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const old = yield* makeFakeFrpc({ version: "0.70.0", scripts: [] });
        const { home, binary } = yield* arrange({ T3X_FRPC_PATH: old.path });
        const staleHome = yield* makeFakeFrpc({ version: "0.69.0", scripts: [] });
        copyFake(staleHome.path, homeBinary(home));

        // Both fail: the person is told about the file they pointed at, not the fall-through's.
        const error = yield* Effect.flip(binary.locate);
        assert.equal(error.problem, "wrong-version");
        assert.include(error.message, old.path);
        assert.include(error.message, "0.70.0");
        assert.notInclude(error.message, "0.69.0");
        assert.include(error.message, `${homeBinary(home)} instead`);

        // What the message asks for: a good file in <T3 home>/bin/frpc. It replaces the stale one.
        NodeFS.rmSync(homeBinary(home));
        const fresh = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        copyFake(fresh.path, homeBinary(home));
        assert.deepEqual(yield* binary.locate, { path: homeBinary(home), source: "t3-home" });
      }),
    ),
  );

  it.effect("warns about the file it skipped, once", () => {
    const messages: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const old = yield* makeFakeFrpc({ version: "0.70.0", scripts: [] });
        const installed = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
        const { home, binary } = yield* arrange({ T3X_FRPC_PATH: old.path });
        copyFake(installed.path, homeBinary(home));
        assert.equal((yield* binary.locate).source, "t3-home");
        assert.equal(messages.filter((m) => m.includes("Skipping frpc")).length, 1);
        assert.include(messages.join("\n"), old.path);
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "FrpBinary.locate refuses a file others could replace",
  () => {
    it.effect("a file or directory that others can write, or that another user owns", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
          const { binary } = yield* arrange({ T3X_FRPC_PATH: fake.path });
          assert.equal((yield* binary.locate).source, "T3X_FRPC_PATH");

          NodeFS.chmodSync(fake.path, 0o775);
          const writableFile = yield* Effect.flip(binary.locate);
          assert.equal(writableFile.problem, "unsafe-location");
          assert.include(writableFile.message, fake.path);
          assert.include(writableFile.message, "can be changed by other users");
          NodeFS.chmodSync(fake.path, 0o755);

          NodeFS.chmodSync(fake.dir, 0o707);
          const writableDirectory = yield* Effect.flip(binary.locate);
          assert.equal(writableDirectory.problem, "unsafe-location");
          assert.include(writableDirectory.message, fake.dir);
          NodeFS.chmodSync(fake.dir, 0o700);

          const stranger = yield* arrange({ T3X_FRPC_PATH: fake.path }, {}, 4_000_000);
          const foreign = yield* Effect.flip(stranger.binary.locate);
          assert.equal(foreign.problem, "unsafe-location");
          assert.include(foreign.message, "belongs to another user");
        }),
      ),
    );

    it.effect("an unsafe T3X_FRPC_PATH is skipped for a safe file in the T3 home", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const bundled = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
          const installed = yield* makeFakeFrpc({ version: FRP_VERSION, scripts: [] });
          const { home, binary } = yield* arrange({ T3X_FRPC_PATH: bundled.path });
          copyFake(installed.path, homeBinary(home));
          NodeFS.chmodSync(bundled.path, 0o775);

          assert.deepEqual(yield* binary.locate, { path: homeBinary(home), source: "t3-home" });

          // With nothing to fall back to, the message names the file and a way out that works.
          NodeFS.rmSync(homeBinary(home));
          const error = yield* Effect.flip(binary.locate);
          assert.equal(error.problem, "unsafe-location");
          assert.include(error.message, bundled.path);
          assert.include(error.message, `${homeBinary(home)} instead`);
        }),
      ),
    );
  },
);

describe("FrpBinary.install", () => {
  const platform = HostProcess.Platform.defaultValue();

  it.live(
    "downloads from the mirror variable, checks the SHA-256, and puts frpc in the T3 home",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const work = yield* tempDir;
          const staging = NodePath.join(work, "staging", `frp_${FRP_VERSION}_fake`);
          NodeFS.mkdirSync(staging, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(staging, "frpc"),
            `#!${process.execPath}\nconsole.log("${FRP_VERSION}");\n`,
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(work, "fake.tar.gz");
          NodeChildProcess.execFileSync("tar", [
            "-czf",
            archivePath,
            "-C",
            NodePath.join(work, "staging"),
            `frp_${FRP_VERSION}_fake`,
          ]);
          const bytes = NodeFS.readFileSync(archivePath);
          const entry: FrpArchive = {
            file: `frp_${FRP_VERSION}_fake.tar.gz`,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
            executable: "frpc",
          };
          const requests: Array<string> = [];
          const server = NodeHttp.createServer((request, response) => {
            requests.push(request.url ?? "");
            response.writeHead(200).end(bytes);
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => void server.close()));
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;

          const { home, binary } = yield* arrange(
            { T3X_FRP_BASE_URL: `http://127.0.0.1:${port}/frp` },
            { entry },
          );
          const installed = yield* binary.install;

          assert.deepEqual(requests, [`/frp/${entry.file}`]);
          assert.equal(installed.path, homeBinary(home));
          assert.equal(installed.sha256, entry.sha256);
          assert.deepEqual(yield* binary.locate, { path: homeBinary(home), source: "t3-home" });
          assert.equal(
            platform === "win32" || (NodeFS.statSync(installed.path).mode & 0o111) !== 0,
            true,
          );
        }),
      ),
  );

  it.live("keeps the T3 home untouched when the mirror serves something else", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = NodeHttp.createServer(
          (_request, response) => void response.writeHead(200).end("nope"),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => void server.close()));
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const { home, binary } = yield* arrange({ T3X_FRP_BASE_URL: `http://127.0.0.1:${port}` });

        const error = yield* Effect.flip(binary.install);
        assert.equal(error.problem, "checksum-mismatch");
        assert.equal(NodeFS.existsSync(NodePath.join(home, "bin")), false);
      }),
    ),
  );
});
