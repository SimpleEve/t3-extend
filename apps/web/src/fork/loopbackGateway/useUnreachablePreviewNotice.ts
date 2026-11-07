// fork: the preview panel's placeholder for an environment whose session cannot be read because
// it is not connected, so "pair again" is not shown for what is only an absent connection.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useT } from "~/hooks/useT";
import { useEnvironment } from "~/state/environments";
import { environmentSession } from "~/state/session";

// `error` and `unsupported` are a blocked connection (authentication, configuration, permission):
// it does not come back by itself, and pairing again is the way out.
const WAITING_PHASES: ReadonlySet<string | undefined> = new Set([
  "offline",
  "available",
  "connecting",
  "reconnecting",
]);

/** The grants are unknown (never read, or the read failed) and the connection may still come up. */
const isPreviewSessionUnreadable = (input: {
  readonly sessionResult: "Initial" | "Success" | "Failure";
  readonly phase: string | undefined;
}): boolean => input.sessionResult !== "Success" && WAITING_PHASES.has(input.phase);

/** The words for an unreachable environment's panel, or `null` when pairing is the real problem. */
export function useUnreachablePreviewNotice(environmentId: EnvironmentId): string | null {
  const t = useT();
  const environment = useEnvironment(environmentId);
  const sessionResult = useAtomValue(
    environmentSession.sessionStateAtom(environmentId),
    (result) => result._tag,
  );
  if (
    !isPreviewSessionUnreadable({
      sessionResult,
      phase: environment?.connection.phase,
    })
  ) {
    return null;
  }
  return t("Can't reach {environment}. Browser previews come back once it is connected.", {
    environment: environment?.label ?? t("the environment"),
  });
}
