import * as Layer from "effect/Layer";

import * as PortAuthorizer from "./PortAuthorizer.ts";
import * as ProcessInspector from "./ProcessInspector.ts";
import * as TerminalShellRegistry from "./TerminalShellRegistry.ts";
import * as TunnelRoute from "./TunnelRoute.ts";

/** What the tunnel route needs: the port check and what it reads. */
export const layerServices = PortAuthorizer.layer.pipe(
  Layer.provideMerge(PortAuthorizer.layerConfiguredExecutables),
  Layer.provideMerge(TerminalShellRegistry.layer),
  Layer.provideMerge(ProcessInspector.layer),
);

export const layerRoute = TunnelRoute.layer;
