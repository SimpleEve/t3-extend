// fork: system notices T3 Extend words itself reach clients as plain English. A notice is looked up
// in the fork's catalog only when its text is exactly one of them; agent and user text never is.
import { FORK_SYSTEM_NOTICES } from "@t3tools/shared/forkNotices";

import { getUiLocale } from "../i18n/store.ts";
import { translate } from "../i18n/translate.ts";

export const translateForkNotice = (label: string): string =>
  FORK_SYSTEM_NOTICES.has(label) ? translate(getUiLocale(), label) : label;
