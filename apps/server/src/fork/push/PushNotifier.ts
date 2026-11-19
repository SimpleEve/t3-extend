import {
  isListedThreadLineage,
  PushNotificationPayload,
  type AuthSessionId,
  type OrchestrationV2ThreadShell,
  type Project,
  type PushDeliveryOutcome,
  type PushNotificationKind,
  type PushTestResult,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
} from "../../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PushApns from "./PushApns.ts"; // fork: iOS
import * as PushRegistrations from "./PushRegistrations.ts";
import * as PushTransport from "./pushTransport.ts";
import {
  buildPushPayload,
  COMPLETION_CONFIRMATION_MS,
  decideThreadAlert,
  preferenceAllows,
  type PhaseMemory,
} from "./pushTriggers.ts";
import { decodeWebPushKeys, encryptWebPush } from "./webPush.ts";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(PushNotificationPayload));
const DELIVERY_TIMEOUT = "10 seconds";
const DELIVERY_RETRY_DELAYS = ["1 second", "3 seconds"] as const;

export class PushNotifier extends Context.Service<
  PushNotifier,
  {
    /** Watches threads and pushes the same moments the T3 Connect relay would. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sendTest: (input: {
      readonly sessionId: AuthSessionId;
      readonly deviceId: string;
    }) => Effect.Effect<PushTestResult>;
    /** Records which threads are already waiting or finished, so they do not alert when a device first registers. */
    readonly prepare: Effect.Effect<void>;
    /** Resolves once queued thread updates and their deliveries have finished. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fork/push/PushNotifier") {}

interface DeliveryJob {
  readonly registration: PushRegistrations.StoredPushRegistration;
  readonly payload: ReturnType<typeof buildPushPayload>;
}

const outcomeForStatus = (status: number): PushDeliveryOutcome => {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 404 || status === 410) return "gone";
  return "rejected";
};

const isTransient = (result: {
  readonly outcome: PushDeliveryOutcome;
  readonly status: number | null;
}) =>
  result.outcome === "unreachable" ||
  (result.outcome === "rejected" && (result.status === 429 || (result.status ?? 0) >= 500));

export const make = Effect.gen(function* () {
  const registrations = yield* PushRegistrations.PushRegistrations;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const sessions = yield* SessionStore.SessionStore;
  const transport = yield* PushTransport.PushTransport;
  const apns = yield* PushApns.PushApns;
  const scope = yield* Effect.scope;

  // Last phase seen per thread; only moves into a new alertable phase notify.
  const memory = new Map<ThreadId, PhaseMemory>();
  // A completion waits before alerting, because a continuation can follow within moments.
  const completionDeadlines = new Map<ThreadId, number>();
  let seeded = false;

  const deliverOnce = Effect.fn("PushNotifier.deliverOnce")(function* (job: DeliveryJob) {
    // An iPhone is pushed to directly through Apple, with the alert text already written out.
    const registration = job.registration;
    if (PushRegistrations.isApnsRegistration(registration)) {
      return yield* apns.send({ registration, payload: job.payload });
    }
    const keys = decodeWebPushKeys(registration.p256dh, registration.auth);
    if (keys === null) return { outcome: "rejected", status: null } as const;
    const body = encryptWebPush({
      plaintext: new TextEncoder().encode(encodePayload(job.payload)),
      keys,
    });
    return yield* transport
      .post({
        url: registration.endpoint,
        headers: { "content-encoding": "aes128gcm", ttl: "3600", urgency: "high" },
        body,
      })
      .pipe(
        // The transport bounds connecting and the response head; this bounds the whole attempt.
        Effect.timeout(DELIVERY_TIMEOUT),
        Effect.map((status) => ({ outcome: outcomeForStatus(status), status }) as const),
        Effect.catch((error) =>
          (error._tag === "PushTransportError" && error.reason === "blocked"
            ? Effect.logWarning("push endpoint refused: it leads to a non-public address", {
                host: PushRegistrations.endpointHost(registration.endpoint),
              })
            : Effect.void
          ).pipe(Effect.as({ outcome: "unreachable", status: null } as const)),
        ),
      );
  });

  // A registration file that cannot be written must not stop alerts or the loops around them.
  const keepGoing = (what: string) =>
    Effect.catch((error: { readonly reason: string }) =>
      Effect.logWarning(`push registrations: ${what} failed`, { reason: error.reason }),
    );

  const deliver = Effect.fn("PushNotifier.deliver")(function* (job: DeliveryJob) {
    let result = yield* deliverOnce(job);
    for (const delay of DELIVERY_RETRY_DELAYS) {
      if (!isTransient(result)) break;
      yield* Effect.sleep(delay);
      result = yield* deliverOnce(job);
    }
    yield* registrations
      .recordDelivery(
        job.registration,
        { outcome: result.outcome, httpStatus: result.status },
        "switchedTo" in result ? result.switchedTo : undefined,
      )
      .pipe(keepGoing("recording a delivery"));
    // Only the host is logged: the endpoint and the device token are credentials.
    yield* Effect.logInfo("push delivery finished", {
      host: PushRegistrations.registrationHost(job.registration),
      kind: job.payload.kind,
      outcome: result.outcome,
      status: result.status,
    });
    if (result.outcome === "gone") {
      yield* registrations
        .removeIfCurrent(job.registration)
        .pipe(keepGoing("removing an expired registration"));
    }
    return result;
  });

  const deliveries = yield* makeDrainableWorker((job: DeliveryJob) =>
    deliver(job).pipe(Effect.asVoid),
  );

  const activeSessionIds = sessions.listActive().pipe(
    Effect.map((active) => new Set<string>(active.map((session) => session.sessionId))),
    Effect.option,
  );

  const notify = Effect.fn("PushNotifier.notify")(function* (input: {
    readonly kind: PushNotificationKind;
    readonly shell: OrchestrationV2ThreadShell;
    readonly project: Project;
    readonly updatedAt: string;
  }) {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const descriptor = yield* serverEnvironment.getDescriptor;
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const active = yield* activeSessionIds;
    if (Option.isSome(active)) {
      yield* registrations
        .retainSessions(active.value)
        .pipe(keepGoing("dropping registrations of ended sessions"));
    }
    // Memory may still hold an ended session when its clean-up could not be saved; it gets nothing.
    const targets = (yield* registrations.list).filter(
      (registration) =>
        (Option.isNone(active) || active.value.has(registration.sessionId)) &&
        preferenceAllows(registration.preferences, input.kind),
    );
    yield* Effect.forEach(
      targets,
      (registration) =>
        deliveries.enqueue({
          registration,
          payload: buildPushPayload({
            kind: input.kind,
            environmentId,
            environmentLabel: registration.environmentLabel || descriptor.label,
            threadId: input.shell.id,
            threadTitle: input.shell.title,
            projectTitle: input.project.title,
            updatedAt: input.updatedAt,
            nowMs,
          }),
        }),
      { discard: true },
    );
  });

  const seed = Effect.gen(function* () {
    if (seeded) return;
    seeded = true;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const projectSnapshot = yield* projects.snapshot;
    const projectById = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
    // Subagents and side chats never alert, and they are most threads.
    const topLevelIds = (yield* threads.listActiveShellIndex()).flatMap((thread) =>
      isListedThreadLineage(thread.lineage) ? [thread.id] : [],
    );
    const snapshot = yield* threads.getShellSnapshot({
      location: "active",
      threadIds: topLevelIds,
    });
    for (const thread of snapshot.threads) {
      const project = projectById.get(thread.projectId);
      const state =
        project === undefined ? null : projectThreadAwarenessV2({ environmentId, project, thread });
      // What is already waiting or finished when we start is not news.
      memory.set(thread.id, state?.phase ?? "none");
    }
  });

  let scheduleConfirmation: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const processThread = Effect.fn("PushNotifier.processThread")(function* (threadId: ThreadId) {
    // No device registered means no reason to read anything.
    if ((yield* registrations.list).length === 0) {
      // Phases are not tracked while nobody listens; the next device starts from a fresh baseline.
      seeded = false;
      memory.clear();
      completionDeadlines.clear();
      return;
    }
    yield* seed;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const shell = yield* threads.getThreadShell(threadId);
    // A thread this environment does not have, or a subagent or side chat, never alerts.
    if (shell === null || !isListedThreadLineage(shell.lineage)) {
      memory.delete(threadId);
      completionDeadlines.delete(threadId);
      return;
    }
    const projectOption =
      shell.archivedAt === null ? yield* projects.getById(shell.projectId) : Option.none<Project>();
    const project = Option.getOrUndefined(projectOption);
    const projectState = (shellForProjection: OrchestrationV2ThreadShell) =>
      project === undefined
        ? null
        : projectThreadAwarenessV2({ environmentId, project, thread: shellForProjection });
    let state = projectState(shell);
    const previous = memory.get(threadId) ?? "none";
    const nowMs = (yield* DateTime.now).epochMilliseconds;

    const held = completionDeadlines.get(threadId);
    const completionPending =
      previous !== "completed" && (state?.phase === "completed" || held !== undefined);
    if (completionPending) {
      if (held === undefined) {
        completionDeadlines.set(threadId, nowMs + COMPLETION_CONFIRMATION_MS);
        yield* scheduleConfirmation(threadId);
        return;
      }
      if (nowMs < held) return;
      completionDeadlines.delete(threadId);
      // Settled during the hold, not resumed: the completion still counts.
      if (state === null && shell.settledOverride === "settled") {
        state = projectState({ ...shell, settledOverride: null });
        if (state?.phase !== "completed") state = null;
      }
    }

    const decision = decideThreadAlert({ previous, next: state, nowMs });
    memory.set(threadId, decision.memory);
    if (decision.kind === null || state === null || project === undefined) return;
    yield* notify({ kind: decision.kind, shell, project, updatedAt: state.updatedAt });
  });

  const worker = yield* makeAgentAwarenessPublishWorker((threadId: ThreadId) =>
    processThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("push notification evaluation failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  scheduleConfirmation = (threadId) =>
    Effect.sleep(COMPLETION_CONFIRMATION_MS).pipe(
      Effect.andThen(worker.enqueue(threadId)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const sendTest: PushNotifier["Service"]["sendTest"] = Effect.fn("PushNotifier.sendTest")(
    function* ({ sessionId, deviceId }) {
      const registration = Option.getOrUndefined(yield* registrations.getBySession(sessionId));
      if (registration === undefined || registration.deviceId !== deviceId) {
        return { registered: false, outcome: null, httpStatus: null };
      }
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const descriptor = yield* serverEnvironment.getDescriptor;
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const result = yield* deliver({
        registration,
        payload: buildPushPayload({
          kind: "test",
          environmentId,
          environmentLabel: registration.environmentLabel || descriptor.label,
          threadId: "",
          threadTitle: "",
          projectTitle: "",
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          nowMs,
        }),
      });
      return { registered: true, outcome: result.outcome, httpStatus: result.status };
    },
  );

  const start: PushNotifier["Service"]["start"] = Effect.fn("PushNotifier.start")(function* () {
    // A session that ended while the server was down (or expired) no longer gets pushes.
    const active = yield* activeSessionIds;
    if (Option.isSome(active)) {
      yield* registrations
        .retainSessions(active.value)
        .pipe(keepGoing("dropping registrations of ended sessions"));
    }
    yield* forkParked(
      Stream.runForEach(sessions.streamChanges, (change) =>
        change.type === "clientRemoved"
          ? registrations
              .removeSession(change.sessionId)
              .pipe(Effect.asVoid, keepGoing("dropping a revoked session's registration"))
          : Effect.void,
      ),
    );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
      ),
    );
  });

  return PushNotifier.of({
    start,
    sendTest,
    prepare: seed.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("push baseline snapshot failed", { cause: Cause.pretty(cause) }),
      ),
    ),
    drain: worker.drain.pipe(Effect.andThen(deliveries.drain)),
  });
});

export const layer = Layer.effect(PushNotifier, make).pipe(
  Layer.provide(PushTransport.layer),
  Layer.provide(PushApns.layer), // fork: iOS
);
