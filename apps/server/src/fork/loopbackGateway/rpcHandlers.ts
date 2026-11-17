// fork: the `loopbackGateway.issueTicket` RPC. It is the only way to mint a tunnel ticket: the
// generic `/api/auth/websocket-ticket/:use` endpoint refuses this audience. Both scopes are
// enforced before this runs, by `clientRpcRequiredScopes` in the RPC authorization layer. The
// allowed-ports RPCs are thin calls into `LoopbackGatewayGrants` under the same two scopes.
import {
  FORK_LOOPBACK_GATEWAY_WS_METHODS,
  LOOPBACK_GATEWAY_TICKET_AUDIENCE,
  LoopbackGatewayUnavailableError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as GatewayAvailability from "./GatewayAvailability.ts";
import * as GatewayLimits from "./GatewayLimits.ts";
import * as LoopbackGatewayGrants from "./LoopbackGatewayGrants.ts";

export const makeLoopbackGatewayRpcHandlers = Effect.fn("makeLoopbackGatewayRpcHandlers")(
  function* (session: {
    readonly sessionId: SessionStore.VerifiedSession["sessionId"];
    readonly proofKeyThumbprint?: string | undefined;
  }) {
    const sessions = yield* SessionStore.SessionStore;
    const grants = yield* LoopbackGatewayGrants.LoopbackGatewayGrants;
    return {
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.listAllowedPorts]: Effect.fn(
        "LoopbackGateway.listAllowedPorts",
      )(function* () {
        return { ports: yield* grants.list };
      }),
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.allowPort]: Effect.fn("LoopbackGateway.allowPortRpc")(
        function* ({ port }: { readonly port: number }) {
          return { ports: yield* grants.allow(port) };
        },
      ),
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.removeAllowedPort]: Effect.fn(
        "LoopbackGateway.removeAllowedPortRpc",
      )(function* ({ port }: { readonly port: number }) {
        return { ports: yield* grants.remove(port) };
      }),
      [FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket]: Effect.fn("LoopbackGateway.issueTicket")(
        function* () {
          const state = yield* GatewayAvailability.currentAvailability;
          const limits = yield* GatewayLimits.GatewayLimits;
          if (!state.available) {
            return yield* new LoopbackGatewayUnavailableError({
              reason: state.reason,
              message:
                state.reason === "discovery-disabled"
                  ? "This environment has port discovery turned off."
                  : "This environment's platform does not offer localhost forwarding.",
            });
          }
          if (!(yield* limits.takeTicket(session.sessionId))) {
            return yield* new LoopbackGatewayUnavailableError({
              reason: "rate-limited",
              message: "Too many tickets were requested. Try again in a minute.",
            });
          }
          // The session's DPoP key goes into the ticket only so the tunnel follows its renewals
          // (design N1); the tunnel route never asks for a proof.
          const issued = yield* sessions
            .issueWebSocketToken(session.sessionId, {
              audience: LOOPBACK_GATEWAY_TICKET_AUDIENCE,
              ...(session.proofKeyThumbprint === undefined
                ? {}
                : { proofKeyThumbprint: session.proofKeyThumbprint }),
            })
            .pipe(Effect.orDie);
          return {
            ticket: Redacted.make(issued.token),
            expiresAt: DateTime.toUtc(issued.expiresAt),
          };
        },
      ),
    };
  },
);
