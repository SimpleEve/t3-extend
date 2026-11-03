// DeviceTunnel with a fake frpc executable: the config and ticket it hands over, what each log
// sentence makes it do, the back-off and rotation clock, and what happens when the computer leaves.
// Virtual time is the TestClock; the fake is a real subprocess, so every wait is on an event
// (a status change), never on the clock.
// @effect-diagnostics nodeBuiltinImport:off -- Real files and a real child process.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DeviceTunnelStatus } from "@t3tools/contracts";
import { decodeJws } from "@t3tools/shared/forkDeviceKeys/jws";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import * as DeviceTunnel from "./DeviceTunnel.ts";
import { DEVICE_PUBLIC_URL_FILE } from "./devicePublicUrl.ts";
import { NOW_MS, joinThisComputer, layerMemoryWith } from "./deviceHarness.testkit.ts";
import { makeFakeFrpc, type FakeFrpcControl } from "./fakeFrpc.testkit.ts";
import { FRP_VERSION } from "@t3tools/shared/forkFrp";
import { actionFor, classifyFrpcLine } from "./frpcLog.ts";
import { FakeRegistry, layerFakeRegistry } from "./registryFake.testkit.ts";
import * as TunnelListener from "./TunnelListener.ts";

const LISTENER_PORT = 40_123;
const CONNECTED = {
  line: "2026-11-03 16:37:23.883 [I] [proxy/proxy_manager.go:173] [t3x] start proxy success",
};
const PONG =
  "2026-11-03 16:37:53.883 [E] [client/control.go:194] [acecc0aae91dfd0e] pong message contains error: ";
const LOGIN =
  "2026-11-03 16:37:53.901 [W] [client/service.go:346] [acecc0aae91dfd0e] connect to server error: ";
const WORK =
  "2026-11-03 16:37:54.001 [W] [client/control.go:231] [acecc0aae91dfd0e] StartWorkConn contains error: ";

const aliveCheck = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const arrange = Effect.fn("arrange")(function* (input: {
  readonly control: FakeFrpcControl;
  /** `false`: the fake is not offered through T3X_FRPC_PATH. */
  readonly offerFake?: boolean;
  readonly trustedCaFile?: string;
}) {
  yield* TestClock.setTime(NOW_MS);
  const fake = yield* makeFakeFrpc(input.control);
  const stack = DeviceTunnel.layer({ trustedCaFile: input.trustedCaFile }).pipe(
    Layer.provideMerge(layerMemoryWith(layerFakeRegistry)),
    Layer.provideMerge(
      Layer.succeed(TunnelListener.TunnelListener, {
        port: Effect.succeed(LISTENER_PORT),
      }),
    ),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3x-tunnel-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.offerFake === false ? {} : { T3X_FRPC_PATH: fake.path },
        }),
      ),
    ),
  );
  const context = yield* Layer.build(stack);
  const directory = yield* DeviceDirectory.DeviceDirectory.pipe(Effect.provideContext(context));
  const config = yield* ServerConfig.ServerConfig.pipe(Effect.provideContext(context));

  // Every tunnel status the directory announces, in order, starting with the current one.
  const queue = yield* Queue.unbounded<DeviceTunnelStatus>();
  const subscribed = yield* Deferred.make<void>();
  yield* directory.changes.pipe(
    Stream.tap(() => Deferred.succeed(subscribed, undefined)),
    Stream.runForEach((snapshot) => Queue.offer(queue, snapshot.status.tunnel)),
    Effect.forkScoped,
  );
  yield* Deferred.await(subscribed);
  const until = (
    label: string,
    predicate: (status: DeviceTunnelStatus) => boolean,
  ): Effect.Effect<DeviceTunnelStatus> =>
    Queue.take(queue).pipe(Effect.filterOrElse(predicate, () => until(label, predicate)));

  const join = joinThisComputer().pipe(Effect.provideContext(context));
  const ticketOf = (record: { readonly config: string }) =>
    /metadatas\.t3x_ticket = "([^"]+)"/.exec(record.config)?.[1] ?? "";
  return {
    context,
    fake,
    directory,
    config,
    join,
    until,
    ticketOf,
    configFile: `${config.stateDir}/fork-tunnel/frpc.toml`,
    registry: yield* FakeRegistry.pipe(Effect.provideContext(context)),
    service: yield* DeviceKeysService.DeviceKeysService.pipe(Effect.provideContext(context)),
  };
});

