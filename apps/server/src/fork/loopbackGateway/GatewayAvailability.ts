// fork: whether this server offers the gateway at all (research/remote-loopback-forwarding.md
// 5.4, 5.6.5, 8). macOS only for now: Linux waits for its real-process tests, Windows has no
// argv or environment reads. Port discovery must be on, or there is nothing to authorize.
import type { LoopbackGatewayUnavailableReason } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type GatewayAvailabilityResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: LoopbackGatewayUnavailableReason };

/** The platforms whose process checks have been verified against real processes. */
const VERIFIED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin"]);

export const loopbackGatewayAvailability = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): GatewayAvailabilityResult => {
  if (!VERIFIED_PLATFORMS.has(platform))
    return { available: false, reason: "unsupported-platform" };
  if (environment.T3CODE_PORT_DISCOVERY === "0")
    return { available: false, reason: "discovery-disabled" };
  return { available: true };
};

/** The capability bit for the environment descriptor: present only when the gateway is offered. */
export const loopbackGatewayCapability = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): { readonly loopbackGateway?: true } =>
  loopbackGatewayAvailability(platform, environment).available ? { loopbackGateway: true } : {};

/** Tests set this to pin the answer; `null` means read the platform and environment. */
export const GatewayAvailabilityOverride = Context.Reference<GatewayAvailabilityResult | null>(
  "t3/fork/loopbackGateway/GatewayAvailabilityOverride",
  { defaultValue: () => null },
);

export const currentAvailability = Effect.gen(function* () {
  const override = yield* GatewayAvailabilityOverride;
  if (override !== null) return override;
  return loopbackGatewayAvailability(yield* HostProcess.Platform, yield* HostProcess.Environment);
});
