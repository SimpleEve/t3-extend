// @effect-diagnostics nodeBuiltinImport:off -- The check plays the phone, which holds raw P-256 keys.
// @effect-diagnostics *:off -- A throwaway check that prints what it sees.
// fork: end-to-end check of the push path against a real ntfy server.
//
//   # server.yml needs /var/cache/ntfy and /var/lib/ntfy, which the image lacks; compose mounts volumes there too.
//   docker run -d --name t3x-push-ntfy -p 127.0.0.1:18085:80 \
//     -e NTFY_BASE_URL=http://127.0.0.1:18085 -e NTFY_PASSWORD=... \
//     -v "$PWD/infra/self-host/ntfy/server.yml:/etc/ntfy/server.yml:ro" \
//     -v t3x-push-ntfy-cache:/var/cache/ntfy -v t3x-push-ntfy-data:/var/lib/ntfy \
//     binwiederhier/ntfy:v2.36.0 serve
//   docker exec -e NTFY_PASSWORD=... t3x-push-ntfy ntfy user add phone
//   docker exec t3x-push-ntfy ntfy access phone 'up*' read-only
//   node scripts/verify-ntfy-push.ts http://127.0.0.1:18085 phone ...
//
// It registers a fake device with test keys, triggers an approval request and a test
// notification through the real services, reads both from ntfy's JSON stream as the
// phone's distributor would, and decrypts them with the test private key.
import * as NodeCrypto from "node:crypto";

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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as SessionStore from "../src/auth/SessionStore.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as PushNotifier from "../src/fork/push/PushNotifier.ts";
import * as PushApns from "../src/fork/push/PushApns.ts";
import * as PushRegistrations from "../src/fork/push/PushRegistrations.ts";
import * as PushTransport from "../src/fork/push/pushTransport.ts";
import { decryptWebPush } from "../src/fork/push/webPush.ts";
import * as ThreadManagement from "../src/orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../src/project/ProjectService.ts";

const [baseUrl, user, password] = process.argv.slice(2);
if (baseUrl === undefined || user === undefined || password === undefined) {
  console.error("usage: verify-ntfy-push.ts <ntfy base url> <reader user> <reader password>");
  process.exit(2);
}

const lines: string[] = [];
const say = (text: string) => {
  lines.push(text);
  console.log(text);
};
const check = (label: string, ok: boolean, detail = "") => {
  say(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
  if (!ok) process.exitCode = 1;
};
const basic = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(PushNotificationPayload));

const topic = `upT3xCheck${NodeCrypto.randomBytes(6).toString("hex")}`;
const endpoint = `${baseUrl}/${topic}`;
const ENVIRONMENT_ID = EnvironmentId.make("verify-environment");
const PROJECT_ID = ProjectId.make("verify-project");
const THREAD_ID = ThreadId.make("verify-thread");
const NOW = new Date().toISOString();

const awaitingApproval = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Fix the flaky build",
  lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
  archivedAt: null,
  settledOverride: null,
  status: "running",
  activityRunStatus: null,
  pendingRuntimeRequest: {
    id: "request-1",
    kind: "dynamic_tool_call",
    createdAt: DateTime.makeUnsafe(NOW),
  },
  pendingBackgroundTasks: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  updatedAt: DateTime.makeUnsafe(NOW),
} as unknown as OrchestrationV2ThreadShell;

interface StreamedMessage {
  readonly event: string;
  readonly message?: string;
  readonly encoding?: string;
}

/** What the distributor does: follow the topic and hand over each message's bytes. */
async function* followTopic(signal: AbortSignal): AsyncGenerator<Buffer> {
  const response = await fetch(`${endpoint}/json`, { headers: { authorization: basic }, signal });
  if (!response.ok || response.body === null) {
    throw new Error(`reader could not follow the topic: HTTP ${response.status}`);
  }
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (line === "") continue;
      const message = JSON.parse(line) as StreamedMessage;
      if (message.event !== "message") continue;
      say(
        `stream  event=message encoding=${message.encoding ?? "none"} bytes=${message.message?.length ?? 0}`,
      );
      yield message.encoding === "base64"
        ? Buffer.from(message.message ?? "", "base64")
        : Buffer.from(message.message ?? "", "utf8");
    }
  }
}

