import * as Layer from "effect/Layer";

import * as LoopbackGatewayGrants from "./LoopbackGatewayGrants.ts";
import * as PortAuthorizer from "./PortAuthorizer.ts";
import * as ProcessInspector from "./ProcessInspector.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";
import * as TunnelRoute from "./TunnelRoute.ts";

/**
 * The ports the user allowed. Provided once, at the server's top level, so that the port check and
 * the RPC handlers (which run in the WebSocket's request-time context) share one list.
 */
export const layerGrants = LoopbackGatewayGrants.layer;

/** What the tunnel route needs: the port check and what it reads. It needs `layerGrants` from above. */
export const layerServices = PortAuthorizer.layer.pipe(
  Layer.provideMerge(PortAuthorizer.layerConfiguredExecutables),
  Layer.provideMerge(TerminalShellRegistry.layer),
  Layer.provideMerge(ProcessInspector.layer),
);

export const layerRoute = TunnelRoute.layer;
