// @effect-diagnostics nodeBuiltinImport:off -- A local HTTP/2 server stands in for Apple's gateway.
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ApnsTransport from "./apnsTransport.ts";

interface Received {
  readonly path: string;
  readonly headers: NodeHttp2.IncomingHttpHeaders;
  readonly body: string;
}

// What the fake gateway does with one request: answer it, never answer, or reset just that stream.
type Answer = { status: number; body: string } | "reset" | null;

// Cleartext HTTP/2 on loopback: the transport's only difference from Apple's host is the origin.
const gateway = (respond: (received: Received) => Answer | Promise<Answer>) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ origin: string; received: Received[]; server: NodeHttp2.Http2Server }>(
          (resolve) => {
            const received: Received[] = [];
            const server = NodeHttp2.createServer((request, response) => {
              // A null answer stands for a connection that went quiet: the request is never answered.
              let body = "";
              request.on("data", (chunk) => (body += chunk));
              request.on("end", () => {
                const entry = { path: request.url, headers: request.headers, body };
                received.push(entry);
                void Promise.resolve(respond(entry)).then((answer) => {
                  if (answer === null) return;
                  if (answer === "reset") {
                    request.stream.close(NodeHttp2.constants.NGHTTP2_REFUSED_STREAM);
                    return;
                  }
                  response.writeHead(answer.status, { "content-type": "application/json" });
                  response.end(answer.body);
                });
              });
            });
            server.listen(0, "127.0.0.1", () => {
              const { port } = server.address() as NodeNet.AddressInfo;
              resolve({ origin: `http://127.0.0.1:${port}`, received, server });
            });
          },
        ),
    ),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

// A TCP hop the test can cut: after `cut()` the connections already through it swallow everything,
// like a network that dropped a connection without telling either end.
const cuttableHop = (origin: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ origin: string; cut: () => void; close: () => Promise<void> }>((resolve) => {
          const target = Number(new URL(origin).port);
          const links = new Set<{ cut: boolean }>();
          const sockets = new Set<NodeNet.Socket>();
          const hop = NodeNet.createServer((client) => {
            const upstream = NodeNet.connect(target, "127.0.0.1");
            const link = { cut: false };
            links.add(link);
            sockets.add(client).add(upstream);
            client.on("data", (chunk) => link.cut || upstream.write(chunk));
            upstream.on("data", (chunk) => link.cut || client.write(chunk));
            client.on("error", () => upstream.destroy());
            upstream.on("error", () => client.destroy());
            client.on("close", () => upstream.destroy());
            upstream.on("close", () => client.destroy());
          });
          hop.listen(0, "127.0.0.1", () => {
            const { port } = hop.address() as NodeNet.AddressInfo;
            resolve({
              origin: `http://127.0.0.1:${port}`,
              cut: () => links.forEach((link) => (link.cut = true)),
              close: () =>
                new Promise<void>((done) => {
                  for (const socket of sockets) socket.destroy();
                  hop.close(() => done());
                }),
            });
          });
        }),
    ),
    ({ close }) => Effect.promise(close),
  );

const input = {
  apsEnvironment: "production",
  deviceToken: "ab".repeat(32),
  headers: { authorization: "bearer jwt", "apns-topic": "com.example.app" },
  body: '{"aps":{}}',
} as const;

it.live("posts to the device path with the headers and body, and reads Apple's reason", () =>
  Effect.gen(function* () {
    const { origin, received } = yield* gateway(() => ({
      status: 400,
      body: '{"reason":"BadDeviceToken"}',
    }));
    const transport = yield* ApnsTransport.make({ origin: () => origin });
    const result = yield* transport.send(input);
    assert.deepStrictEqual(result, { status: 400, reason: "BadDeviceToken" });
    assert.equal(received[0]?.path, `/3/device/${"ab".repeat(32)}`);
    assert.equal(received[0]?.headers["apns-topic"], "com.example.app");
    assert.equal(received[0]?.headers["authorization"], "bearer jwt");
    assert.equal(received[0]?.body, '{"aps":{}}');
  }).pipe(Effect.scoped),
);

