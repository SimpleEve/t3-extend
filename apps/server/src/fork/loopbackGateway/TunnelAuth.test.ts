// Who may open a tunnel (design 4.4) and what the custom `Authorization` scheme must not do
// elsewhere (4.3), over the production session store, auth routes and rate limiter.
import { assert, describe, it } from "@effect/vitest";
import { AuthPreviewOperateScope, AuthTerminalOperateScope } from "@t3tools/contracts";
import {
  LOOPBACK_GATEWAY_ERROR_CODES,
  LoopbackGatewayErrorBody,
  formatLoopbackGatewayAuthorization,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { send } from "../deviceKeys/tunnelHarness.testkit.ts";
import {
  Gateway,
  issueSessionTicket,
  layerGateway,
  listenLoopback,
  openTunnel,
} from "./gatewayHarness.testkit.ts";
import { refuse } from "./PortAuthorizer.ts";

const decodeBody = Schema.decodeUnknownSync(LoopbackGatewayErrorBody);

const refused = Effect.fn("refused")(function* (
  port: number,
  input: Parameters<typeof openTunnel>[1],
  expected: { readonly status: number; readonly code: string },
) {
  const attempt = yield* openTunnel(port, input);
  if (attempt._tag !== "refused") {
    attempt.ws.terminate();
    return assert.fail("the tunnel opened");
  }
  assert.equal(attempt.status, expected.status);
  assert.equal(decodeBody(attempt.body).code, expected.code);
  assert.notInclude(attempt.text, "tunnel-test");
});

describe("tunnel credentials", () => {
  it.live(
    "refuses everything but a gateway ticket in the T3X-Gateway scheme, before any port check",
    () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const dev = yield* listenLoopback((socket) => socket.end());
        const query = `port=${dev.port}`;
        for (const port of [gateway.mainPort, gateway.tunnelPort]) {
          const good = yield* issueSessionTicket();
          const noAudience = yield* issueSessionTicket({ audience: null });
          const rpc = yield* issueSessionTicket({ audience: "rpc" });
          const media = yield* issueSessionTicket({ audience: "media" });
          const onlyPreview = yield* issueSessionTicket({ scopes: [AuthPreviewOperateScope] });
          const onlyTerminal = yield* issueSessionTicket({ scopes: [AuthTerminalOperateScope] });
          const noScopes = yield* issueSessionTicket({ scopes: [] });
          const expired = yield* issueSessionTicket({ ticketTtl: Duration.zero });
          const revoked = yield* issueSessionTicket();
          yield* gateway.sessions.revoke(revoked.session.sessionId);
          const mcpLookalike = yield* issueSessionTicket({ subject: "mcp-client" });

          const t3x = (ticket: string) => ({ ticket, query });
          const unauthorized = { status: 401, code: "unauthorized" } as const;
          const forbidden = { status: 403, code: "forbidden" } as const;
          yield* refused(port, { query }, unauthorized);
          yield* refused(port, { query, authorization: `Bearer ${good.ticket}` }, unauthorized);
          yield* refused(port, { query, authorization: `DPoP ${good.ticket}` }, unauthorized);
          yield* refused(
            port,
            { query, headers: { cookie: `t3_session=${good.ticket}` } },
            unauthorized,
          );
          yield* refused(
            port,
            { query, authorization: `T3X-Gateway ${good.ticket}, Bearer x` },
            unauthorized,
          );
          yield* refused(port, t3x(`${good.ticket}x`), unauthorized);
          yield* refused(port, t3x(noAudience.ticket), unauthorized);
          yield* refused(port, t3x(rpc.ticket), unauthorized);
          yield* refused(port, t3x(media.ticket), unauthorized);
          yield* refused(port, t3x(expired.ticket), unauthorized);
          yield* refused(port, t3x(revoked.ticket), unauthorized);
          yield* refused(port, t3x(onlyPreview.ticket), forbidden);
          yield* refused(port, t3x(onlyTerminal.ticket), forbidden);
          yield* refused(port, t3x(noScopes.ticket), forbidden);
          yield* refused(port, t3x(mcpLookalike.ticket), forbidden);
          yield* refused(
            port,
            { ...t3x(good.ticket), headers: { origin: "http://localhost:5173" } },
            forbidden,
          );
          yield* refused(
            port,
            { query: `${query}&wsTicket=${good.ticket}`, ticket: good.ticket },
            { status: 400, code: "ticket-in-url" },
          );
          yield* refused(
            port,
            { query: "wsTicket=anything" },
            { status: 400, code: "ticket-in-url" },
          );
          for (const bad of [
            "",
            "port=",
            "port=abc",
            "port=0",
            "port=65536",
            "port=-1",
            "port=05173",
            "x=1",
          ]) {
            yield* refused(
              port,
              { ticket: good.ticket, query: bad },
              { status: 400, code: "bad-request" },
            );
          }
        }
        assert.deepEqual(gateway.authorizeCalls, []);
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live(
    "keeps a real MCP client session out, and keeps the literal this route checks in step with upstream",
    () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const mcp = yield* auth.issueMcpClientSession({
          label: "mcp",
          access: "full-access",
          peerLink: false,
          client: { label: "mcp", deviceType: "bot" },
        });
        assert.equal((yield* gateway.sessions.verify(mcp.token)).subject, "mcp-client");
        const issued = yield* gateway.sessions.issueWebSocketToken(mcp.sessionId, {
          audience: "loopback-gateway",
        });
        yield* refused(
          gateway.mainPort,
          { ticket: issued.token, query: "port=1" },
          {
            status: 403,
            code: "forbidden",
          },
        );
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live(
    "one ticket opens any number of tunnels, a DPoP-bound session's included, with no proof",
    () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const dev = yield* listenLoopback((socket) => socket.pipe(socket));
        const { ticket } = yield* issueSessionTicket({ proofKeyThumbprint: "dpop-key-1" });
        for (let i = 0; i < 3; i++) {
          const attempt = yield* openTunnel(gateway.mainPort, {
            ticket,
            query: `port=${dev.port}`,
          });
          assert.equal(attempt._tag, "open");
          if (attempt._tag === "open") attempt.ws.terminate();
        }
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("passes the port check's refusals on with their status and code", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const { ticket } = yield* issueSessionTicket();
      for (const [code, status] of [
        ["not-owned", 403],
        ["reserved", 403],
        ["debug-process", 403],
        ["owner-changed", 409],
      ] as const) {
        gateway.setAuthorize(() => Effect.fail(refuse(code, "fixed phrase")));
        yield* refused(gateway.mainPort, { ticket, query: "port=5173" }, { status, code });
      }
      // Nothing listens on this port: the dial itself is refused.
      const closedPort = yield* listenLoopback(() => {}).pipe(
        Effect.flatMap(({ port, server }) =>
          Effect.promise(() => new Promise<number>((resolve) => server.close(() => resolve(port)))),
        ),
      );
      gateway.setAuthorize((port) =>
        Effect.succeed({ host: "127.0.0.1", port, pid: 1, owner: "terminal" as const }),
      );
      yield* refused(
        gateway.mainPort,
        { ticket, query: `port=${closedPort}` },
        {
          status: 502,
          code: "upstream-refused",
        },
      );
      gateway.setAvailable(false);
      yield* refused(
        gateway.mainPort,
        { ticket, query: "port=5173" },
        {
          status: 403,
          code: "discovery-disabled",
        },
      );
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it("knows every code a refusal can carry", () => {
    for (const code of [
      "not-owned",
      "reserved",
      "debug-process",
      "owner-changed",
      "upstream-refused",
    ]) {
      assert.include(LOOPBACK_GATEWAY_ERROR_CODES as ReadonlyArray<string>, code);
    }
  });
});

describe("tickets on the other routes (the audience check comes first)", () => {
  const authorized = (ticket: string, path: string, port: number) =>
    send(port, { path: `${path}?wsTicket=${encodeURIComponent(ticket)}` });

  it.live(
    "a gateway ticket, DPoP key and all, is refused by audience on the RPC and media routes",
    () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const { ticket } = yield* issueSessionTicket({ proofKeyThumbprint: "dpop-key-2" });
        for (const port of [gateway.mainPort, gateway.tunnelPort]) {
          for (const use of ["rpc", "media"]) {
            const response = yield* authorized(ticket, `/test/upgrade-auth/${use}`, port);
            const body = response.json() as {
              ok: boolean;
              diagnostic: string;
              dpopFailureReason: unknown;
            };
            assert.equal(response.status, 401);
            assert.include(body.diagnostic, "loopback-gateway");
            // Not "present a DPoP proof": the audience was refused before the proof was asked for.
            assert.isNull(body.dpopFailureReason);
          }
        }
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("a ticket with no audience still works on the RPC route", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const { ticket } = yield* issueSessionTicket({ audience: null });
      const response = yield* authorized(ticket, "/test/upgrade-auth/rpc", gateway.mainPort);
      assert.equal(response.status, 200);
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );

  it.live("the generic ticket endpoint cannot mint a gateway ticket", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const { session } = yield* issueSessionTicket();
      const token = (yield* gateway.sessions.issue({
        subject: "generic",
        scopes: [AuthPreviewOperateScope, AuthTerminalOperateScope],
      })).token;
      void session;
      for (const [use, status] of [
        ["loopback-gateway", 400],
        ["rpc", 200],
        ["media", 200],
      ] as const) {
        const response = yield* send(gateway.mainPort, {
          method: "POST",
          path: `/api/auth/websocket-ticket/${use}`,
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, status, `${use}: ${response.text}`);
      }
    }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );
});

describe("the T3X-Gateway scheme elsewhere", () => {
  it.live(
    "is not a credential on protected routes, and failed tickets never reach the auth rate limiter",
    () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        const { ticket } = yield* issueSessionTicket();
        const header = { authorization: formatLoopbackGatewayAuthorization(ticket) };
        for (const port of [gateway.mainPort, gateway.tunnelPort]) {
          const plain = yield* send(port, { path: "/api/auth/session" });
          const withScheme = yield* send(port, { path: "/api/auth/session", headers: header });
          assert.equal(withScheme.status, plain.status);
          assert.equal(withScheme.text, plain.text);
          const token = yield* send(port, {
            method: "POST",
            path: "/oauth/token",
            headers: { ...header, "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=nope",
          });
          assert.isAtLeast(token.status, 400);
          assert.isBelow(token.status, 500);
          assert.notEqual(token.status, 429);
        }
        const before = [...gateway.limiterClients];
        for (let i = 0; i < 30; i++) {
          yield* refused(
            gateway.mainPort,
            { ticket: `${ticket}${i}`, query: "port=1" },
            {
              status: 401,
              code: "unauthorized",
            },
          );
        }
        assert.deepEqual(gateway.limiterClients, before);
        const after = yield* send(gateway.mainPort, {
          method: "POST",
          path: "/oauth/token",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=nope",
        });
        assert.notEqual(after.status, 429);
      }).pipe(Effect.scoped, Effect.provide(layerGateway)),
  );
});
