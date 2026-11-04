// fork: asking a remote environment for the ticket that opens its tunnels.
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { FORK_LOOPBACK_GATEWAY_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export const issueLoopbackGatewayTicket = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:loopback-gateway:issue-ticket",
  tag: FORK_LOOPBACK_GATEWAY_WS_METHODS.issueTicket,
});

/** The ticket, or `null` when the environment would not issue one. It is never logged. */
export async function fetchLoopbackGatewayTicket(
  environmentId: string,
): Promise<{ readonly ticket: string; readonly expiresAt: Date } | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    issueLoopbackGatewayTicket,
    { environmentId: environmentId as EnvironmentId, input: {} },
    { reportFailure: false },
  );
  return result._tag === "Success"
    ? {
        ticket: Redacted.value(result.value.ticket),
        expiresAt: DateTime.toDate(result.value.expiresAt),
      }
    : null;
}
