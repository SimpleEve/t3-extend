// @effect-diagnostics nodeBuiltinImport:off -- The test runs a real loopback HTTP server.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
