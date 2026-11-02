import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { FORK_PUSH_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";

// fork: the writes of the `push.*` RPCs, through the shared command boundary so the phone checks
// the grant on the environment it sends to. One call per environment at a time.
const perEnvironment = {
  mode: "serial" as const,
  key: ({ environmentId }: { environmentId: string }) => environmentId,
};

export const pushEnvironment = {
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:push:register",
    tag: FORK_PUSH_WS_METHODS.register,
    concurrency: perEnvironment,
  }),
  unregister: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:push:unregister",
    tag: FORK_PUSH_WS_METHODS.unregister,
    concurrency: perEnvironment,
  }),
  sendTest: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:push:send-test",
    tag: FORK_PUSH_WS_METHODS.sendTest,
    concurrency: perEnvironment,
  }),
};
