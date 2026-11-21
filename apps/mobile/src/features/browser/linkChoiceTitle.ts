import { msg } from "gt-react-native";

import type { MessageResolver } from "../../i18n/messages";
import type { LinkChoice } from "./linkChoices";

export function linkChoiceTitle(choice: LinkChoice, resolve: MessageResolver): string {
  switch (choice) {
    case "built-in":
      return resolve(msg("Open in built-in browser"));
    case "system":
      return resolve(msg("Open in system browser"));
    case "copy":
      return resolve(msg("Copy link"));
  }
}
