// fork: the host's word for a change request, in the interface language.
// Hosts say "pull request", "merge request", or "change request" ("pull requests",
// "merge requests", "change requests" in lists); English keeps the host's word
// and the catalog maps each to the glossary's short form (PR, MR) so sentences read naturally.
import type { Translator } from "@t3tools/client-runtime/i18n";

export function changeRequestTerm(singular: string, t: Translator): string {
  return t(singular, undefined, "change request");
}