it.live("reuses one connection and gives no reason for a success", () =>
  Effect.gen(function* () {
    const { origin, received } = yield* gateway(() => ({ status: 200, body: "" }));
    const transport = yield* ApnsTransport.make({ origin: () => origin });
    assert.deepStrictEqual(yield* transport.send(input), { status: 200, reason: null });
    assert.deepStrictEqual(yield* transport.send(input), { status: 200, reason: null });
    assert.equal(received.length, 2);
  }).pipe(Effect.scoped),
);

it.live("fails with a typed error when the gateway cannot be reached", () =>
  Effect.gen(function* () {
    const transport = yield* ApnsTransport.make({ origin: () => "http://127.0.0.1:1" });
    const error = yield* transport.send(input).pipe(Effect.flip);
    assert.equal(error._tag, "ApnsTransportError");
  }).pipe(Effect.scoped),
);

it.live("drops a connection the network cut, so the next push opens a new one", () =>
  Effect.gen(function* () {
    // A connection dropped without a close looks open to Node, and its peer never answers a ping.
    const { origin, server } = yield* gateway(() => ({ status: 200, body: "" }));
    const hop = yield* cuttableHop(origin);
    let connections = 0;
    server.on("session", () => (connections += 1));
    const transport = yield* ApnsTransport.make({
      origin: () => hop.origin,
      responseTimeoutMs: 100,
      pingTimeoutMs: 100,
    });
    assert.deepStrictEqual(yield* transport.send(input), { status: 200, reason: null });
    hop.cut();
    assert.isTrue((yield* transport.send(input).pipe(Effect.result))._tag === "Failure");
    assert.deepStrictEqual(yield* transport.send(input), { status: 200, reason: null });
    assert.equal(connections, 2);
  }).pipe(Effect.scoped),
);

it.live("keeps a connection that still answers when one request got no answer", () =>
  Effect.gen(function* () {
    const { origin, server } = yield* gateway((received) =>
      received.headers["apns-topic"] === "silent" ? null : { status: 200, body: "" },
    );
    let connections = 0;
    server.on("session", () => (connections += 1));
    const transport = yield* ApnsTransport.make({
      origin: () => origin,
      responseTimeoutMs: 100,
      pingTimeoutMs: 100,
    });
    const silent = { ...input, headers: { ...input.headers, "apns-topic": "silent" } };
    assert.isTrue((yield* transport.send(silent).pipe(Effect.result))._tag === "Failure");
    assert.deepStrictEqual(yield* transport.send(input), { status: 200, reason: null });
    assert.equal(connections, 1);
  }).pipe(Effect.scoped),
);

it.live("a stream that fails leaves the other requests on the connection alone", () =>
  Effect.gen(function* () {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrived = () => {};
    const heldArrived = new Promise<void>((resolve) => (arrived = resolve));
    const { origin, server } = yield* gateway((received) => {
      const topic = received.headers["apns-topic"];
      if (topic === "reset") return "reset";
      if (topic !== "held") return { status: 200, body: "" };
      arrived();
      return gate.then(() => ({ status: 200, body: "" }));
    });
    let connections = 0;
    server.on("session", () => (connections += 1));
    const transport = yield* ApnsTransport.make({ origin: () => origin });
    const held = yield* transport
      .send({ ...input, headers: { ...input.headers, "apns-topic": "held" } })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => heldArrived);
    const refused = yield* transport
      .send({ ...input, headers: { ...input.headers, "apns-topic": "reset" } })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "ApnsTransportError");
    release();
    assert.deepStrictEqual(yield* Fiber.join(held), { status: 200, reason: null });
    assert.equal(connections, 1);
  }).pipe(Effect.scoped),
);