const connected = (status: DeviceTunnelStatus) => status.status === "connected";
const stopped = (status: DeviceTunnelStatus) => status.status === "stopped";

type Arranged = Effect.Success<ReturnType<typeof arrange>>;

/** Waits for the restart to be scheduled, then steps to one millisecond short of the delay and past it. */
const afterBackoff = (arranged: Arranged, seconds: number) =>
  Effect.gen(function* () {
    const spawned = arranged.fake.records().length;
    yield* arranged.until("the tunnel to stop", stopped);
    yield* TestClock.adjust(Duration.millis(seconds * 1000 - 1));
    // One millisecond short of the delay: nothing has been started.
    assert.equal(arranged.fake.records().length, spawned, `no restart ${seconds}s - 1ms in`);
    yield* TestClock.adjust(Duration.millis(1));
  });

describe("the frpc process", () => {
  it.effect("gets a private config, a ticket nowhere else, and only the environment it needs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* arrange({ control: { version: FRP_VERSION, scripts: [[CONNECTED]] } });
        yield* t.join;
        yield* t.until("connected", connected);

        const [record] = t.fake.records();
        assert.isDefined(record);
        if (record === undefined) return;
        const ticket = t.ticketOf(record);
        assert.notEqual(ticket, "");
        assert.deepEqual(record.argv, ["-c", t.configFile]);
        // The ticket is in the 0600 file in a 0700 directory, and in no argument or environment value.
        assert.equal(record.configMode, 0o600);
        assert.equal(record.configDirMode, 0o700);
        assert.isFalse(record.argv.some((argument) => argument.includes(ticket)));
        assert.isFalse(Object.values(record.env).some((value) => value.includes(ticket)));
        // macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts.
        const allowed = [
          "PATH",
          "HOME",
          "TMPDIR",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "SystemRoot",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
        ];
        assert.deepEqual(
          Object.keys(record.env).filter(
            (name) => !allowed.includes(name) && !name.startsWith("__CF_"),
          ),
          [],
        );

        // The config points at the tunnel listener's port and this computer's own subdomain.
        assert.include(record.config, `localPort = ${LISTENER_PORT}`);
        assert.include(record.config, 'subdomain = "studio"');
        assert.include(record.config, 'serverAddr = "t3.example.test"');
        assert.notInclude(record.config, "trustedCaFile");
        assert.notInclude(record.config, "webServer");

        // The ticket is bound to this device row's generation and lives a day.
        const { state } = { state: yield* t.directory.state };
        const self = Option.getOrThrow(state.list).devices.find(
          (device) => device.id === Option.getOrThrow(state.membership).deviceId,
        );
        const payload = decodeJws(ticket).payload;
        assert.equal(payload.gen, self?.createdAt);
        assert.equal(payload.sub, "studio");
        assert.equal(Number(payload.exp) - Number(payload.iat), 86_400);

        const status = yield* t.directory.status;
        assert.deepEqual(status.tunnel, { status: "connected", lastError: null });
      }),
    ),
  );

  it.effect("passes a test CA to frpc only when one is configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* arrange({
          control: { version: FRP_VERSION, scripts: [[CONNECTED]] },
          trustedCaFile: "/tmp/test-ca/root.crt",
        });
        yield* t.join;
        yield* t.until("connected", connected);
        assert.include(
          t.fake.records()[0]?.config ?? "",
          'transport.tls.trustedCaFile = "/tmp/test-ca/root.crt"',
        );
      }),
    ),
  );

  it.effect(
    "replaces the ticket and restarts on each of the three sentences, backing off 1, 2, 4 … 60, 60 seconds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sentences = [
            `${PONG}t3x:ticket-expired`,
            `${LOGIN}t3x:bad-ticket`,
            `${WORK}t3x:ticket-expired`,
            `${PONG}t3x:bad-ticket`,
            `${LOGIN}t3x:ticket-expired`,
            `${WORK}t3x:bad-ticket`,
            `${PONG}t3x:ticket-expired`,
            `${LOGIN}t3x:ticket-expired`,
          ];
          const t = yield* arrange({
            control: {
              version: FRP_VERSION,
              scripts: [...sentences.map((line) => [CONNECTED, { line }]), [CONNECTED]],
            },
          });
          yield* t.join;
          const delays = [1, 2, 4, 8, 16, 32, 60, 60];
          for (const delay of delays) {
            yield* t.until("connected", connected);
            yield* afterBackoff(t, delay);
          }
          yield* t.until("connected", connected);

          const records = t.fake.records();
          assert.equal(records.length, 9);
          const tickets = records.map(t.ticketOf);
          assert.equal(new Set(tickets).size, 9, "every start has a new ticket");
          // Each new ticket was issued at the (virtual) time of its start.
          const issued = tickets.map((ticket) => Number(decodeJws(ticket).payload.iat));
          let expected = NOW_MS / 1000;
          issued.forEach((iat, index) => {
            if (index > 0) expected += delays[index - 1] ?? 0;
            assert.equal(iat, expected, `ticket ${index}`);
          });
        }),
      ),
  );

  it.effect("starts again with a new ticket after 12 hours, without a back-off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* arrange({ control: { version: FRP_VERSION, scripts: [[CONNECTED]] } });
        yield* t.join;
        yield* t.until("connected", connected);
        yield* TestClock.adjust(Duration.millis(12 * 3600 * 1000 - 1));
        assert.equal(t.fake.records().length, 1);
        yield* TestClock.adjust(Duration.millis(1));
        yield* t.until("connected again", connected);
        const [first, second] = t.fake.records();
        const iat = (record: typeof first) =>
          Number(decodeJws(t.ticketOf(record ?? { config: "" })).payload.iat);
        assert.equal(iat(second) - iat(first), 12 * 3600);
        assert.notEqual(first?.pid, second?.pid);
      }),
    ),
  );
});

