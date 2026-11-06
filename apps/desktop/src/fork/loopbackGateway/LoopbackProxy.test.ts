// @effect-diagnostics nodeBuiltinImport:off -- Socket-level tests against real loopback servers.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import { LOOPBACK_GATEWAY_LIMITS } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { startFakeGateway } from "./fakeGateway.testkit.ts";
import {
  GATEWAY_ERROR_HEADER,
  PROXY_USERNAME,
  startLoopbackProxy,
  type LoopbackProxy,
  type ProxyDenial,
} from "./LoopbackProxy.ts";
import { openLoopbackTunnel } from "./TunnelClient.ts";
import { GatewayTunnelError } from "./tunnelErrors.ts";

const TICKET = "ticket-body.signature";
const PASSWORD = "proxy-password-0123456789abcdef";
const AUTH = `Basic ${Buffer.from(`${PROXY_USERNAME}:${PASSWORD}`).toString("base64")}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Service {
  readonly port: number;
  readonly server: NodeHttp.Server;
  readonly connections: () => number;
}

const startService = async (handler: NodeHttp.RequestListener): Promise<Service> => {
  const server = NodeHttp.createServer(handler);
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: (server.address() as NodeNet.AddressInfo).port,
    server,
    connections: () => connections,
  };
};

/** A TCP service whose accepted sockets are handed out in order, as they arrive. */
const startConnectionService = async (): Promise<{
  readonly port: number;
  readonly next: () => Promise<NodeNet.Socket>;
}> => {
  const arrived: Array<NodeNet.Socket> = [];
  const waiting: Array<(socket: NodeNet.Socket) => void> = [];
  const service = NodeNet.createServer((socket) => {
    socket.on("error", () => {});
    const waiter = waiting.shift();
    if (waiter === undefined) arrived.push(socket);
    else waiter(socket);
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => service.close(() => resolve())));
  return {
    port: (service.address() as NodeNet.AddressInfo).port,
    next: () => {
      const socket = arrived.shift();
      return socket !== undefined
        ? Promise.resolve(socket)
        : new Promise((resolve) => waiting.push(resolve));
    },
  };
};

interface Rig {
  readonly proxy: LoopbackProxy;
  readonly denials: Array<ProxyDenial>;
  readonly tunnelsOpened: () => number;
  readonly gateway: Awaited<ReturnType<typeof startFakeGateway>>;
}

/** A proxy whose tunnels go through the fake gateway with a real WebSocket each. */
const startRig = async (
  options: {
    readonly openTunnel?: (port: number) => Promise<NodeStream.Duplex>;
    readonly refuse?: (port: number) => "not-owned" | undefined;
  } = {},
): Promise<Rig> => {
  const gateway = await startFakeGateway({
    ticket: TICKET,
    ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
  });
  cleanups.push(() => gateway.close());
  const denials: Array<ProxyDenial> = [];
  let tunnels = 0;
  const proxy = await startLoopbackProxy({
    password: PASSWORD,
    openTunnel:
      options.openTunnel ??
      ((port) => {
        tunnels += 1;
        return openLoopbackTunnel({
          baseUrl: gateway.baseUrl,
          ticket: Redacted.make(TICKET),
          port,
        });
      }),
    onDenied: (denial) => denials.push(denial),
  });
  cleanups.push(() => proxy.close());
  return { proxy, denials, tunnelsOpened: () => tunnels, gateway };
};

interface Response {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A client the way Chromium talks to a proxy: absolute-form targets, `Proxy-Authorization`. */
const viaProxy = (
  proxy: LoopbackProxy,
  target: string,
  init: {
    readonly method?: string;
    readonly headers?: NodeHttp.OutgoingHttpHeaders;
    readonly body?: Buffer | string;
    readonly agent?: NodeHttp.Agent;
    readonly authorized?: boolean;
  } = {},
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: init.method ?? "GET",
        path: target,
        agent: init.agent ?? false,
        headers: {
          Host: target.replace(/^https?:\/\//u, "").split("/")[0],
          ...(init.authorized === false ? {} : { "Proxy-Authorization": AUTH }),
          ...init.headers,
        },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end(init.body);
  });

describe("forwarding HTTP", () => {
  it("serves a request through a real tunnel and keeps the Host header and path as sent", async () => {
    const seen: Array<{ url: string | undefined; host: string | undefined; proxyAuth: unknown }> =
      [];
    const service = await startService((request, response) => {
      seen.push({
        url: request.url,
        host: request.headers.host,
        proxyAuth: request.headers["proxy-authorization"],
      });
      response.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": ["a=1", "b=2"] });
      response.end("hello");
    });
    const rig = await startRig();

    const response = await viaProxy(rig.proxy, `http://localhost:${service.port}/a/../b%2Fc?x=1`);

    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("hello");
    expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(seen).toEqual([
      { url: "/a/../b%2Fc?x=1", host: `localhost:${service.port}`, proxyAuth: undefined },
    ]);
    expect(rig.gateway.attempts.map((attempt) => attempt.port)).toEqual([service.port]);
  });

  it("streams server-sent events as they are written", async () => {
    const serviceResponse = Promise.withResolvers<NodeHttp.ServerResponse>();
    const service = await startService((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      serviceResponse.resolve(response);
    });
    const rig = await startRig();

    const events: Array<string> = [];
    const gotFirst = Promise.withResolvers<void>();
    const gotSecond = Promise.withResolvers<void>();
    const request = NodeHttp.get(
      {
        host: "127.0.0.1",
        port: rig.proxy.port,
        path: `http://localhost:${service.port}/sse`,
        headers: { "Proxy-Authorization": AUTH, Host: `localhost:${service.port}` },
        agent: false,
      },
      (response) => {
        expect(response.headers["content-type"]).toBe("text/event-stream");
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          events.push(chunk);
          if (events.length === 1) gotFirst.resolve();
          if (events.length === 2) gotSecond.resolve();
        });
      },
    );
    cleanups.push(() => {
      request.destroy();
    });

    // The service has not finished (or even sent its second event) when the first one arrives.
    const upstream = await serviceResponse.promise;
    upstream.write("data: one\n\n");
    await gotFirst.promise;
    expect(events).toEqual(["data: one\n\n"]);
    upstream.write("data: two\n\n");
    await gotSecond.promise;
    upstream.end();
  });

  const echoLengthService = () =>
    startService((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        const body = Buffer.concat(chunks);
        response.writeHead(200, { "X-Received": String(body.length) });
        response.write("chunk-1;");
        response.write("chunk-2;");
        response.end(`bytes=${body.length}`);
      });
    });

  it("forwards a chunked response and a large upload with a Content-Length intact", async () => {
    const service = await echoLengthService();
    const rig = await startRig();

    const upload = Buffer.alloc(6 * 1024 * 1024, 7);
    const response = await viaProxy(rig.proxy, `http://localhost:${service.port}/up`, {
      method: "POST",
      body: upload,
      headers: { "Content-Length": upload.length },
    });
    expect(response.body.toString()).toBe(`chunk-1;chunk-2;bytes=${upload.length}`);
    expect(response.headers["transfer-encoding"]).toBe("chunked");
  });

  it("forwards a chunked request body", async () => {
    const service = await echoLengthService();
    const rig = await startRig();

    const response = await new Promise<Response>((resolve, reject) => {
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: rig.proxy.port,
          method: "POST",
          path: `http://localhost:${service.port}/chunked`,
          agent: false,
          headers: { "Proxy-Authorization": AUTH, Host: `localhost:${service.port}` },
        },
        (reply) => {
          const parts: Array<Buffer> = [];
          reply.on("data", (part: Buffer) => parts.push(part));
          reply.once("end", () =>
            resolve({
              status: reply.statusCode ?? 0,
              headers: reply.headers,
              body: Buffer.concat(parts),
            }),
          );
        },
      );
      request.once("error", reject);
      request.write("abc");
      request.write("defgh");
      request.end();
    });
    expect(response.body.toString()).toBe("chunk-1;chunk-2;bytes=8");
  });

  it("answers Expect: 100-continue before the body is sent", async () => {
    const service = await startService((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => response.end(Buffer.concat(chunks)));
    });
    const rig = await startRig();

    const outcome = await new Promise<{ continued: boolean; body: string }>((resolve, reject) => {
      let continued = false;
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: rig.proxy.port,
          method: "PUT",
          path: `http://localhost:${service.port}/upload`,
          agent: false,
          headers: {
            "Proxy-Authorization": AUTH,
            Host: `localhost:${service.port}`,
            Expect: "100-continue",
            "Content-Length": 11,
          },
        },
        (response) => {
          const parts: Array<Buffer> = [];
          response.on("data", (part: Buffer) => parts.push(part));
          response.once("end", () => resolve({ continued, body: Buffer.concat(parts).toString() }));
        },
      );
      request.once("error", reject);
      request.once("continue", () => {
        continued = true;
        request.end("hello world");
      });
      request.flushHeaders();
    });

    expect(outcome).toEqual({ continued: true, body: "hello world" });
  });

  it("reuses a tunnel for sequential requests to a port, and serves two ports on one client connection", async () => {
    const first = await startService((_request, response) => response.end("first"));
    const second = await startService((_request, response) => response.end("second"));
    const rig = await startRig();
    const client = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => client.destroy());

    const bodies: Array<string> = [];
    for (let round = 0; round < 3; round += 1) {
      bodies.push(
        (
          await viaProxy(rig.proxy, `http://localhost:${first.port}/`, { agent: client })
        ).body.toString(),
      );
      bodies.push(
        (
          await viaProxy(rig.proxy, `http://127.0.0.1:${second.port}/`, { agent: client })
        ).body.toString(),
      );
    }

    expect(bodies).toEqual(["first", "second", "first", "second", "first", "second"]);
    // One tunnel and one connection to each service for six requests over one client connection.
    expect(rig.gateway.opened()).toBe(2);
    expect(first.connections()).toBe(1);
    expect(second.connections()).toBe(1);
  });

  it("closes the tunnel when the client abandons a response", async () => {
    let serviceResponse: NodeHttp.ServerResponse | undefined;
    const service = await startService((_request, response) => {
      serviceResponse = response;
      response.writeHead(200);
      response.write("start");
    });
    const rig = await startRig();

    const request = NodeHttp.get({
      host: "127.0.0.1",
      port: rig.proxy.port,
      path: `http://localhost:${service.port}/`,
      headers: { "Proxy-Authorization": AUTH, Host: `localhost:${service.port}` },
      agent: false,
    });
    const started = Promise.withResolvers<NodeHttp.IncomingMessage>();
    request.once("response", started.resolve);
    const response = await started.promise;
    await new Promise<void>((resolve) => response.once("data", () => resolve()));

    const serviceSawClose = new Promise<void>((resolve) =>
      serviceResponse!.once("close", () => resolve()),
    );
    response.destroy();
    await serviceSawClose;
    await rig.gateway.closed(1);
  });

  it("drops a response cut short instead of ending it cleanly", async () => {
    const service = await startService((request, response) => {
      response.writeHead(200, { "Content-Length": 100 });
      response.write("only some", () => request.socket.destroy());
    });
    const rig = await startRig();
    const error = await viaProxy(rig.proxy, `http://localhost:${service.port}/`).then(
      () => undefined,
      (caught: Error) => caught,
    );
    expect(error).toBeDefined();
  });

  it("retries a GET once when a kept-alive tunnel went stale", async () => {
    const service = await startService((_request, response) => response.end("fine"));
    const rig = await startRig();
    const client = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => client.destroy());

    expect(
      (
        await viaProxy(rig.proxy, `http://localhost:${service.port}/`, { agent: client })
      ).body.toString(),
    ).toBe("fine");
    // The gateway side drops every open tunnel while the proxy still has one parked.
    for (const client of rig.gateway.attempts) void client;
    service.server.closeAllConnections();
    await rig.gateway.closed(1);

    const again = await viaProxy(rig.proxy, `http://localhost:${service.port}/`, { agent: client });
    expect(again.body.toString()).toBe("fine");
    expect(rig.gateway.opened()).toBe(2);
  });
});