const program = Effect.gen(function* () {
  say(`ntfy ${baseUrl}  topic ${topic.slice(0, 8)}…  (full topic not logged)`);

  // Access control, from outside, the way a stranger would see it.
  const anonymousRead = await_(fetch(`${endpoint}/json?poll=1`));
  check(
    "anonymous read of an up topic is denied",
    [401, 403].includes((yield* anonymousRead).status),
  );
  const anonymousWriteElsewhere = yield* await_(
    fetch(`${baseUrl}/ordinarytopic`, { method: "POST", body: "x" }),
  );
  check(
    "anonymous write to a topic outside up* is denied",
    [401, 403].includes(anonymousWriteElsewhere.status),
  );

  const receiver = NodeCrypto.createECDH("prime256v1");
  receiver.generateKeys();
  const auth = NodeCrypto.randomBytes(16);

  const values = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const registrations = yield* PushRegistrations.make({ allowInsecure: true }).pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
  );

  const current = yield* Ref.make<OrchestrationV2ThreadShell | null>({
    ...awaitingApproval,
    pendingRuntimeRequest: null,
  } as OrchestrationV2ThreadShell);
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const threads = {
    getThreadShell: () => Ref.get(current),
    getShellSnapshot: () =>
      Ref.get(current).pipe(
        Effect.map((shell) => ({ threads: shell === null ? [] : [shell], archivedThreads: [] })),
      ),
    listActiveShellIndex: () =>
      Effect.succeed([{ id: THREAD_ID, lineage: awaitingApproval.lineage }]),
    streamDomainEvents: Stream.fromQueue(events),
  } as unknown as ThreadManagement.ThreadManagementService["Service"];
  const projects = {
    getById: () => Effect.succeed(Option.some({ id: PROJECT_ID, title: "Web app" })),
    snapshot: Effect.succeed({ projects: [{ id: PROJECT_ID, title: "Web app" }] }),
  } as unknown as ProjectService.ProjectService["Service"];
  const sessions = {
    listActive: () => Effect.succeed([{ sessionId: "verify-session" }]),
    streamChanges: Stream.never,
  } as unknown as SessionStore.SessionStore["Service"];

  const notifier = yield* PushNotifier.make.pipe(
    Effect.provideService(PushRegistrations.PushRegistrations, registrations),
    Effect.provideService(PushApns.PushApns, PushApns.disabled),
    Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    Effect.provideService(ProjectService.ProjectService, projects),
    Effect.provideService(SessionStore.SessionStore, sessions),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
      getDescriptor: Effect.succeed({ label: "Verification host" } as never),
    }),
    // The check runs against a loopback ntfy, which a real environment refuses.
    Effect.provideService(
      PushTransport.PushTransport,
      yield* PushTransport.make({ allowPrivate: true }),
    ),
  );

  yield* registrations.upsert({
    sessionId: AuthSessionId.make("verify-session"),
    registration: {
      deviceId: "verify-device",
      label: "Fake phone",
      environmentLabel: "Verification host",
      endpoint,
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
      preferences: {
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    },
  });
  say("registered a fake device with test keys");
  yield* notifier.prepare;
  yield* notifier.start();

  const abort = new AbortController();
  const received: Buffer[] = [];
  const follower = (async () => {
    try {
      for await (const bytes of followTopic(abort.signal)) received.push(bytes);
    } catch (error) {
      if (!abort.signal.aborted) say(`follower stopped: ${String(error)}`);
    }
  })();
  const waitFor = (count: number) =>
    Effect.promise(async () => {
      const deadline = Date.now() + 15_000;
      while (received.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  yield* Effect.sleep("1 second");

  const test = yield* notifier.sendTest({
    sessionId: AuthSessionId.make("verify-session"),
    deviceId: "verify-device",
  });
  check(
    "test notification: server reports delivered",
    test.outcome === "delivered",
    `HTTP ${test.httpStatus}`,
  );
  yield* waitFor(1);

  yield* Ref.set(current, awaitingApproval);
  yield* Queue.offer(events, {
    id: EventId.make("event:verify"),
    type: "thread.settled",
    threadId: THREAD_ID,
    occurredAt: DateTime.makeUnsafe(NOW),
    payload: awaitingApproval,
  } as unknown as OrchestrationV2DomainEvent);
  yield* Effect.sleep("500 millis");
  yield* notifier.drain;
  yield* waitFor(2);

  abort.abort();
  yield* Effect.promise(() => follower);

  check("two messages came out of the stream", received.length === 2, `${received.length}`);
  const payloads = received.map((bytes) => {
    try {
      return decodePayload(decryptWebPush(bytes, receiver.getPrivateKey(), auth).toString("utf8"));
    } catch (error) {
      say(`decrypt failed: ${String(error)}`);
      return null;
    }
  });
  check(
    "both decrypt with the test private key",
    payloads.every((payload) => payload !== null),
  );
  for (const payload of payloads) {
    say(`decrypted  ${JSON.stringify(payload)}`);
  }
  check(
    "test message",
    payloads[0]?.kind === "test" && payloads[0].environmentLabel === "Verification host",
  );
  check(
    "approval message carries the thread, project and environment ids",
    payloads[1]?.kind === "approval" &&
      payloads[1].threadId === THREAD_ID &&
      payloads[1].threadTitle === "Fix the flaky build" &&
      payloads[1].projectTitle === "Web app" &&
      payloads[1].environmentId === ENVIRONMENT_ID,
  );
  const wrongKey = NodeCrypto.createECDH("prime256v1");
  wrongKey.generateKeys();
  let leaked = true;
  try {
    decryptWebPush(received[0]!, wrongKey.getPrivateKey(), auth);
  } catch {
    leaked = false;
  }
  check("another key cannot decrypt what the push server stored", !leaked);
  check(
    "the push server never saw the plaintext",
    !received.some((bytes) => bytes.toString("utf8").includes("Fix the flaky build")),
  );

  const stored = (yield* registrations.list)[0];
  check(
    "last delivery recorded on the registration",
    stored?.lastDelivery?.outcome === "delivered",
  );
});

const await_ = <A>(promise: Promise<A>) => Effect.promise(() => promise);

await Effect.runPromise(program.pipe(Effect.scoped));
const transcript = process.env.T3X_PUSH_TRANSCRIPT;
if (transcript !== undefined) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(transcript, `${lines.join("\n")}\n`);
}
process.exit(process.exitCode ?? 0);