describe("what a rejection makes it do", () => {
  it.effect(
    "t3x:revoked asks the registry and does not restart; a refresh that says we are gone stops frpc and cleans up",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* arrange({
            control: {
              version: FRP_VERSION,
              scripts: [[CONNECTED, { onSignal: [{ line: `${PONG}t3x:revoked` }] }]],
            },
          });
          yield* t.join;
          yield* t.until("connected", connected);
          const pid = t.fake.records()[0]?.pid ?? 0;
          assert.isTrue(NodeFS.existsSync(t.configFile));

          t.registry.state.forgetCaller = true;
          process.kill(pid, "SIGUSR1");
          yield* t.until("disabled", (status) => status.status === "disabled");

          assert.equal((yield* t.directory.status).state, "removed");
          assert.isFalse(aliveCheck(pid), "frpc is gone");
          assert.isFalse(NodeFS.existsSync(t.configFile), "the ticket file is gone");
          assert.isFalse(NodeFS.existsSync(`${t.config.stateDir}/${DEVICE_PUBLIC_URL_FILE}`));
          assert.equal(t.fake.records().length, 1, "never restarted");
        }),
      ),
  );

  it.effect(
    "t3x:revoked with the registry still listing us refreshes once and leaves frpc running",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* arrange({
            control: {
              version: FRP_VERSION,
              scripts: [
                [
                  CONNECTED,
                  {
                    onSignal: [{ line: `${LOGIN}t3x:revoked` }, { line: `${PONG}t3x:bad-ticket` }],
                  },
                ],
                [CONNECTED],
              ],
            },
          });
          yield* t.join;
          yield* t.until("connected", connected);
          const listings = t.registry.callsTo("listDevices");
          const pid = t.fake.records()[0]?.pid ?? 0;
          process.kill(pid, "SIGUSR1");
          // The bad-ticket line after it is the positive control: one restart, and only one.
          yield* afterBackoff(t, 1);
          yield* t.until("connected", connected);

          assert.equal(t.fake.records().length, 2);
          assert.equal(t.registry.callsTo("listDevices"), listings + 1);
          assert.equal((yield* t.directory.status).state, "joined");
        }),
      ),
  );

  it.effect(
    "a truncated, non-UTF-8 or unknown reason does nothing: no refresh, no restart, no leaving",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hex = (text: string) => Buffer.from(text).toString("hex");
          const t = yield* arrange({
            control: {
              version: FRP_VERSION,
              scripts: [
                [
                  CONNECTED,
                  {
                    onSignal: [
                      { line: `${PONG}t3x:revok` },
                      { hex: `${hex(`${PONG}t3x:revoked`)}ff0a` },
                      { line: `${LOGIN}t3x:something-new` },
                      { line: `${WORK}t3x:ticket-expire` },
                      { line: `${PONG}send Ping request to plugin error` },
                      { line: `${PONG}t3x:busy` },
                      // The positive control.
                      { line: `${PONG}t3x:bad-ticket` },
                    ],
                  },
                ],
                [CONNECTED],
              ],
            },
          });
          yield* t.join;
          yield* t.until("connected", connected);
          const listings = t.registry.callsTo("listDevices");
          process.kill(t.fake.records()[0]?.pid ?? 0, "SIGUSR1");
          yield* afterBackoff(t, 1);
          yield* t.until("connected", connected);

          assert.equal(t.fake.records().length, 2, "only the control restarted it");
          assert.equal(t.registry.callsTo("listDevices"), listings, "nothing asked the registry");
          assert.equal((yield* t.directory.status).state, "joined");
        }),
      ),
  );

  it("decides from the exact reason alone", () => {
    const decide = (line: string | Uint8Array) => {
      const event = classifyFrpcLine(
        typeof line === "string" ? new TextEncoder().encode(line) : line,
      );
      return event === undefined ? "ignored" : actionFor(event);
    };
    assert.equal(decide(`${PONG}t3x:revoked`), "refresh");
    assert.equal(decide(`${LOGIN}t3x:ticket-expired`), "renew");
    assert.equal(decide(`${WORK}t3x:bad-ticket`), "renew");
    for (const inert of [
      `${PONG}t3x:busy`,
      `${PONG}send Login request to plugin error`,
      `${PONG}t3x:revok`,
      `${PONG}t3x:revoked `,
      `${PONG}t3x:unheard-of`,
      Uint8Array.from([...new TextEncoder().encode(`${PONG}t3x:revoked`), 0xff]),
    ]) {
      assert.equal(decide(inert), "none");
    }
    assert.equal(decide("2026 [I] login to server success"), "ignored");
  });
});