describe("connection management", () => {
  it("serves a request that asks the connection to close, and the ones after it", async () => {
    const service = await startService((_request, response) => response.end("closing"));
    const rig = await startRig();
    for (let round = 0; round < 3; round += 1) {
      const response = await viaProxy(rig.proxy, `http://localhost:${service.port}/`, {
        headers: { Connection: "close" },
      });
      expect(response.body.toString()).toBe("closing");
    }
  });

  it("keeps serving when the service closes its connection after every response", async () => {
    const service = await startService((_request, response) => {
      response.setHeader("Connection", "close");
      response.end("once");
    });
    const rig = await startRig();
    const client = new NodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => client.destroy());
    for (let round = 0; round < 3; round += 1) {
      const response = await viaProxy(rig.proxy, `http://localhost:${service.port}/`, {
        agent: client,
      });
      expect(response.body.toString()).toBe("once");
    }
    expect(service.connections()).toBe(3);
  });
});

describe("what is forwarded", () => {
  const forwarded = [
    "http://127.0.0.1:%PORT%/x",
    "http://localhost:%PORT%/x",
    "http://[::1]:%PORT%/x",
    "http://127.0.0.2:%PORT%/x",
    "http://127.255.255.254:%PORT%/x",
    "http://localhost.:%PORT%/x",
    "http://app.localhost:%PORT%/x",
    "http://LOCALHOST:%PORT%/x",
    "http://[::ffff:7f00:1]:%PORT%/x",
  ];

  it.each(forwarded)("asks the gateway for the port of %s", async (template) => {
    const rig = await startRig({
      openTunnel: () => Promise.reject(new GatewayTunnelError("upstream-refused")),
    });
    const response = await viaProxy(rig.proxy, template.replace("%PORT%", "5173"));
    expect(response.headers[GATEWAY_ERROR_HEADER.toLowerCase()]).toBe("upstream-refused");
    expect(rig.denials).toEqual([{ code: "upstream-refused", port: 5173, via: "http" }]);
  });

  it.each([
    "http://example.com:5173/x",
    "http://0.0.0.0:5173/x",
    "http://[::]:5173/x",
    "http://localhost.localdomain:5173/x",
    "http://127.0.0.1.evil.com:5173/x",
    "http://user@localhost:5173/x",
    "http://localhost:0/x",
    "http://localhost:65536/x",
    "http://192.168.1.5:5173/x",
  ])("answers 403 for %s without asking the gateway", async (target) => {
    let asked = 0;
    const rig = await startRig({
      openTunnel: () => {
        asked += 1;
        return Promise.reject(new GatewayTunnelError("offline"));
      },
    });
    const response = await viaProxy(rig.proxy, target);
    expect([400, 403]).toContain(response.status);
    expect(asked).toBe(0);
    expect(rig.denials).toEqual([]);
  });

  it("refuses to be used as a plain web server and an https absolute URI", async () => {
    const rig = await startRig();
    expect((await viaProxy(rig.proxy, "/just-a-path")).status).toBe(400);
    expect((await viaProxy(rig.proxy, "https://localhost:5173/")).status).toBe(400);
  });

  it("does not forward a plain HTTP Upgrade", async () => {
    const rig = await startRig();
    const status = await new Promise<string>((resolve) => {
      const socket = NodeNet.connect(rig.proxy.port, "127.0.0.1", () => {
        socket.write(
          `GET http://localhost:5173/ HTTP/1.1\r\nHost: localhost:5173\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: ${AUTH}\r\n\r\n`,
        );
      });
      socket.once("data", (data) => {
        resolve(data.toString().split("\r\n")[0]!);
        socket.destroy();
      });
    });
    expect(status).toBe("HTTP/1.1 501 Not Implemented");
  });
});

