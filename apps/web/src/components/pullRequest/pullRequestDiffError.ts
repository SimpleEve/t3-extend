import { getUiLocale, translate, translatorFor } from "@t3tools/client-runtime/i18n";
import { changeRequestTerm } from "./changeRequestTerm";

/** Diff failures currently include transport wrappers, so recognize the reason inside them. */
export function describePullRequestDiffError(error: string, providerName: string, term: string) {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/i.test(error)) {
    return {
      title: translate(getUiLocale(), "{providerName} rate limit reached", { providerName }),
      description: translate(
        getUiLocale(),
        "{providerName} is temporarily limiting requests, so this diff couldn't be loaded. Try again after the limit resets, or view the changes on {providerName}.",
        { providerName },
      ),
    };
  }

  return {
    title: translate(getUiLocale(), "Couldn't load the changes"),
    description: translate(
      getUiLocale(),
      "The environment couldn't load this {kind}'s diff. Try again, or view the changes on {providerName}.",
      { kind: changeRequestTerm(term, translatorFor(getUiLocale())), providerName },
    ),
  };
}
