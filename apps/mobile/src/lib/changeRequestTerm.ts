// fork: the host's word for a change request, in the interface language. English keeps the host's
// word ("pull request", "merge requests"); the catalog maps each to the glossary's PR or MR.
import type { Translator } from "@t3tools/client-runtime/i18n";

export function changeRequestTerm(term: string, t: Translator): string {
  return t(term, undefined, "change request");
}
