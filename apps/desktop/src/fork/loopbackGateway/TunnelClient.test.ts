// @effect-diagnostics nodeBuiltinImport:off -- Socket-level tests against real loopback servers.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import * as Redacted from "effect/Redacted";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";

import { startFakeGateway, type FakeGateway } from "./fakeGateway.testkit.ts";
import { makeTlsFixtures, type TlsFixtures } from "./tlsFixtures.testkit.ts";
import { openLoopbackTunnel } from "./TunnelClient.ts";
import { classifyConnectError, GatewayTunnelError } from "./tunnelErrors.ts";

const TICKET = "ticket-body.signature";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startEcho = async (): Promise<number> => {
  const server = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.unref();
  return (server.address() as NodeNet.AddressInfo).port;
};

const startGateway = async (
  options: Partial<Parameters<typeof startFakeGateway>[0]> = {},
): Promise<FakeGateway> => {
  const gateway = await startFakeGateway({ ticket: TICKET, ...options });
  cleanups.push(() => gateway.close());
  return gateway;
};

const rejection = async (
  promise: Promise<unknown>,
): Promise<GatewayTunnelError | Error | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error as Error;
  }
};

const open = (baseUrl: string, port: number, ticket = TICKET) =>
  openLoopbackTunnel({ baseUrl, ticket: Redacted.make(ticket), port });

const readExactly = (stream: NodeJS.ReadableStream, length: number): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= length) {
        stream.off("data", onData);
        resolve(Buffer.concat(chunks));
      }
    };
    stream.on("data", onData);
  });

