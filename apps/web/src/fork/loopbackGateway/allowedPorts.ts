// fork: the ports the user allowed on a remote environment (research/remote-loopback-forwarding.md
// 5.6.3). The three RPCs all answer with the whole list, so one atom per environment holds what
// the last call said and every call refreshes it; there is no subscription.
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  FORK_LOOPBACK_GATEWAY_WS_METHODS,
  LoopbackGatewayAllowedPortError,
  type EnvironmentId,
  type LoopbackGatewayAllowedPort,
  type LoopbackGatewayAllowedPortFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

const M = FORK_LOOPBACK_GATEWAY_WS_METHODS;

/** What the environment last said, or `null` before it has said anything. */
const allowedPortsAtom = Atom.family((environmentId: string) =>
  Atom.make<ReadonlyArray<LoopbackGatewayAllowedPort> | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`loopback-gateway-allowed-ports:${environmentId}`),
  ),
);

// Each write is one call at a time per environment, so two clicks never interleave.
const serial = {
  mode: "serial" as const,
  key: ({ environmentId }: { environmentId: string }) => environmentId,
};

const remember = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
  result: { readonly ports: ReadonlyArray<LoopbackGatewayAllowedPort> },
) => Effect.sync(() => registry.set(allowedPortsAtom(target.environmentId), result.ports));

export const listAllowedLoopbackPorts = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:loopback-gateway:list-allowed-ports",
  tag: M.listAllowedPorts,
  concurrency: serial,
  onSuccess: remember,
});

export const allowLoopbackPort = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:loopback-gateway:allow-port",
  tag: M.allowPort,
  concurrency: serial,
  onSuccess: remember,
});

export const removeAllowedLoopbackPort = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:loopback-gateway:remove-allowed-port",
  tag: M.removeAllowedPort,
  concurrency: serial,
  onSuccess: remember,
});

/** The allowed ports of an environment; `null` until one call has answered. */
export function useAllowedLoopbackPorts(environmentId: EnvironmentId) {
  return useAtomValue(allowedPortsAtom(environmentId));
}

export type AllowedPortFailure = LoopbackGatewayAllowedPortFailure | "failed";

export type AllowedPortOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: AllowedPortFailure };

const isAllowedPortError = Schema.is(LoopbackGatewayAllowedPortError);

const outcomeOf = (result: AtomCommandResult<unknown, unknown>): AllowedPortOutcome => {
  if (result._tag === "Success") return { ok: true };
  const error = squashAtomCommandFailure(result);
  return { ok: false, failure: isAllowedPortError(error) ? error.reason : "failed" };
};

const run = async (
  command: typeof allowLoopbackPort | typeof removeAllowedLoopbackPort,
  environmentId: EnvironmentId,
  port: number,
): Promise<AllowedPortOutcome> =>
  outcomeOf(
    await runAtomCommand(
      appAtomRegistry,
      command,
      { environmentId, input: { port } },
      { reportFailure: false },
    ),
  );

export const allowLoopbackGatewayPort = (environmentId: EnvironmentId, port: number) =>
  run(allowLoopbackPort, environmentId, port);

export const removeAllowedLoopbackGatewayPort = (environmentId: EnvironmentId, port: number) =>
  run(removeAllowedLoopbackPort, environmentId, port);

/** Asks the environment for its list again; the answer lands in `useAllowedLoopbackPorts`. */
export const refreshAllowedLoopbackPorts = async (environmentId: EnvironmentId): Promise<void> => {
  await runAtomCommand(
    appAtomRegistry,
    listAllowedLoopbackPorts,
    { environmentId, input: {} },
    { reportFailure: false },
  );
};