describe("error pages", () => {
  it.each([
    ["not-owned", 403],
    ["unauthorized", 503],
    ["upstream-refused", 502],
    ["offline", 502],
    ["tls-untrusted", 502],
    ["limit-reached", 429],
  ] as const)(
    "shows a %s page with status %i, the error header and a denial event",
    async (code, status) => {
      const rig = await startRig({
        openTunnel: () => Promise.reject(new GatewayTunnelError(code)),
      });
      const response = await viaProxy(rig.proxy, "http://localhost:5173/");
      expect(response.status).toBe(status);
      expect(response.headers[GATEWAY_ERROR_HEADER.toLowerCase()]).toBe(code);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body.toString()).toContain("localhost:5173");
      expect(rig.denials).toEqual([{ code, port: 5173, via: "http" }]);
    },
  );

  it("carries the gateway's own refusal through to the page", async () => {
    const service = await startService((_request, response) => response.end("never"));
    const rig = await startRig({ refuse: () => "not-owned" });
    const response = await viaProxy(rig.proxy, `http://localhost:${service.port}/`);
    expect(response.status).toBe(403);
    expect(response.headers[GATEWAY_ERROR_HEADER.toLowerCase()]).toBe("not-owned");
    expect(service.connections()).toBe(0);
  });

  it("strips gateway error headers a service tries to send", async () => {
    const service = await startService((_request, response) => {
      response.writeHead(200, { [GATEWAY_ERROR_HEADER]: "not-owned" });
      response.end("ok");
    });
    const rig = await startRig();
    const response = await viaProxy(rig.proxy, `http://localhost:${service.port}/`);
    expect(response.headers[GATEWAY_ERROR_HEADER.toLowerCase()]).toBeUndefined();
  });
});

