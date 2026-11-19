// @effect-diagnostics nodeBuiltinImport:off -- A local HTTP/2 server stands in for Apple's gateway.
import * as NodeHttp2 from "node:http2";
import type * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ApnsTransport from "./apnsTransport.ts";

interface Received {
  readonly path: string;
  readonly headers: NodeHttp2.IncomingHttpHeaders;
  readonly body: string;
}

// Cleartext HTTP/2 on loopback: the transport's only difference from Apple's host is the origin.
const gateway = (respond: (received: Received) => { status: number; body: string }) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ origin: string; received: Received[]; server: NodeHttp2.Http2Server }>(
          (resolve) => {
            const received: Received[] = [];
            const server = NodeHttp2.createServer((request, response) => {
              let body = "";
              request.on("data", (chunk) => (body += chunk));
              request.on("end", () => {
                const entry = { path: request.url, headers: request.headers, body };
                received.push(entry);
                const answer = respond(entry);
                response.writeHead(answer.status, { "content-type": "application/json" });
                response.end(answer.body);
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
