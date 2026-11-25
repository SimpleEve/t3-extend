// fork: system notices T3 words itself. The server sends them as plain English, so a client
// translates a notice only when its text is exactly one of these; a notice that came from an agent
// or a user is never looked up in the catalog.
import { FORK } from "./forkIdentity.ts";

/** omp has no session-wide approval for the tool, so "Allow for session" approved once. */
export const SESSION_UNAVAILABLE_NOTICE =
  "omp did not offer a session-wide approval, so this request was approved once only.";

/** Summaries the server writes into the `notification` items that wake or resume a thread. */
const BACKGROUND_ACTIVITY_NOTICE = "Background activity updated";
const RESUMED_THREAD_NOTICE = "Resumed thread";

/** Summaries of the notification that carries a thread on after the server restarted. */
export const RESTART_RESUMED_NOTICE = `${FORK.appBaseName} restarted and resumed this turn`;
export const RESTART_STOPPED_NOTICE = `${FORK.appBaseName} restarted and stopped background work`;
export const RUNTIME_EXITED_NOTICE = "The agent runtime exited and stopped background work";

export const FORK_SYSTEM_NOTICES: ReadonlySet<string> = new Set([
  SESSION_UNAVAILABLE_NOTICE,
  BACKGROUND_ACTIVITY_NOTICE,
  RESUMED_THREAD_NOTICE,
  RESTART_RESUMED_NOTICE,
  RESTART_STOPPED_NOTICE,
  RUNTIME_EXITED_NOTICE,
]);
