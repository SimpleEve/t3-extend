// The ticket must not appear in any log or span, on any path (design 4.3). Every scenario of the
// route runs with a recording logger and tracer in the server's context, once with the HTTP
// request logger on (`--log-ws-events`) and once with it off; the outputs are then searched for
// every ticket and every 12-character piece of one.
// @effect-diagnostics nodeBuiltinImport:off -- Real loopback sockets and a source scan.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { AuthPreviewOperateScope } from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import {
  Gateway,
  issueSessionTicket,
  listenLoopback,
  makeLayerGateway,
  openTunnel,
  type Capture,
} from "./gatewayHarness.testkit.ts";
import { refuse } from "./PortAuthorizer.ts";

const closed = (target: { once: (event: "close", listener: () => void) => unknown }) => {
  const done = new Promise<void>((resolve) => target.once("close", () => resolve()));
  return Effect.promise(() => done);
};

const PIECE = 12;

const leaks = (haystack: string, tickets: ReadonlyArray<string>) => {
  const found: Array<string> = [];
  for (const ticket of tickets) {
    for (let at = 0; at + PIECE <= ticket.length; at++) {
      if (haystack.includes(ticket.slice(at, at + PIECE))) {
        found.push(ticket.slice(at, at + PIECE));
        break;
      }
    }
  }
  return found;
};

const inProtocol = (span: Capture["spans"][number]) =>
  !String(span.attributes.get("url.query") ?? "").includes("wsTicket=");

const spanText = (capture: Capture) =>
  JSON.stringify(
    capture.spans.filter(inProtocol).map((span) => ({
      name: span.name,
      attributes: [...span.attributes.entries()],
      events: span.events,
      // An exporter writes the failure's text, never the value a span succeeded with.
      status:
        span.status._tag === "Ended" && span.status.exit._tag === "Failure"
          ? Cause.pretty(span.status.exit.cause)
          : span.status._tag,
    })),
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );

const scenarios = Effect.gen(function* () {
  const gateway = yield* Gateway;
  const tickets: Array<string> = [];
  const urlTickets: Array<string> = [];
  const urlAnswers: Array<string> = [];
  const texts: Array<string> = [];
  const attempt = Effect.fn("attempt")(function* (
    ticket: string,
    port: number,
    input: Parameters<typeof openTunnel>[1] = {},
  ) {
    tickets.push(ticket);
    const result = yield* openTunnel(gateway.mainPort, { ticket, query: `port=${port}`, ...input });
    if (result._tag === "refused") texts.push(result.text);
    return result;
  });
  const echo = yield* listenLoopback((socket) => socket.pipe(socket));
  const dropper = yield* listenLoopback((socket) => {
    socket.on("error", () => {});
    socket.end("bye");
  });

  // Success, and the service ending the tunnel.
  const good = yield* issueSessionTicket();
  const ok = yield* attempt(good.ticket, echo.port);
  if (ok._tag === "open") {
    ok.ws.send(Buffer.from("payload"));
    ok.ws.close();
  }
  const dropped = yield* attempt(good.ticket, dropper.port);
  if (dropped._tag === "open") yield* closed(dropped.ws);

  // Credential failures.
  yield* attempt(`${good.ticket}x`, echo.port);
  yield* attempt((yield* issueSessionTicket({ ticketTtl: Duration.zero })).ticket, echo.port);
  const revoked = yield* issueSessionTicket();
  yield* gateway.sessions.revoke(revoked.session.sessionId);
  yield* attempt(revoked.ticket, echo.port);
  yield* attempt((yield* issueSessionTicket({ audience: "rpc" })).ticket, echo.port);
  yield* attempt((yield* issueSessionTicket({ audience: null })).ticket, echo.port);
  yield* attempt(
    (yield* issueSessionTicket({ scopes: [AuthPreviewOperateScope] })).ticket,
    echo.port,
  );
  const bearer = yield* issueSessionTicket();
  tickets.push(bearer.ticket);
  yield* openTunnel(gateway.mainPort, {
    authorization: `Bearer ${bearer.ticket}`,
    query: `port=${echo.port}`,
  });
  // A client that breaks the protocol and puts the ticket in the URL: the server's own HTTP span
  // records that URL (upstream behaviour for every route), so only the answer is checked.
  const inUrl = yield* issueSessionTicket();
  const misused = yield* openTunnel(gateway.mainPort, {
    ticket: inUrl.ticket,
    query: `port=${echo.port}&wsTicket=${inUrl.ticket}`,
  });
  if (misused._tag === "refused") urlAnswers.push(misused.text);
  urlTickets.push(inUrl.ticket);

  // The port check and the dial refuse.
  const refusal = yield* issueSessionTicket();
  for (const code of ["not-owned", "reserved", "debug-process", "owner-changed"] as const) {
    gateway.setAuthorize(() => Effect.fail(refuse(code, "fixed phrase")));
    yield* attempt(refusal.ticket, 5173);
  }
  gateway.setAuthorize((port) =>
    Effect.succeed({ host: "127.0.0.1", port: port + 1, pid: 1, owner: "terminal" as const }),
  );
  yield* attempt(refusal.ticket, 1);
  // A defect inside the handler.
  gateway.setAuthorize(() => Effect.die(new Error("boom inside the handler")));
  yield* attempt(refusal.ticket, 5173);
  gateway.setAuthorize((port) =>
    Effect.succeed({ host: "127.0.0.1", port, pid: 1, owner: "terminal" as const }),
  );

  // A tunnel that ends because its session was revoked.
  const mid = yield* issueSessionTicket();
  const open = yield* attempt(mid.ticket, echo.port);
  if (open._tag === "open") {
    const gone = closed(open.ws);
    yield* gateway.sessions.revoke(mid.session.sessionId);
    yield* gone;
  }
  return { tickets, texts, urlTickets, urlAnswers };
});

