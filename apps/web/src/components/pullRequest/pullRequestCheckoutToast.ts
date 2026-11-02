import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { getUiLocale, translate, translatorFor } from "@t3tools/client-runtime/i18n";
import { changeRequestTerm } from "./changeRequestTerm";

export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: translate(getUiLocale(), "Checked out, but not confirmed on the latest commit"),
    description: translate(
      getUiLocale(),
      "This checkout could not be confirmed at the {kind}'s latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
      { kind: changeRequestTerm(terminology.singular, translatorFor(getUiLocale())) },
    ),
  } as const;
}
