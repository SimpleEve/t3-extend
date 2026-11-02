// @effect-diagnostics nodeBuiltinImport:off -- The test runs a real loopback HTTP server.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfigModule from "../../config.ts";
import { ALLOW_INSECURE_PUSH_ENDPOINTS_ENV, validatePushEndpoint } from "./pushEndpoint.ts";
import * as PushTransport from "./pushTransport.ts";

const PUBLIC = "93.184.216.34";
const lookupOnce = (
  lookup: ReturnType<typeof PushTransport.makeGuardedLookup>,
  hostname: string,
  all = false,
) =>
  new Promise<{ error: NodeJS.ErrnoException | null; result: unknown; family?: number }>(
    (resolve) => {
      lookup(hostname, { all }, (error, result, family) =>
        resolve({ error, result, ...(family === undefined ? {} : { family }) }),
      );
    },
  );
const guard = (answers: Record<string, ReadonlyArray<string>>, localAddresses: string[] = []) =>
  PushTransport.makeGuardedLookup({
    resolve: (hostname) =>
      Promise.resolve(
        (answers[hostname] ?? []).map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      ),
    localAddresses: () => localAddresses,
    allowPrivate: false,
  });

describe("guarded lookup", () => {
  it("lets a name through when every address it resolves to is public", async () => {
    const lookup = guard({ "push.example.test": [PUBLIC, "2606:4700:4700::1111"] });
    const single = await lookupOnce(lookup, "push.example.test");
    assert.equal(single.error, null);
    assert.equal(single.result, PUBLIC);
    assert.equal(single.family, 4);
    const all = await lookupOnce(lookup, "push.example.test", true);
    assert.deepStrictEqual(all.result, [
      { address: PUBLIC, family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it.each([
    ["loopback", ["127.0.0.1"]],
    ["a LAN address", ["192.168.1.20"]],
    ["the metadata address", ["169.254.169.254"]],
    ["CGNAT", ["100.64.0.9"]],
    ["IPv6 loopback", ["::1"]],
    ["a mapped private address", ["::ffff:10.0.0.1"]],
    ["nothing at all", []],
  ])("refuses a name that resolves to %s", async (_label, addresses) => {
    const outcome = await lookupOnce(
      guard({ "push.example.test": addresses }),
      "push.example.test",
    );
    assert.equal((outcome.error as { code?: string } | null)?.code, "EPUSHBLOCKED");
    assert.equal(outcome.result, undefined);
  });

  it("refuses a name when any one of several addresses is non-public", async () => {
    const lookup = guard({ "rebind.example.test": [PUBLIC, "10.0.0.1"] });
    for (const all of [false, true]) {
      const outcome = await lookupOnce(lookup, "rebind.example.test", all);
      assert.equal((outcome.error as { code?: string } | null)?.code, "EPUSHBLOCKED");
    }
  });

  it("refuses a name that resolves to one of this machine's own addresses", async () => {
    const outcome = await lookupOnce(
      guard({ "self.example.test": [PUBLIC] }, [PUBLIC]),
      "self.example.test",
    );
    assert.equal((outcome.error as { code?: string } | null)?.code, "EPUSHBLOCKED");
  });

  it("asks again on every connection, so a rebind between connections is caught", async () => {
    let answer = [PUBLIC];
    const lookup = PushTransport.makeGuardedLookup({
      resolve: () => Promise.resolve(answer.map((address) => ({ address, family: 4 }))),
      localAddresses: () => [],
      allowPrivate: false,
    });
    assert.equal((await lookupOnce(lookup, "flip.example.test")).error, null);
    answer = ["127.0.0.1"];
    assert.equal(
      ((await lookupOnce(lookup, "flip.example.test")).error as { code?: string }).code,
      "EPUSHBLOCKED",
    );
  });

  it("passes resolver failures through", async () => {
    const lookup = PushTransport.makeGuardedLookup({
      resolve: () => Promise.reject(Object.assign(new Error("nope"), { code: "ENOTFOUND" })),
      localAddresses: () => [],
      allowPrivate: false,
    });
    assert.equal(
      ((await lookupOnce(lookup, "x.example.test")).error as { code?: string }).code,
      "ENOTFOUND",
    );
  });
});

describe("push transport", () => {
  const post = (transport: PushTransport.PushTransport["Service"], url: string) =>
    transport.post({
      url,
      headers: { "content-encoding": "aes128gcm" },
      body: new Uint8Array([1]),
    });

  it.effect("refuses a name that resolves to a private address before connecting", () =>
    Effect.gen(function* () {
      const transport = yield* PushTransport.make({
        allowPrivate: false,
        resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
        localAddresses: () => [],
      });
      const error = yield* post(transport, "https://push.example.test/upTopic").pipe(Effect.flip);
      assert.equal(error.reason, "blocked");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an IP written out in the URL, which never reaches the lookup", () =>
    Effect.gen(function* () {
      const transport = yield* PushTransport.make({
        allowPrivate: false,
        localAddresses: () => [],
      });
      for (const url of [
        "https://127.0.0.1:1/up",
        "https://[::1]:1/up",
        "https://169.254.169.254/latest/meta-data",
        "https://[::ffff:10.0.0.1]/up",
      ]) {
        assert.equal((yield* post(transport, url).pipe(Effect.flip)).reason, "blocked");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reads only the status and neither follows redirects nor waits for a body", () =>
    Effect.gen(function* () {
      const seen: Array<{ host: string | undefined; encoding: string | undefined }> = [];
      const server = NodeHttp.createServer((request, response) => {
        seen.push({
          host: request.headers.host,
          encoding: request.headers["content-encoding"] as string | undefined,
        });
        response.writeHead(307, { location: "http://127.0.0.1:1/elsewhere" });
        response.write("x".repeat(1024));
        // Never ends: a reader waiting for the body would hang.
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
      );
      const port = (server.address() as NodeNet.AddressInfo).port;
      const transport = yield* PushTransport.make({
        allowPrivate: true,
        resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      });
      const status = yield* post(transport, `http://push.example.test:${port}/upTopic`);
      assert.equal(status, 307);
      // The Host header keeps the name the certificate would be checked against.
      assert.deepStrictEqual(seen, [{ host: `push.example.test:${port}`, encoding: "aes128gcm" }]);
    }).pipe(Effect.scoped),
  );
});

// What `new URL` makes of a host decides which check sees it: an address is judged where it is
// written out, a name only when the socket looks it up. Neither may lead to a connection.
describe("host normalisation", () => {
  const literal = [
    ["decimal IPv4", "https://2130706433/up", "127.0.0.1"],
    ["hex IPv4", "https://0x7f.1/up", "127.0.0.1"],
    ["whole-address hex IPv4", "https://0x7f000001/up", "127.0.0.1"],
    ["octal IPv4", "https://0177.0.0.1/up", "127.0.0.1"],
    ["IPv4 with ideographic dots", "https://127\u30020\u30020\u30021/up", "127.0.0.1"],
    ["mapped IPv6", "https://[::ffff:127.0.0.1]/up", "[::ffff:7f00:1]"],
  ] as const;
  const named = [
    ["a trailing dot", "https://localhost./up", "localhost."],
    [
      "full-width letters",
      "https://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54/up",
      "localhost",
    ],
    ["an IDNA name", "https://b\u00fccher.example/up", "xn--bcher-kva.example"],
  ] as const;
  const zoned = "https://[fe80::1%25eth0]/up";

  it("parses to the host the checks will see", () => {
    for (const [label, url, hostname] of [...literal, ...named]) {
      assert.equal(new URL(url).hostname, hostname, label);
    }
    // A zone id is not valid in a URL host, so nothing with one gets as far as a socket.
    assert.throws(() => new URL(zoned));
  });

  it("is refused at registration whenever it points at this machine", () => {
    for (const [label, url] of [...literal, ...named.slice(0, 2)]) {
      assert.equal(validatePushEndpoint(url, { allowInsecure: false }), null, label);
    }
    assert.equal(validatePushEndpoint(zoned, { allowInsecure: false }), null);
    assert.equal(
      validatePushEndpoint(named[2][1], { allowInsecure: false })?.host,
      "xn--bcher-kva.example",
    );
  });

  it.effect("is refused by the transport before a socket is opened", () =>
    Effect.gen(function* () {
      let connections = 0;
      const server = NodeHttp.createServer((_request, response) => response.end());
      server.on("connection", () => void (connections += 1));
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
      );
      const port = (server.address() as NodeNet.AddressInfo).port;
      const looked: string[] = [];
      const transport = yield* PushTransport.make({
        allowPrivate: false,
        resolve: (hostname) => {
          looked.push(hostname);
          return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
        },
        localAddresses: () => [],
      });
      const send = (url: string) =>
        transport.post({ url, headers: {}, body: new Uint8Array([1]) }).pipe(Effect.flip);

      for (const [label, url] of literal) {
        const target = new URL(url);
        target.port = String(port);
        assert.equal((yield* send(target.toString())).reason, "blocked", label);
      }
      assert.deepStrictEqual(looked, [], "a written-out address is not looked up");

      // Names are resolved on the way in, and the address they lead to is what is judged.
      for (const [label, url, hostname] of named) {
        const target = new URL(url);
        target.port = String(port);
        looked.length = 0;
        assert.equal((yield* send(target.toString())).reason, "blocked", label);
        assert.deepStrictEqual(looked, [hostname], label);
      }

      // Never parsed, so never sent.
      assert.equal((yield* send(zoned)).reason, "unreachable");
      assert.equal(connections, 0);
    }).pipe(Effect.scoped),
  );
});

describe("the insecure-endpoints variable", () => {
  // The agent lives as long as the layer's scope, so the sends happen inside it.
  const withTransport = <A, E>(
    environment: NodeJS.ProcessEnv,
    devUrl: URL | undefined,
    use: (transport: PushTransport.PushTransport["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const config = yield* ServerConfigModule.ServerConfig;
      return yield* Effect.gen(function* () {
        return yield* use(yield* PushTransport.PushTransport);
      }).pipe(
        Effect.provide(PushTransport.layer),
        Effect.provideService(ServerConfigModule.ServerConfig, { ...config, devUrl }),
        Effect.provideService(HostProcess.Environment, environment),
      );
    });

  it.effect("is ignored outside development and honoured in development", () =>
    Effect.gen(function* () {
      const server = NodeHttp.createServer((_request, response) => response.end());
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
      );
      const url = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/up`;
      const send = (transport: PushTransport.PushTransport["Service"]) =>
        transport.post({ url, headers: {}, body: new Uint8Array([1]) });
      const on = { [ALLOW_INSECURE_PUSH_ENDPOINTS_ENV]: "1" };
      const dev = new URL("http://localhost:5733");

      const packaged = yield* withTransport(on, undefined, (transport) =>
        send(transport).pipe(Effect.flip),
      );
      assert.equal(packaged.reason, "blocked");

      assert.equal(yield* withTransport(on, dev, send), 200);

      // In development it still takes the variable to switch the protection off.
      const without = yield* withTransport({}, dev, (transport) =>
        send(transport).pipe(Effect.flip),
      );
      assert.equal(without.reason, "blocked");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-push-transport-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
