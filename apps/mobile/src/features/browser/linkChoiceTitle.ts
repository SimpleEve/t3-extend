import type { Translator } from "@t3tools/client-runtime/i18n";

import type { LinkChoice } from "./linkChoices";

export function linkChoiceTitle(choice: LinkChoice, t: Translator): string {
  switch (choice) {
    case "built-in":
      return t("Open in built-in browser");
    case "system":
      return t("Open in system browser");
    case "copy":
      return t("Copy link");
  }
}
