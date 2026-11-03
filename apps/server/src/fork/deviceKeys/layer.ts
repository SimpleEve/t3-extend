import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DeviceIdentity from "./DeviceIdentity.ts";
import * as DeviceKeysService from "./DeviceKeysService.ts";
import * as RegistryClient from "./RegistryClient.ts";
import * as TunnelListener from "./TunnelListener.ts";

/** The services the CLI needs: no sync loop and no listener. */
const layerServices = DeviceKeysService.layer.pipe(
  Layer.provideMerge(DeviceDirectory.layer),
  Layer.provideMerge(Layer.mergeAll(DeviceIdentity.layer, RegistryClient.layer)),
);

/** Everything the server runs: the services, the 60-second sync, and the tunnel origin the listener asks for. */
export const layer = Layer.mergeAll(
  Layer.effect(
    TunnelListener.TunnelOrigin,
    DeviceDirectory.DeviceDirectory.pipe(
      Effect.map((directory) =>
        TunnelListener.TunnelOrigin.of({ current: directory.tunnelOrigin }),
      ),
    ),
  ),
  Layer.effectDiscard(
    DeviceDirectory.DeviceDirectory.pipe(
      Effect.flatMap((directory) => forkParked(directory.syncLoop)),
    ),
  ),
).pipe(Layer.provideMerge(layerServices));
