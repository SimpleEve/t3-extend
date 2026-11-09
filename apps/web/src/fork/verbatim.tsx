import type { ReactNode } from "react";

/**
 * A settings title that is the user's own text: a project, environment, thread or provider name.
 * `SettingsSection` and `SettingsRow` translate a string title, so a project called `server`
 * would show as its catalog entry; a node is drawn as it is. Limit: a `SettingsRow` with a node
 * title that also has `settingKeys` gets a reset button labelled "override"; none uses `verbatim`.
 */
export function verbatim(text: string): ReactNode {
  return <>{text}</>;
}
