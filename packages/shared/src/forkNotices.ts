// fork: system notices T3 words itself. The server sends them as plain English, so a client
// translates a notice only when its text is exactly one of these; a notice that came from an agent
// or a user is never looked up in the catalog.

/** omp has no session-wide approval for the tool, so "Allow for session" approved once. */
export const SESSION_UNAVAILABLE_NOTICE =
  "omp did not offer a session-wide approval, so this request was approved once only.";

export const FORK_SYSTEM_NOTICES: ReadonlySet<string> = new Set([SESSION_UNAVAILABLE_NOTICE]);