describe("CONNECT", () => {
  const connect = (
    proxy: LoopbackProxy,
    authority: string,
    authorized = true,
  ): Promise<{ status: string; socket: NodeNet.Socket; rest: Buffer }> =>
    new Promise((resolve, reject) => {
      const socket = NodeNet.connect(proxy.port, "127.0.0.1", () => {
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorized ? `Proxy-Authorization: ${AUTH}\r\n` : ""}\r\n`,
        );
      });
      socket.once("error", reject);
      let buffer = Buffer.alloc(0);
      const onData = (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        resolve({
          status: buffer.subarray(0, buffer.indexOf("\r\n")).toString(),
          socket,
          rest: buffer.subarray(end + 4),
        });
      };
      socket.on("data", onData);
    });

  it("pipes bytes both ways to a TCP service, byte for byte", async () => {
    const service = NodeNet.createServer((socket) => {
      socket.on("error", () => {});
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => service.close(() => resolve())));
    const { port } = service.address() as NodeNet.AddressInfo;
    const rig = await startRig();

    const { status, socket } = await connect(rig.proxy, `localhost:${port}`);
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const received = new Promise<string>((resolve) =>
      socket.once("data", (data) => resolve(data.toString())),
    );
    socket.write("ping");
    expect(await received).toBe("ping");
    socket.destroy();
    await rig.gateway.closed(1);
  });

  it("closes the client connection when the service closes, and the tunnel when the client closes", async () => {
    const service = await startConnectionService();
    const rig = await startRig();

    const first = await connect(rig.proxy, `127.0.0.1:${service.port}`);
    const firstAccepted = await service.next();
    const clientClosed = new Promise<void>((resolve) =>
      first.socket.once("close", () => resolve()),
    );
    firstAccepted.destroy();
    await clientClosed;
    await rig.gateway.closed(1);

    const second = await connect(rig.proxy, `127.0.0.1:${service.port}`);
    const secondAccepted = await service.next();
    const serviceClosed = new Promise<void>((resolve) =>
      secondAccepted.once("close", () => resolve()),
    );
    second.socket.destroy();
    await serviceClosed;
    await rig.gateway.closed(2);
  });

  it.each(["example.com:443", "0.0.0.0:5173", "[::]:5173", "localhost", "localhost:0"])(
    "refuses CONNECT %s",
    async (authority) => {
      const rig = await startRig();
      const { status } = await connect(rig.proxy, authority);
      expect(status).toMatch(/^HTTP\/1\.1 (400|403) /u);
      expect(rig.tunnelsOpened()).toBe(0);
    },
  );

  it("answers a failed tunnel with the error header and a denial event", async () => {
    const rig = await startRig({
      openTunnel: () => Promise.reject(new GatewayTunnelError("tls-untrusted")),
    });
    const { status, socket } = await connect(rig.proxy, "localhost:5173");
    expect(status).toBe("HTTP/1.1 502 Tunnel Failed");
    socket.destroy();
    expect(rig.denials).toEqual([{ code: "tls-untrusted", port: 5173, via: "connect" }]);
  });
});

describe("who may use the proxy", () => {
  it("answers 407 and opens no tunnel without the password, or with a wrong one", async () => {
    const rig = await startRig();
    const service = await startService((_request, response) => response.end("secret"));

    const missing = await viaProxy(rig.proxy, `http://localhost:${service.port}/`, {
      authorized: false,
    });
    const wrong = await viaProxy(rig.proxy, `http://localhost:${service.port}/`, {
      authorized: false,
      headers: {
        "Proxy-Authorization": `Basic ${Buffer.from(`${PROXY_USERNAME}:wrong`).toString("base64")}`,
      },
    });
    const wrongUser = await viaProxy(rig.proxy, `http://localhost:${service.port}/`, {
      authorized: false,
      headers: {
        "Proxy-Authorization": `Basic ${Buffer.from(`root:${PASSWORD}`).toString("base64")}`,
      },
    });

    for (const response of [missing, wrong, wrongUser]) {
      expect(response.status).toBe(407);
      expect(response.headers["proxy-authenticate"]).toContain("Basic");
      expect(response.body.toString()).not.toContain("secret");
    }
    expect(rig.tunnelsOpened()).toBe(0);
    expect(rig.gateway.attempts).toHaveLength(0);
    expect(service.connections()).toBe(0);
  });

  it("answers a CONNECT without the password with 407 and opens no tunnel", async () => {
    const rig = await startRig();
    const status = await new Promise<string>((resolve) => {
      const socket = NodeNet.connect(rig.proxy.port, "127.0.0.1", () =>
        socket.write("CONNECT localhost:5173 HTTP/1.1\r\nHost: localhost:5173\r\n\r\n"),
      );
      socket.once("data", (data) => {
        resolve(data.toString().split("\r\n")[0]!);
        socket.destroy();
      });
    });
    expect(status).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(rig.tunnelsOpened()).toBe(0);
  });

  it("listens on the IPv4 loopback address only", async () => {
    const rig = await startRig();
    const address = await new Promise<string>((resolve, reject) => {
      const socket = NodeNet.connect(rig.proxy.port, "127.0.0.1", () => {
        resolve(socket.remoteAddress ?? "");
        socket.destroy();
      });
      socket.once("error", reject);
    });
    expect(address).toBe("127.0.0.1");
    const refused = await new Promise<string | undefined>((resolve) => {
      const socket = NodeNet.connect(rig.proxy.port, "::1", () => {
        resolve(undefined);
        socket.destroy();
      });
      socket.once("error", (error) => resolve((error as NodeJS.ErrnoException).code));
    });
    expect(refused).toBeDefined();
  });

  it("destroys unauthenticated requests without answering once the rate limit is passed", async () => {
    let clock = 10_000;
    const proxy = await startLoopbackProxy({
      password: PASSWORD,
      openTunnel: () => Promise.reject(new GatewayTunnelError("offline")),
      now: () => clock,
    });
    cleanups.push(() => proxy.close());

    const outcomes: Array<string> = [];
    for (
      let attempt = 0;
      attempt < LOOPBACK_GATEWAY_LIMITS.unauthenticatedProxyConnectionsPerSecond + 5;
      attempt += 1
    ) {
      outcomes.push(
        await viaProxy(proxy, "http://localhost:5173/", { authorized: false }).then(
          (response) => String(response.status),
          (error: NodeJS.ErrnoException) => error.code ?? "error",
        ),
      );
    }
    expect(outcomes.filter((outcome) => outcome === "407")).toHaveLength(
      LOOPBACK_GATEWAY_LIMITS.unauthenticatedProxyConnectionsPerSecond,
    );
    expect(
      outcomes.slice(LOOPBACK_GATEWAY_LIMITS.unauthenticatedProxyConnectionsPerSecond),
    ).toEqual(Array(5).fill("ECONNRESET"));

    clock += 1000;
    expect((await viaProxy(proxy, "http://localhost:5173/", { authorized: false })).status).toBe(
      407,
    );
  });

  it("limits unauthenticated connections held open at once", async () => {
    const proxy = await startLoopbackProxy({
      password: PASSWORD,
      openTunnel: () => Promise.reject(new GatewayTunnelError("offline")),
      now: () => 0,
    });
    cleanups.push(() => proxy.close());

    // A 407 is answered and its connection closed, so connections that stay open are the ones
    // that are held without ever finishing a request; they are not counted until they send one.
    const held = Array.from(
      { length: LOOPBACK_GATEWAY_LIMITS.unauthenticatedProxyConnections },
      () => NodeNet.connect(proxy.port, "127.0.0.1"),
    );
    for (const socket of held) socket.on("error", () => {});
    cleanups.push(() => held.forEach((socket) => socket.destroy()));
    expect((await viaProxy(proxy, "http://localhost:5173/", { authorized: false })).status).toBe(
      407,
    );
  });

  it("allows at most 256 connections at once", async () => {
    const proxy = await startLoopbackProxy({
      password: PASSWORD,
      openTunnel: () => Promise.reject(new GatewayTunnelError("offline")),
    });
    cleanups.push(() => proxy.close());

    const limit = LOOPBACK_GATEWAY_LIMITS.proxyConnectionsPerEnvironment;
    const sockets: Array<NodeNet.Socket> = [];
    for (let count = 0; count < limit; count += 1) {
      const socket = NodeNet.connect(proxy.port, "127.0.0.1");
      socket.on("error", () => {});
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    }
    cleanups.push(() => sockets.forEach((socket) => socket.destroy()));

    const extra = NodeNet.connect(proxy.port, "127.0.0.1");
    extra.on("error", () => {});
    const closed = new Promise<void>((resolve) => extra.once("close", () => resolve()));
    await closed;
    expect(extra.bytesRead).toBe(0);
  });
});

