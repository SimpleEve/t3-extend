import type {
  ProviderAdapterDriver,
  ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makePiAdapterV2, type PiAdapterV2DriverEnv } from "@t3tools/provider-pi/server/adapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OmpSettings } from "../settings.ts";
import { OMP_DIALECT, OMP_PROVIDER } from "./dialect.ts";

const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});

/** The Pi adapter running against omp's RPC dialect. */
export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, PiAdapterV2DriverEnv> = {
  driverKind: OMP_PROVIDER,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      return yield* makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        continuationRequests,
        dialect: OMP_DIALECT,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create omp adapter.",
              cause,
            }),
        ),
      ),
  ),
};