describe("back-off arithmetic", () => {
  it("doubles to a minute, and a run of 30 seconds starts the sequence over", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 20].map(DeviceTunnel.backoffSeconds),
      [1, 2, 4, 8, 16, 32, 60, 60, 60],
    );
    assert.equal(DeviceTunnel.failuresAfterRun(5, 29_999), 5);
    assert.equal(DeviceTunnel.failuresAfterRun(5, 30_000), 0);
  });
});

describe("membership and the binary", () => {
  it.effect(
    "keeps device-public-url.json equal to the membership and stops frpc when the computer leaves",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* arrange({ control: { version: FRP_VERSION, scripts: [[CONNECTED]] } });
          const file = `${t.config.stateDir}/${DEVICE_PUBLIC_URL_FILE}`;
          assert.isFalse(NodeFS.existsSync(file));
          yield* t.join;
          yield* t.until("connected", connected);
          assert.equal(
            NodeFS.readFileSync(file, "utf8"),
            JSON.stringify({ url: "https://studio.t3.example.test" }),
          );
          const pid = t.fake.records()[0]?.pid ?? 0;
          assert.isTrue(aliveCheck(pid));

          yield* t.service.leave;
          yield* t.until("disabled", (status) => status.status === "disabled");

          assert.isFalse(NodeFS.existsSync(file));
          assert.isFalse(NodeFS.existsSync(t.configFile));
          assert.isFalse(aliveCheck(pid));
        }),
      ),
  );

  it.effect(
    "reports a missing frpc with the command that fixes it, then starts once one appears",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const t = yield* arrange({
            control: { version: FRP_VERSION, scripts: [[CONNECTED]] },
            offerFake: false,
          });
          yield* t.join;
          const failed = yield* t.until("an error", (status) => status.status === "error");
          assert.include(failed.lastError ?? "", "t3x devices tunnel install");
          assert.equal(t.fake.records().length, 0);

          const home = NodePath.join(t.config.baseDir, "bin", "frpc");
          NodeFS.mkdirSync(NodePath.dirname(home), { recursive: true });
          NodeFS.symlinkSync(t.fake.path, home);
          yield* TestClock.adjust(Duration.seconds(1));
          yield* t.until("connected", connected);
          assert.equal(t.fake.records().length, 1);
        }),
      ),
  );

  it.effect("refuses a frpc of another version without starting it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const t = yield* arrange({ control: { version: "0.70.0", scripts: [[CONNECTED]] } });
        yield* t.join;
        const failed = yield* t.until("an error", (status) => status.status === "error");
        assert.include(failed.lastError ?? "", "0.70.0");
        assert.equal(t.fake.records().length, 0);
      }),
    ),
  );
});
