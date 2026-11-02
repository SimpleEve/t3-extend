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
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PushNotifier from "./PushNotifier.ts";
import * as PushRegistrations from "./PushRegistrations.ts";
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
  readonly redirect: RequestRedirect | undefined;
}

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number, url: string) => Response | Error;
    readonly activeSessions?: ReadonlyArray<string>;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly project?: Option.Option<{ readonly id: ProjectId; readonly title: string }>;
  } = {},
) {
  yield* TestClock.setTime(NOW_MS);
  const values = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: unused,
  });
  const registrations = yield* PushRegistrations.make({ allowInsecure: false }).pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
  );

  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const shellReads: ThreadId[] = [];
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

  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: init?.body as Uint8Array,
        redirect: init?.redirect,
      });
      const result =
        options.respond?.(sent.length, String(input)) ?? new Response(null, { status: 200 });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    { preconnect: () => {} },
  );

  const notifier = yield* PushNotifier.make.pipe(
    Effect.provideService(PushRegistrations.PushRegistrations, registrations),
    Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    Effect.provideService(ProjectService.ProjectService, projects),
    Effect.provideService(SessionStore.SessionStore, sessionStore),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
      getDescriptor: Effect.succeed({ label: "Server label" } as never),
    }),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

  const eventFor = (threadId: ThreadId, current: OrchestrationV2ThreadShell) =>
    ({
      id: EventId.make(`event:${threadId}:${Math.random()}`),
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

  return { registrations, notifier, currentShell, shellReads, sent, start, emit, revokeSession };
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
      assert.equal(stored.endpoint, "https://ntfy.example.test/upFirst?up=1");
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
      assert.equal(updated.endpoint, "https://ntfy.example.test/upMoved?up=1");

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
      assert.equal(sent[0]?.redirect, "manual");
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
