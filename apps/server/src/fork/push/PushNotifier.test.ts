// @effect-diagnostics nodeBuiltinImport:off -- The receiver side of the test replays raw ECDH keys.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  PushNotificationPayload,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type PushNotificationPreferences,
  type PushRegistrationInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PushNotifier from "./PushNotifier.ts";
import * as PushApns from "./PushApns.ts";
import * as PushRegistrations from "./PushRegistrations.ts";
import * as PushTransport from "./pushTransport.ts";
import { decryptWebPush } from "./webPush.ts";

const NOW = "2026-11-02T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ENVIRONMENT_ID = EnvironmentId.make("this-environment");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const ALL_ON: PushNotificationPreferences = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(PushNotificationPayload));
const unused = () => Effect.die("unused in this test");

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the build",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const awaitingApproval = () =>
  shell({
    pendingRuntimeRequest: {
      id: "request-1" as never,
      kind: "dynamic_tool_call",
      createdAt: DateTime.makeUnsafe(NOW),
    },
  });

interface Receiver {
  readonly privateKey: Buffer;
  readonly auth: Buffer;
  readonly input: (
    overrides?: Partial<PushRegistrationInput>,
    preferences?: PushNotificationPreferences,
  ) => PushRegistrationInput;
}

function makeReceiver(endpoint: string, deviceId = "device-1"): Receiver {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = NodeCrypto.randomBytes(16);
  return {
    privateKey: ecdh.getPrivateKey(),
    auth,
    input: (overrides = {}, preferences = ALL_ON) => ({
      deviceId,
      label: "Pixel",
      environmentLabel: "Mac mini",
      endpoint,
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
      preferences,
      ...overrides,
    }),
  };
}

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number, url: string) => Response | Error;
    readonly activeSessions?: ReadonlyArray<string>;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly project?: Option.Option<{ readonly id: ProjectId; readonly title: string }>;
    readonly apns?: PushApns.PushApns["Service"];
    /** Runs while a delivery is on its way, like a phone registering again meanwhile. */
    readonly duringDelivery?: (
      registrations: PushRegistrations.PushRegistrations["Service"],
    ) => Effect.Effect<void, unknown>;
  } = {},
) {
  yield* TestClock.setTime(NOW_MS);
  const values = new Map<string, Uint8Array>();
  const storage = { failWrites: false };
  const write = (name: string, value: Uint8Array) =>
    storage.failWrites
      ? Effect.fail(
          new ServerSecretStore.SecretStorePersistError({ resource: name, cause: "disk full" }),
        )
      : Effect.sync(() => void values.set(name, value));
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    create: write,
    set: write,
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: unused,
  });
  const registrations = yield* PushRegistrations.make({
    allowInsecure: false,
    apnsConfigured: options.apns?.configured ?? false,
  }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets));

  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const shellReads: ThreadId[] = [];
  const sent: Sent[] = [];
  const transport = PushTransport.PushTransport.of({
    post: (input) =>
      (options.duringDelivery?.(registrations) ?? Effect.void).pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.suspend(() => {
            sent.push({ url: input.url, headers: new Headers(input.headers), body: input.body });
            const result =
              options.respond?.(sent.length, input.url) ?? new Response(null, { status: 200 });
            return result instanceof Error
              ? Effect.fail(new PushTransport.PushTransportError({ reason: "unreachable" }))
              : Effect.succeed(result.status);
          }),
        ),
      ),
  });

  // One server process: its queues, notifier and consumers. `spawn` starts another over the same
  // registrations and thread state, as a restart does.
  const node = Effect.fnUntraced(function* () {
    const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const domainPulls = yield* Queue.unbounded<void>();
    const sessionChanges = yield* Queue.unbounded<{
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    }>();
    const sessionPulls = yield* Queue.unbounded<void>();

    const threads = {
      getThreadShell: (threadId: ThreadId) =>
        Effect.sync(() => shellReads.push(threadId)).pipe(
          Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
        ),
      getShellSnapshot: () =>
        Ref.get(currentShell).pipe(
          Effect.map((current) => ({
            schemaVersion: 2,
            snapshotSequence: 1,
            threads: current === null ? [] : [current],
            archivedThreads: [],
          })),
        ),
      listActiveShellIndex: () =>
        Ref.get(currentShell).pipe(
          Effect.map((current) =>
            current === null ? [] : [{ id: current.id, lineage: current.lineage }],
          ),
        ),
      streamDomainEvents: Stream.fromEffectRepeat(
        Queue.offer(domainPulls, undefined).pipe(Effect.andThen(Queue.take(domainEvents))),
      ),
    } as unknown as ThreadManagement.ThreadManagementService["Service"];

    const project = options.project ?? Option.some({ id: PROJECT_ID, title: "Web app" });
    const projects = {
      getById: () =>
        Effect.succeed(
          Option.map(project, (entry) => ({
            ...entry,
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          })),
        ),
      snapshot: Effect.succeed({
        projects: Option.isSome(project) ? [project.value] : [],
      }),
    } as unknown as ProjectService.ProjectService["Service"];

    const sessionStore = {
      listActive: () =>
        Effect.succeed(
          (options.activeSessions ?? ["session-1", "session-2", "session-3"]).map((sessionId) => ({
            sessionId,
          })),
        ),
      streamChanges: Stream.fromEffectRepeat(
        Queue.offer(sessionPulls, undefined).pipe(Effect.andThen(Queue.take(sessionChanges))),
      ),
    } as unknown as SessionStore.SessionStore["Service"];

    const notifier = yield* PushNotifier.make.pipe(
      Effect.provideService(PushRegistrations.PushRegistrations, registrations),
      Effect.provideService(PushApns.PushApns, options.apns ?? PushApns.disabled),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      Effect.provideService(ProjectService.ProjectService, projects),
      Effect.provideService(SessionStore.SessionStore, sessionStore),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
        getDescriptor: Effect.succeed({ label: "Server label" } as never),
      }),
      Effect.provideService(PushTransport.PushTransport, transport),
    );

    let eventCounter = 0;
    const eventFor = (threadId: ThreadId, current: OrchestrationV2ThreadShell) =>
      ({
        id: EventId.make(`event:${threadId}:${eventCounter++}`),
        type: "thread.settled",
        threadId,
        occurredAt: DateTime.makeUnsafe(NOW),
        payload: current,
      }) as unknown as OrchestrationV2DomainEvent;

    /** Starts watching and waits for the consumers to be ready. */
    const start = Effect.gen(function* () {
      yield* notifier.start();
      yield* Queue.take(domainPulls);
      yield* Queue.take(sessionPulls);
    });
    /** Delivers one domain event and waits until its delivery work has finished. */
    const emit = Effect.fnUntraced(function* (
      threadId: ThreadId = THREAD_ID,
      current?: OrchestrationV2ThreadShell | null,
    ) {
      if (current !== undefined) yield* Ref.set(currentShell, current);
      yield* Queue.offer(domainEvents, eventFor(threadId, current ?? shell()));
      yield* Queue.take(domainPulls);
      yield* notifier.drain;
    });
    const revokeSession = Effect.fnUntraced(function* (sessionId: string) {
      yield* Queue.offer(sessionChanges, {
        type: "clientRemoved",
        sessionId: AuthSessionId.make(sessionId),
      });
      yield* Queue.take(sessionPulls);
    });

    return { notifier, start, emit, revokeSession };
  });

  const first = yield* node();
  return { registrations, currentShell, shellReads, sent, storage, spawn: node, ...first };
});

