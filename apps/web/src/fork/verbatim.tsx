import type { ReactNode } from "react";

/**
 * A settings title that is the user's own text: a project, environment, thread or provider name.
 * `SettingsSection` and `SettingsRow` translate a string title, so a project called `server`
 * would show as its catalog entry; a node is drawn as it is.
 */
export function verbatim(text: string): ReactNode {
  return <>{text}</>;
}
