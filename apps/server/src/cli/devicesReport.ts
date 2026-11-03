// fork: errors a person or script is meant to read (a bad invite, no frpc, an unreachable server)
// print as one line on stderr and are marked reported, as in `t3 thread`, so the runtime adds no stack.
import { DeviceKeysError } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import { FrpBinaryError } from "../fork/deviceKeys/frpBinary.ts";

export class DevicesCliError extends Schema.TaggedError<DevicesCliError>()("DevicesCliError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const isExpected = Schema.is(Schema.Union([DeviceKeysError, FrpBinaryError]));

export const reportDeviceErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) => (isExpected(error) ? Console.error(error.message) : Effect.void)),
    Effect.mapError((error) =>
      isExpected(error) ? new DevicesCliError({ detail: error.message }) : error,
    ),
  );
