// fork: the tunnel route's own credential check (research/remote-loopback-forwarding.md 4.4). It
// never calls `authenticateWebSocketUpgrade`, which accepts a ticket that has no audience, and it
// only ever reads `Authorization: T3X-Gateway <ticket>`: no cookie, `Bearer`, `DPoP` or query ticket.
import {
  LOOPBACK_GATEWAY_REFUSED_TICKET_PARAM,
  parseLoopbackGatewayAuthorization,
} from "@t3tools/shared/forkLoopbackGateway/protocol";
import {
  LOOPBACK_GATEWAY_REQUIRED_SCOPES,
  LOOPBACK_GATEWAY_TICKET_AUDIENCE,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as SessionStore from "../../auth/SessionStore.ts";
import { requestUrl } from "../../requestUrl.ts";
import { refuse, type GatewayRefusal } from "./PortAuthorizer.ts";

// The literal EnvironmentAuth keeps private (`MCP_CLIENT_SUBJECT`); a test issues a real MCP
// client session so a change upstream fails there.
const MCP_CLIENT_SUBJECT = "mcp-client";

export interface GatewaySession {
  readonly sessionId: AuthSessionId;
  /** The session's DPoP key, kept only so `awaitInvalidation` follows renewals (design N1). */
  readonly proofKeyThumbprint?: string;
  /** Checks again, with the same ticket, that the session is still live; refuses if it is not. */
  readonly recheck: Effect.Effect<void, GatewayRefusal>;
}

/** The ticket as a `Redacted`, the only form that leaves this function. */
const readTicket = (
  headers: HttpServerRequest.HttpServerRequest["headers"],
): Redacted.Redacted<string> | null => {
  const ticket = parseLoopbackGatewayAuthorization(headers.authorization);
  return ticket === null ? null : Redacted.make(ticket);
};

export const authenticateGatewayTicket = Effect.fn("LoopbackGateway.authenticate")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const sessions = yield* SessionStore.SessionStore;
  const url = requestUrl(request);
  if (Option.isNone(url)) return yield* refuse("bad-request", "the request URL is invalid");
  // Refused unread: a ticket in a URL is logged by every proxy between here and the client.
  if (url.value.searchParams.has(LOOPBACK_GATEWAY_REFUSED_TICKET_PARAM)) {
    return yield* refuse("ticket-in-url", "the ticket must be sent in the Authorization header");
  }
  // Browsers always send Origin and cannot set the header below, so this is never a page.
  if (request.headers.origin !== undefined) {
    return yield* refuse("forbidden", "browsers cannot open tunnels");
  }
  const ticket = readTicket(request.headers);
  if (ticket === null) return yield* refuse("unauthorized", "a gateway ticket is required");
  const verify = sessions
    .verifyWebSocketToken(Redacted.value(ticket))
    .pipe(
      Effect.catch((error) =>
        SessionStore.isSessionCredentialInvalidError(error)
          ? Effect.fail(refuse("unauthorized", "the gateway ticket was rejected"))
          : Effect.fail(refuse("internal", "the gateway ticket could not be checked")),
      ),
    );
  const verified = yield* verify;
  if (verified.subject === MCP_CLIENT_SUBJECT) {
    return yield* refuse("forbidden", "MCP client sessions cannot open tunnels");
  }
  if (verified.audience !== LOOPBACK_GATEWAY_TICKET_AUDIENCE) {
    return yield* refuse("unauthorized", "the ticket was not issued for tunnels");
  }
  if (!LOOPBACK_GATEWAY_REQUIRED_SCOPES.every((scope) => verified.scopes.includes(scope))) {
    return yield* refuse("forbidden", "the session lacks the preview and terminal grants");
  }
  return {
    sessionId: verified.sessionId,
    ...(verified.proofKeyThumbprint ? { proofKeyThumbprint: verified.proofKeyThumbprint } : {}),
    recheck: Effect.asVoid(verify),
  } satisfies GatewaySession;
});