describe("openLoopbackTunnel", () => {
  it("carries bytes both ways and sends the ticket only in the Authorization header", async () => {
    const echo = await startEcho();
    const gateway = await startGateway();

    const tunnel = await open(gateway.baseUrl, echo);
    tunnel.write("hello");
    expect((await readExactly(tunnel, 5)).toString()).toBe("hello");

    expect(gateway.attempts).toEqual([
      { port: echo, authorization: `T3X-Gateway ${TICKET}`, origin: undefined },
    ]);
    tunnel.destroy();
    await gateway.closed(1);
  });

  it("moves a payload far larger than one frame, in order", async () => {
    const echo = await startEcho();
    const gateway = await startGateway();
    const tunnel = await open(gateway.baseUrl, echo);

    const payload = Buffer.alloc(8 * 1024 * 1024);
    for (let at = 0; at < payload.length; at += 1) payload[at] = at % 251;
    const received = readExactly(tunnel, payload.length);
    // One write larger than the 1 MiB message limit: the socket splits it instead of being closed.
    tunnel.write(payload);
    expect((await received).equals(payload)).toBe(true);
    tunnel.destroy();
  });

  it("closes the far end when the local end is destroyed, and the local end when the far end closes", async () => {
    const accepted: Array<NodeNet.Socket> = [];
    const service = NodeNet.createServer((socket) => {
      accepted.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => service.close(() => resolve())));
    const port = (service.address() as NodeNet.AddressInfo).port;
    const gateway = await startGateway();

    const first = await open(gateway.baseUrl, port);
    await new Promise<void>((resolve) =>
      accepted.length > 0 ? resolve() : service.once("connection", () => resolve()),
    );
    const farClosed = new Promise<void>((resolve) => accepted[0]!.once("close", () => resolve()));
    first.destroy();
    await farClosed;

    const second = await open(gateway.baseUrl, port);
    await new Promise<void>((resolve) =>
      accepted.length > 1 ? resolve() : service.once("connection", () => resolve()),
    );
    const nearClosed = new Promise<void>((resolve) => second.once("close", () => resolve()));
    accepted[1]!.destroy();
    await nearClosed;
  });

  it.each([
    ["a ticket the route does not accept", { ticket: "other.ticket" }, "unauthorized"],
    ["a port the route refuses as not owned", { refuse: () => "not-owned" as const }, "not-owned"],
    ["a port with a debug process", { refuse: () => "debug-process" as const }, "debug-process"],
    [
      "a port the route has no room for",
      { refuse: () => "limit-reached" as const },
      "limit-reached",
    ],
  ])("maps %s to the route's error code", async (_name, options, code) => {
    const gateway = await startGateway(
      "ticket" in options
        ? { ticket: options.ticket }
        : "refuse" in options
          ? { refuse: options.refuse }
          : {},
    );
    const error = await rejection(open(gateway.baseUrl, 4000));
    expect(error).toBeInstanceOf(GatewayTunnelError);
    expect((error as GatewayTunnelError).code).toBe(code);
  });

  it("maps a refused dial on the far side to upstream-refused", async () => {
    const closed = NodeNet.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as NodeNet.AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const gateway = await startGateway();
    expect(((await rejection(open(gateway.baseUrl, port))) as GatewayTunnelError).code).toBe(
      "upstream-refused",
    );
  });

  it.each([
    [
      "a server without the route",
      { status: 404, body: "<html>not found</html>" },
      "unsupported-server",
    ],
    [
      "a catch-all that answers 200",
      { status: 200, body: "<html>app</html>" },
      "unsupported-server",
    ],
    ["a gateway that fails upstream", { status: 502, body: "Bad Gateway" }, "offline"],
    ["a middlebox that rate limits", { status: 429, body: "slow down" }, "rate-limited"],
  ])("maps %s without a gateway error body by status", async (_name, respondWith, code) => {
    const gateway = await startGateway({ respondWith });
    expect(((await rejection(open(gateway.baseUrl, 4000))) as GatewayTunnelError).code).toBe(code);
  });

  it("treats a redirect as a failure and never contacts its target", async () => {
    let contacted = 0;
    const target = NodeHttp.createServer((_request, response) => {
      contacted += 1;
      response.end();
    });
    target.on("upgrade", (_request, socket) => {
      contacted += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
    const redirectedTo = `http://127.0.0.1:${(target.address() as NodeNet.AddressInfo).port}/api/loopback-gateway/tunnel?port=4000`;

    const gateway = await startGateway({ redirectTo: redirectedTo });
    const error = await rejection(open(gateway.baseUrl, 4000));

    expect((error as GatewayTunnelError).code).toBe("unexpected-redirect");
    expect(gateway.attempts).toHaveLength(1);
    expect(contacted).toBe(0);
  });

  it("makes no connection when the base URL fails the transport check", async () => {
    const gateway = await startGateway();
    const insecure = gateway.baseUrl.replace("localhost", "192.168.1.20");
    const error = await rejection(open(insecure, 4000));
    expect((error as GatewayTunnelError).code).toBe("insecure-transport");
    expect(gateway.attempts).toHaveLength(0);
  });

  it("reports an unreachable server as offline", async () => {
    const closed = NodeNet.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as NodeNet.AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(
      ((await rejection(open(`http://localhost:${port}`, 4000))) as GatewayTunnelError).code,
    ).toBe("offline");
  });

  it("keeps the ticket out of the error it raises", async () => {
    const gateway = await startGateway({ ticket: "other.ticket" });
    const error = (await rejection(
      open(gateway.baseUrl, 4000, "sentinel-ticket-value.abc"),
    )) as Error;
    expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toContain(
      "sentinel-ticket",
    );
  });
});

describe("certificate validation", () => {
  let fixtures: TlsFixtures;
  let original: ReadonlyArray<string>;

  beforeAll(async () => {
    fixtures = await makeTlsFixtures();
    original = NodeTls.getCACertificates("default");
    // The test CA is trusted the way a public CA is: through the process's default store.
    NodeTls.setDefaultCACertificates([...original, fixtures.ca]);
    return () => {
      NodeTls.setDefaultCACertificates([...original]);
      fixtures.dispose();
    };
  });

  /** What Node itself reports for `url`, so the mapped set is measured rather than assumed. */
  const nodeErrorCode = (url: string) =>
    new Promise<string | undefined>((resolve) => {
      const socket = new WebSocket(url, { followRedirects: false });
      socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code));
      socket.once("unexpected-response", () => resolve(undefined));
      socket.once("open", () => {
        socket.terminate();
        resolve(undefined);
      });
    });

  it("accepts a certificate that chains to a trusted CA", async () => {
    const echo = await startEcho();
    const gateway = await startGateway({
      tls: { key: fixtures.valid.key, cert: fixtures.valid.cert },
    });
    const tunnel = await open(gateway.baseUrl, echo);
    tunnel.write("ok");
    expect((await readExactly(tunnel, 2)).toString()).toBe("ok");
    tunnel.destroy();
  });

  it.each([
    ["self-signed", "selfSigned", "DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["expired", "expired", "CERT_HAS_EXPIRED"],
    ["issued for another host", "wrongHost", "ERR_TLS_CERT_ALTNAME_INVALID"],
    ["missing its intermediate", "viaIntermediate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
  ] as const)(
    "fails a %s certificate and reports tls-untrusted",
    async (_name, fixture, nodeCode) => {
      const pair = fixtures[fixture];
      const gateway = await startGateway({ tls: { key: pair.key, cert: pair.cert } });

      expect(await nodeErrorCode(gateway.baseUrl.replace("https:", "wss:"))).toBe(nodeCode);
      expect(classifyConnectError({ code: nodeCode })).toBe("tls-untrusted");

      const error = await rejection(open(gateway.baseUrl, 4000));
      expect((error as GatewayTunnelError).code).toBe("tls-untrusted");
      expect(gateway.attempts).toHaveLength(0);
    },
  );

  it("accepts the same intermediate-signed certificate once the server sends the chain", async () => {
    const echo = await startEcho();
    const gateway = await startGateway({
      tls: { key: fixtures.viaIntermediate.key, cert: fixtures.viaIntermediate.chain },
    });
    const tunnel = await open(gateway.baseUrl, echo);
    tunnel.destroy();
    expect(gateway.attempts).toHaveLength(1);
  });
});