const open = (receiver: Receiver, sent: Sent) =>
  decodePayload(decryptWebPush(sent.body, receiver.privateKey, receiver.auth).toString());
const session = (id: string) => AuthSessionId.make(id);

describe("push registrations", () => {
  it.effect("registers, replaces, dedupes and removes", () =>
    Effect.gen(function* () {
      const { registrations } = yield* makeHarness();
      const first = makeReceiver("https://ntfy.example.test/upFirst?up=1");
      const stored = yield* registrations.upsert({
        sessionId: session("session-1"),
        registration: first.input(),
      });
      assert.equal(
        PushRegistrations.registrationTarget(stored),
        "https://ntfy.example.test/upFirst?up=1",
      );
      assert.equal((yield* registrations.list).length, 1);

      // The distributor hands out a new endpoint: same session, same registration, new URL.
      yield* TestClock.adjust("1 minute");
      const moved = makeReceiver("https://ntfy.example.test/upMoved?up=1");
      const updated = yield* registrations.upsert({
        sessionId: session("session-1"),
        registration: moved.input(),
      });
      assert.equal((yield* registrations.list).length, 1);
      assert.equal(updated.createdAt, stored.createdAt);
      assert.notEqual(updated.updatedAt, stored.updatedAt);
      assert.equal(
        PushRegistrations.registrationTarget(updated),
        "https://ntfy.example.test/upMoved?up=1",
      );

      // A re-paired phone has a new session but the same device: the old one goes.
      yield* registrations.upsert({
        sessionId: session("session-2"),
        registration: moved.input(),
      });
      assert.deepStrictEqual(
        (yield* registrations.list).map((entry) => entry.sessionId),
        ["session-2"],
      );

      // A different device that was handed the same endpoint replaces it as well.
      yield* registrations.upsert({
        sessionId: session("session-3"),
        registration: moved.input({ deviceId: "device-2" }),
      });
      assert.deepStrictEqual(
        (yield* registrations.list).map((entry) => entry.sessionId),
        ["session-3"],
      );

      assert.equal(
        yield* registrations.remove({ sessionId: session("session-3"), deviceId: "device-2" }),
        true,
      );
      assert.equal(
        yield* registrations.remove({ sessionId: session("session-3"), deviceId: "device-2" }),
        false,
      );
      assert.equal((yield* registrations.list).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects endpoints and keys it cannot use, and reports only the host", () =>
    Effect.gen(function* () {
      const { registrations } = yield* makeHarness();
      const receiver = makeReceiver("https://ntfy.example.test/upSecretTopic?up=1");
      const insecure = yield* registrations
        .upsert({
          sessionId: session("session-1"),
          registration: receiver.input({ endpoint: "http://ntfy.example.test/upSecretTopic" }),
        })
        .pipe(Effect.flip);
      assert.equal(insecure.reason, "invalid_endpoint");
      const badKeys = yield* registrations
        .upsert({ sessionId: session("session-1"), registration: receiver.input({ auth: "AAAA" }) })
        .pipe(Effect.flip);
      assert.equal(badKeys.reason, "invalid_keys");

      const stored = yield* registrations.upsert({
        sessionId: session("session-1"),
        registration: receiver.input(),
      });
      const status = PushRegistrations.toPushRegistrationStatus(stored);
      assert.equal(status.endpointHost, "ntfy.example.test");
      assert.notInclude(JSON.stringify(status), "upSecretTopic");
    }).pipe(Effect.scoped),
  );

  it.effect("drops the registrations of revoked and expired sessions", () =>
    Effect.gen(function* () {
      const { registrations, start, revokeSession } = yield* makeHarness({
        activeSessions: ["session-1", "session-2"],
      });
      const add = (id: string, deviceId: string) =>
        registrations.upsert({
          sessionId: session(id),
          registration: makeReceiver(`https://ntfy.example.test/up${id}`, deviceId).input(),
        });
      yield* add("session-1", "d1");
      yield* add("session-2", "d2");
      yield* add("session-expired", "d3");

      // Starting reconciles with the sessions that are still valid.
      yield* start;
      assert.deepStrictEqual(
        (yield* registrations.list).map((entry) => entry.sessionId),
        ["session-1", "session-2"],
      );

      // Revoking a session in Connections ends its registrations at once.
      yield* revokeSession("session-1");
      assert.deepStrictEqual(
        (yield* registrations.list).map((entry) => entry.sessionId),
        ["session-2"],
      );
    }).pipe(Effect.scoped),
  );
});

describe("push delivery", () => {
  const registered = Effect.fnUntraced(function* (
    options: Parameters<typeof makeHarness>[0] = {},
    preferences = ALL_ON,
  ) {
    const harness = yield* makeHarness(options);
    const receiver = makeReceiver("https://ntfy.example.test/upDevice?up=1");
    yield* harness.registrations.upsert({
      sessionId: session("session-1"),
      registration: receiver.input({}, preferences),
    });
    return { ...harness, receiver };
  });

  it.effect("sends an encrypted test notification that only the phone can read", () =>
    Effect.gen(function* () {
      const { notifier, registrations, sent, receiver } = yield* registered();
      const result = yield* notifier.sendTest({
        sessionId: session("session-1"),
        deviceId: "device-1",
      });
      assert.deepStrictEqual(result, { registered: true, outcome: "delivered", httpStatus: 200 });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.url, "https://ntfy.example.test/upDevice?up=1");
      assert.equal(sent[0]?.headers.get("content-encoding"), "aes128gcm");
      assert.equal(sent[0]?.headers.get("ttl"), "3600");
      const payload = open(receiver, sent[0]!);
      assert.equal(payload.kind, "test");
      assert.equal(payload.environmentLabel, "Mac mini");
      assert.equal(payload.environmentId, ENVIRONMENT_ID);
      // The push server sees ciphertext only.
      assert.notInclude(Buffer.from(sent[0]!.body).toString("utf8"), "Mac mini");
      const stored = (yield* registrations.list)[0];
      assert.equal(stored?.lastDelivery?.outcome, "delivered");
    }).pipe(Effect.scoped),
  );

  it.effect("answers a test for a device it does not know without sending", () =>
    Effect.gen(function* () {
      const { notifier, sent } = yield* registered();
      const result = yield* notifier.sendTest({
        sessionId: session("session-1"),
        deviceId: "other",
      });
      assert.deepStrictEqual(result, { registered: false, outcome: null, httpStatus: null });
      assert.equal(sent.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect.each([404, 410] as const)(
    "deletes the registration when the endpoint answers %s",
    (status) =>
      Effect.gen(function* () {
        const { notifier, registrations } = yield* registered({
          respond: () => new Response(null, { status }),
        });
        const result = yield* notifier.sendTest({
          sessionId: session("session-1"),
          deviceId: "device-1",
        });
        assert.equal(result.outcome, "gone");
        assert.equal((yield* registrations.list).length, 0);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps a registration through server errors and retries them", () =>
    Effect.gen(function* () {
      const { notifier, registrations, sent } = yield* registered({
        respond: (attempt) => new Response(null, { status: attempt < 3 ? 503 : 201 }),
      });
      const pending = yield* notifier
        .sendTest({ sessionId: session("session-1"), deviceId: "device-1" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("3 seconds");
      const result = yield* Fiber.join(pending);
      assert.equal(result.outcome, "delivered");
      assert.equal(sent.length, 3);
      assert.equal((yield* registrations.list).length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a registration when the endpoint stays unreachable", () =>
    Effect.gen(function* () {
      const { notifier, registrations } = yield* registered({
        respond: () => new Error("connect ECONNREFUSED"),
      });
      const pending = yield* notifier
        .sendTest({ sessionId: session("session-1"), deviceId: "device-1" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("3 seconds");
      const result = yield* Fiber.join(pending);
      assert.equal(result.outcome, "unreachable");
      assert.equal((yield* registrations.list).length, 1);
    }).pipe(Effect.scoped),
  );
});

describe("push triggers", () => {
  const withDevices = Effect.fnUntraced(function* (
    options: Parameters<typeof makeHarness>[0] = {},
  ) {
    const harness = yield* makeHarness(options);
    const everything = makeReceiver("https://ntfy.example.test/upAll", "device-all");
    const failuresOnly = makeReceiver("https://ntfy.example.test/upFailures", "device-failures");
    yield* harness.registrations.upsert({
      sessionId: session("session-1"),
      registration: everything.input({}, ALL_ON),
    });
    yield* harness.registrations.upsert({
      sessionId: session("session-2"),
      registration: failuresOnly.input(
        { environmentLabel: "" },
        { ...ALL_ON, notifyOnApproval: false, notifyOnInput: false, notifyOnCompletion: false },
      ),
    });
    yield* harness.notifier.prepare;
    return { ...harness, everything, failuresOnly };
  });

  it.effect("notifies an approval request once, to the devices that asked for it", () =>
    Effect.gen(function* () {
      const { start, emit, sent, everything } = yield* withDevices();
      yield* start;
      yield* emit(THREAD_ID, shell());
      assert.equal(sent.length, 0);

      yield* emit(THREAD_ID, awaitingApproval());
      assert.deepStrictEqual(
        sent.map((entry) => entry.url),
        ["https://ntfy.example.test/upAll"],
      );
      const payload = open(everything, sent[0]!);
      assert.deepStrictEqual(
        { kind: payload.kind, thread: payload.threadTitle, project: payload.projectTitle },
        { kind: "approval", thread: "Fix the build", project: "Web app" },
      );
      assert.equal(payload.environmentId, ENVIRONMENT_ID);
      assert.equal(payload.threadId, THREAD_ID);

      // More events while it still waits are not a second request.
      yield* emit(THREAD_ID, awaitingApproval());
      assert.equal(sent.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("notifies input requests, and falls back to the server's label", () =>
    Effect.gen(function* () {
      const { start, emit, sent, registrations } = yield* withDevices();
      yield* registrations.upsert({
        sessionId: session("session-3"),
        registration: makeReceiver("https://ntfy.example.test/upLabel", "device-label").input({
          environmentLabel: "",
        }),
      });
      yield* start;
      yield* emit(
        THREAD_ID,
        shell({
          pendingRuntimeRequest: {
            id: "request-2" as never,
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        }),
      );
      assert.equal(sent.length, 2);
      assert.deepStrictEqual(sent.map((entry) => entry.url).toSorted(), [
        "https://ntfy.example.test/upAll",
        "https://ntfy.example.test/upLabel",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "holds a completion briefly, then notifies it once, honoring each device's switches",
    () =>
      Effect.gen(function* () {
        const { start, emit, sent, notifier } = yield* withDevices();
        yield* start;
        yield* emit(THREAD_ID, shell({ status: "completed" }));
        assert.equal(sent.length, 0);
        yield* TestClock.adjust("5 seconds");
        yield* notifier.drain;
        assert.deepStrictEqual(
          sent.map((entry) => entry.url),
          ["https://ntfy.example.test/upAll"],
        );

        // Staying completed is not news.
        yield* emit(THREAD_ID, shell({ status: "completed" }));
        assert.equal(sent.length, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("does not announce a completion that a continuation overtakes", () =>
    Effect.gen(function* () {
      const { start, emit, sent, notifier } = yield* withDevices();
      yield* start;
      yield* emit(THREAD_ID, shell({ status: "completed" }));
      yield* emit(THREAD_ID, shell({ status: "running" }));
      yield* TestClock.adjust("5 seconds");
      yield* notifier.drain;
      assert.equal(sent.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("still announces a completion when the thread is settled during the hold", () =>
    Effect.gen(function* () {
      const { start, emit, sent, notifier } = yield* withDevices();
      yield* start;
      const completed = shell({ status: "completed" });
      yield* emit(THREAD_ID, completed);
      yield* emit(THREAD_ID, {
        ...completed,
        settledOverride: "settled",
        settledAt: DateTime.makeUnsafe(NOW),
      });
      yield* TestClock.adjust("5 seconds");
      yield* notifier.drain;
      assert.equal(sent.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("notifies failures immediately, to every device that allows them", () =>
    Effect.gen(function* () {
      const { start, emit, sent, failuresOnly } = yield* withDevices();
      yield* start;
      yield* emit(THREAD_ID, shell({ status: "failed" }));
      assert.equal(sent.length, 2);
      const forFailures = sent.find((entry) => entry.url.endsWith("/upFailures"));
      const payload = open(failuresOnly, forFailures!);
      assert.equal(payload.kind, "failed");
      // This device sent no label of its own, so the server's is used.
      assert.equal(payload.environmentLabel, "Server label");
    }).pipe(Effect.scoped),
  );

  it.effect("sends nothing while notifications are switched off on the device", () =>
    Effect.gen(function* () {
      const { start, emit, sent, registrations } = yield* makeHarness();
      yield* registrations.upsert({
        sessionId: session("session-1"),
        registration: makeReceiver("https://ntfy.example.test/upOff").input(
          {},
          { ...ALL_ON, notificationsEnabled: false },
        ),
      });
      yield* start;
      yield* emit(THREAD_ID, awaitingApproval());
      yield* emit(THREAD_ID, shell({ status: "failed" }));
      assert.equal(sent.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not announce what was already waiting when the first device registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(harness.currentShell, awaitingApproval());
      yield* harness.registrations.upsert({
        sessionId: session("session-1"),
        registration: makeReceiver("https://ntfy.example.test/upBaseline").input(),
      });
      yield* harness.notifier.prepare;
      yield* harness.start;
      yield* harness.emit(THREAD_ID, awaitingApproval());
      assert.equal(harness.sent.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("starts from a fresh baseline after the last device unregisters", () =>
    Effect.gen(function* () {
      const { start, emit, sent, registrations, notifier } = yield* withDevices();
      yield* start;
      yield* registrations.remove({ sessionId: session("session-1"), deviceId: "device-all" });
      yield* registrations.remove({
        sessionId: session("session-2"),
        deviceId: "device-failures",
      });
      // The thread starts waiting while nobody is registered.
      yield* emit(THREAD_ID, awaitingApproval());
      yield* registrations.upsert({
        sessionId: session("session-1"),
        registration: makeReceiver("https://ntfy.example.test/upAgain", "device-all").input(),
      });
      yield* notifier.prepare;
      yield* emit(THREAD_ID, awaitingApproval());
      assert.equal(sent.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores threads this environment does not have, and subagents", () =>
    Effect.gen(function* () {
      const foreign = ThreadId.make("thread-on-another-environment");
      const subagent = ThreadId.make("subagent");
      const subagentShell = {
        ...awaitingApproval(),
        id: subagent,
        lineage: {
          rootThreadId: THREAD_ID,
          parentThreadId: THREAD_ID,
          relationshipToParent: "subagent" as const,
        },
      };
      const { start, emit, sent, shellReads } = yield* withDevices({
        readShell: (threadId) =>
          Effect.succeed(
            threadId === foreign
              ? null
              : threadId === subagent
                ? subagentShell
                : awaitingApproval(),
          ),
      });
      yield* start;
      yield* emit(foreign, null);
      yield* emit(subagent, subagentShell);
      assert.equal(sent.length, 0);
      assert.deepStrictEqual(shellReads, [foreign, subagent]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a thread whose project is gone and an archived thread", () =>
    Effect.gen(function* () {
      const noProject = yield* withDevices({ project: Option.none() });
      yield* noProject.start;
      yield* noProject.emit(THREAD_ID, awaitingApproval());
      assert.equal(noProject.sent.length, 0);

      const archived = yield* withDevices();
      yield* archived.start;
      yield* archived.emit(THREAD_ID, {
        ...awaitingApproval(),
        archivedAt: DateTime.makeUnsafe(NOW),
      });
      assert.equal(archived.sent.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reads no threads while no device is registered", () =>
    Effect.gen(function* () {
      const { start, emit, shellReads, sent } = yield* makeHarness();
      yield* start;
      yield* emit(THREAD_ID, awaitingApproval());
      assert.equal(shellReads.length, 0);
      assert.equal(sent.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("stops notifying a device once its session is revoked", () =>
    Effect.gen(function* () {
      const { start, emit, sent, revokeSession } = yield* withDevices();
      yield* start;
      yield* revokeSession("session-1");
      yield* emit(THREAD_ID, awaitingApproval());
      // session-2 does not want approvals and session-1 is gone.
      assert.equal(sent.length, 0);
    }).pipe(Effect.scoped),
  );
});

describe("push registration changes", () => {
  const add = (
    registrations: PushRegistrations.PushRegistrations["Service"],
    sessionId: string,
    endpoint: string,
    deviceId = "device-1",
  ) =>
    registrations.upsert({
      sessionId: session(sessionId),
      registration: makeReceiver(endpoint, deviceId).input(),
    });

  it.effect("a new endpoint replaces the old one, and a late 410 for the old one keeps it", () =>
    Effect.gen(function* () {
      const { registrations } = yield* makeHarness();
      const old = yield* add(registrations, "session-1", "https://ntfy.example.test/upOld");
      const current = yield* add(registrations, "session-1", "https://ntfy.example.test/upNew");
      assert.deepStrictEqual(
        (yield* registrations.list).map(PushRegistrations.registrationTarget),
        ["https://ntfy.example.test/upNew"],
      );
      // A delivery that started before the change finds the old endpoint gone.
      yield* registrations.removeIfCurrent(old);
      assert.equal((yield* registrations.list).length, 1);
      yield* registrations.removeIfCurrent(current);
      assert.equal((yield* registrations.list).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect.each([201, 410] as const)(
    "an answer %s for keys that were replaced meanwhile does not touch the new registration",
    (status) =>
      Effect.gen(function* () {
        const endpoint = "https://ntfy.example.test/upSame";
        const { notifier, registrations } = yield* makeHarness({
          respond: () => new Response(null, { status }),
          // The same endpoint comes back with new keys while the old ones are being pushed to.
          duringDelivery: (store) =>
            store
              .upsert({
                sessionId: session("session-1"),
                registration: makeReceiver(endpoint).input(),
              })
              .pipe(Effect.asVoid),
        });
        yield* add(registrations, "session-1", endpoint);
        yield* notifier.sendTest({ sessionId: session("session-1"), deviceId: "device-1" });
        const stored = yield* registrations.list;
        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.lastDelivery, null);
      }).pipe(Effect.scoped),
  );

  it.effect("a failed write reports the error and leaves the registrations as they were", () =>
    Effect.gen(function* () {
      const { registrations, storage } = yield* makeHarness();
      yield* add(registrations, "session-1", "https://ntfy.example.test/upOne");
      const before = yield* registrations.list;

      storage.failWrites = true;
      const failures = [
        yield* add(registrations, "session-2", "https://ntfy.example.test/upTwo", "d2").pipe(
          Effect.flip,
        ),
        yield* add(registrations, "session-1", "https://ntfy.example.test/upMoved").pipe(
          Effect.flip,
        ),
        yield* registrations
          .remove({ sessionId: session("session-1"), deviceId: "device-1" })
          .pipe(Effect.flip),
        yield* registrations.removeSession(session("session-1")).pipe(Effect.flip),
        yield* registrations.retainSessions(new Set()).pipe(Effect.flip),
      ];
      assert.deepStrictEqual(
        failures.map((failure) => failure.reason),
        ["storage", "storage", "storage", "storage", "storage"],
      );
      assert.strictEqual(yield* registrations.list, before);

      // Once the disk works again the same calls succeed.
      storage.failWrites = false;
      assert.equal(yield* registrations.removeSession(session("session-1")), true);
      assert.equal((yield* registrations.list).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a revoked session is not pushed to even when its clean-up could not be saved", () =>
    Effect.gen(function* () {
      const { registrations, storage, notifier, start, emit, sent, revokeSession } =
        yield* makeHarness({
          activeSessions: ["session-2"],
        });
      yield* add(registrations, "session-1", "https://ntfy.example.test/upRevoked", "d1");
      yield* registrations.upsert({
        sessionId: session("session-2"),
        registration: makeReceiver("https://ntfy.example.test/upLive", "d2").input(),
      });
      yield* notifier.prepare;
      storage.failWrites = true;
      yield* start;
      yield* revokeSession("session-1");
      assert.equal((yield* registrations.list).length, 2);

      yield* emit(THREAD_ID, awaitingApproval());
      assert.deepStrictEqual(
        sent.map((entry) => entry.url),
        ["https://ntfy.example.test/upLive"],
      );
    }).pipe(Effect.scoped),
  );
});

describe("push after a restart", () => {
  it.effect("does not announce again what the previous process already announced", () =>
    Effect.gen(function* () {
      const { registrations, notifier, spawn, start, emit, sent } = yield* makeHarness();
      yield* registrations.upsert({
        sessionId: session("session-1"),
        registration: makeReceiver("https://ntfy.example.test/upRestart").input(),
      });
      yield* notifier.prepare;
      yield* start;
      yield* emit(THREAD_ID, awaitingApproval());
      assert.equal(sent.length, 1);

      // A new process starts with no memory of the thread, over the same registrations.
      const restarted = yield* spawn();
      yield* restarted.notifier.prepare;
      yield* restarted.start;
      yield* restarted.emit(THREAD_ID, awaitingApproval());
      assert.equal(sent.length, 1);

      // It still announces what happens next.
      yield* restarted.emit(THREAD_ID, shell({ status: "failed" }));
      assert.equal(sent.length, 2);
    }).pipe(Effect.scoped),
  );
});

describe("push to iPhones", () => {
  const apnsInput = (overrides: Record<string, unknown> = {}): PushRegistrationInput =>
    ({
      kind: "apns",
      deviceId: "phone-1",
      label: "iPhone",
      environmentLabel: "Mac mini",
      deviceToken: "ab".repeat(32),
      apsEnvironment: "production",
      bundleId: "com.example.app",
      preferences: ALL_ON,
      ...overrides,
    }) as PushRegistrationInput;

  const fakeApns = (outcome: "delivered" | "gone" | "rejected" | "unreachable") => {
    const calls: Array<{
      readonly registration: PushRegistrations.StoredPushRegistration;
      readonly kind: string;
    }> = [];
    const service = PushApns.PushApns.of({
      configured: true,
      send: ({ registration, payload }) =>
        Effect.sync(() => {
          calls.push({ registration, kind: payload.kind });
          return { outcome, status: outcome === "delivered" ? 200 : 410 };
        }),
    });
    return { calls, service };
  };

  it.effect("refuses an iPhone while this environment has no APNs key", () =>
    Effect.gen(function* () {
      const { registrations } = yield* makeHarness();
      const error = yield* registrations
        .upsert({ sessionId: session("session-1"), registration: apnsInput() })
        .pipe(Effect.flip);
      assert.equal(error.reason, "apns_not_configured");
      assert.equal((yield* registrations.list).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("shows Apple's host, never the token, as where it pushes", () =>
    Effect.gen(function* () {
      const { registrations } = yield* makeHarness({ apns: fakeApns("delivered").service });
      const stored = yield* registrations.upsert({
        sessionId: session("session-1"),
        registration: apnsInput({ apsEnvironment: "development" }),
      });
      const status = PushRegistrations.toPushRegistrationStatus(stored);
      assert.equal(status.endpointHost, "api.sandbox.push.apple.com");
      assert.notInclude(JSON.stringify(status), "abab");
    }).pipe(Effect.scoped),
  );

  it.effect("sends a test through APNs and keeps the registration when Apple accepts it", () =>
    Effect.gen(function* () {
      const apns = fakeApns("delivered");
      const { notifier, registrations, sent } = yield* makeHarness({ apns: apns.service });
      yield* registrations.upsert({ sessionId: session("session-1"), registration: apnsInput() });
      const result = yield* notifier.sendTest({
        sessionId: session("session-1"),
        deviceId: "phone-1",
      });
      assert.deepStrictEqual(result, { registered: true, outcome: "delivered", httpStatus: 200 });
      assert.deepStrictEqual(
        apns.calls.map((call) => call.kind),
        ["test"],
      );
      assert.equal(sent.length, 0);
      assert.equal((yield* registrations.list)[0]?.lastDelivery?.outcome, "delivered");
    }).pipe(Effect.scoped),
  );

  it.effect("deletes the registration when Apple says the token is gone", () =>
    Effect.gen(function* () {
      const { notifier, registrations } = yield* makeHarness({ apns: fakeApns("gone").service });
      yield* registrations.upsert({ sessionId: session("session-1"), registration: apnsInput() });
      const result = yield* notifier.sendTest({
        sessionId: session("session-1"),
        deviceId: "phone-1",
      });
      assert.equal(result.outcome, "gone");
      assert.equal((yield* registrations.list).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["delivered", "gone"] as const)(
    "an answer %s for a token's old app does not touch the same token registered again",
    (outcome) =>
      Effect.gen(function* () {
        let register: Effect.Effect<unknown, unknown> = Effect.void;
        const service = PushApns.PushApns.of({
          configured: true,
          send: () =>
            register.pipe(
              Effect.orDie,
              Effect.as({ outcome, status: outcome === "delivered" ? 200 : 410 }),
            ),
        });
        const { notifier, registrations } = yield* makeHarness({ apns: service });
        yield* registrations.upsert({ sessionId: session("session-1"), registration: apnsInput() });
        // The same token comes back for another app and Apple host while the old one is pushed to.
        register = registrations.upsert({
          sessionId: session("session-1"),
          registration: apnsInput({ apsEnvironment: "development", bundleId: "com.example.other" }),
        });
        yield* notifier.sendTest({ sessionId: session("session-1"), deviceId: "phone-1" });
        const stored = yield* registrations.list;
        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.lastDelivery, null);
      }).pipe(Effect.scoped),
  );

  it.effect("alerts iPhones and Android phones for the same moment, each its own way", () =>
    Effect.gen(function* () {
      const apns = fakeApns("delivered");
      const { registrations, start, emit, sent, notifier } = yield* makeHarness({
        apns: apns.service,
      });
      yield* registrations.upsert({ sessionId: session("session-1"), registration: apnsInput() });
      yield* registrations.upsert({
        sessionId: session("session-2"),
        registration: makeReceiver("https://ntfy.example.test/upAndroid", "pixel").input(),
      });
      // An iPhone that switched approvals off gets nothing for one.
      yield* registrations.upsert({
        sessionId: session("session-3"),
        registration: apnsInput({
          deviceId: "phone-2",
          deviceToken: "cd".repeat(32),
          preferences: { ...ALL_ON, notifyOnApproval: false },
        }),
      });
      yield* notifier.prepare;
      yield* start;
      yield* emit(THREAD_ID, shell());
      yield* emit(THREAD_ID, awaitingApproval());
      assert.deepStrictEqual(
        apns.calls.map((call) => [call.registration.deviceId, call.kind]),
        [["phone-1", "approval"]],
      );
      assert.deepStrictEqual(
        sent.map((entry) => entry.url),
        ["https://ntfy.example.test/upAndroid"],
      );
    }).pipe(Effect.scoped),
  );
});