describe("the ticket never reaches a log or a span", () => {
  it.live.each([false, true] as const)(
    "on every path, with the request logger on: %s",
    (logWsEvents) => {
      const capture: Capture = { logs: [], spans: [] };
      return Effect.gen(function* () {
        const { tickets, texts, urlTickets, urlAnswers } = yield* scenarios;
        assert.isAbove(tickets.length, 10);
        assert.isAbove(capture.spans.length, 10);
        // The defect scenario is always logged, so the log capture is proven to be wired.
        assert.isAbove(capture.logs.length, logWsEvents ? 10 : 0);
        const haystack = [
          ...capture.logs.filter((line) => !line.includes("wsTicket=")),
          spanText(capture),
          ...texts,
        ].join("\n");
        assert.deepEqual(leaks(haystack, tickets), []);
        assert.isAbove(urlAnswers.length, 0);
        assert.deepEqual(leaks(urlAnswers.join("\n"), urlTickets), []);
        assert.notInclude(haystack, "Bearer ");
        assert.notInclude(haystack, "T3X-Gateway ");
      }).pipe(Effect.scoped, Effect.provide(makeLayerGateway({ logWsEvents, capture })));
    },
  );
});

describe("what keeps headers out of logs and traces", () => {
  it.effect(
    "the server's observability layer redacts Authorization and records no headers in spans",
    () =>
      Effect.gen(function* () {
        const names = yield* Headers.CurrentRedactedNames;
        assert.include(names, "authorization");
        const filter = yield* HttpMiddleware.TracerHeaderFilter;
        assert.isFalse(filter("authorization", "request"));
        assert.isFalse(filter("authorization", "response"));
        const redacted = Headers.redact(
          Headers.fromInput({ authorization: "T3X-Gateway secret" }),
          names,
        );
        assert.isTrue(Redacted.isRedacted(redacted.authorization));
        assert.equal(String(redacted.authorization), "<redacted>");
      }).pipe(Effect.provide(HttpObservability.layer.pipe(Layer.orDie))),
  );

  it("is the only place in the server that sets the redaction list or the header filter", () => {
    const roots = [
      NodePath.resolve(import.meta.dirname, "../.."),
      NodePath.resolve(import.meta.dirname, "../../../../../packages/shared/src"),
    ];
    const hits: Array<string> = [];
    const walk = (directory: string) => {
      for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
        const full = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (
          /\.[cm]?tsx?$/u.test(entry.name) &&
          !/\.(?:test|browser\.test)\.|testkit/u.test(entry.name)
        ) {
          const text = NodeFS.readFileSync(full, "utf8");
          if (/Headers\.CurrentRedactedNames|TracerHeaderFilter/u.test(text)) {
            hits.push(
              NodePath.relative(NodePath.resolve(import.meta.dirname, "../../../../.."), full),
            );
          }
        }
      }
    };
    for (const root of roots) walk(root);
    // Anything else that sets either needs a person to confirm it keeps `authorization` hidden.
    assert.deepEqual(hits.toSorted(), ["packages/shared/src/httpObservability.ts"]);
  });
});