describe("limits on opening tunnels", () => {
  it("refuses the 33rd tunnel that is being opened at the same time", async () => {
    const gate = Promise.withResolvers<void>();
    let started = 0;
    const allStarted = Promise.withResolvers<void>();
    const rig = await startRig({
      openTunnel: async () => {
        started += 1;
        if (started === LOOPBACK_GATEWAY_LIMITS.pendingTunnelOpensPerEnvironment) {
          allStarted.resolve();
        }
        await gate.promise;
        throw new GatewayTunnelError("offline");
      },
    });
    const limit = LOOPBACK_GATEWAY_LIMITS.pendingTunnelOpensPerEnvironment;
    const pending = Array.from({ length: limit }, (_, index) =>
      viaProxy(rig.proxy, `http://localhost:${5000 + index}/`),
    );
    await allStarted.promise;

    const over = await viaProxy(rig.proxy, "http://localhost:6000/");
    expect(over.status).toBe(429);
    expect(over.headers[GATEWAY_ERROR_HEADER.toLowerCase()]).toBe("limit-reached");
    expect(started).toBe(limit);

    gate.resolve();
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual(
      Array(limit).fill(502),
    );
  });
});

describe("closing", () => {
  it("closeTunnels ends connections through tunnels and keeps serving new ones", async () => {
    const service = await startConnectionService();
    const rig = await startRig();

    const client = NodeNet.connect(rig.proxy.port, "127.0.0.1", () =>
      client.write(
        `CONNECT localhost:${service.port} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${AUTH}\r\n\r\n`,
      ),
    );
    const accepted = await service.next();
    await new Promise<void>((resolve) => client.once("data", () => resolve()));
    const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    const serviceClosed = new Promise<void>((resolve) => accepted.once("close", () => resolve()));
    rig.proxy.closeTunnels();
    await Promise.all([clientClosed, serviceClosed]);

    const fine = await startService((_request, response) => response.end("again"));
    expect((await viaProxy(rig.proxy, `http://localhost:${fine.port}/`)).body.toString()).toBe(
      "again",
    );
  });
});
