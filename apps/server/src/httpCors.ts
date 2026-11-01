import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity"; // fork: identity

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${FORK.scheme}://app`,
  `${FORK.schemeDev}://app`,
] as const; // fork: own scheme
