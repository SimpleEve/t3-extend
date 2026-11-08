import type { Translator } from "@t3tools/client-runtime/i18n";
import { OFFICIAL_APP_NAME } from "@t3tools/contracts";

// fork: the server writes each clean-up entry's `reason` as an English sentence (storageCleanup.ts)
// and the data stays English, for logs and for servers of any version. The settings page looks the
// sentence up here when it shows it. A reason that is not listed, such as a Git error, shows as sent.
// Adding a server reason without a row here fails storageCleanupReasons.test.ts.
const REASON_TEMPLATES = [
  "No thread uses this worktree",
  "No thread uses this folder, and it isn't a git worktree",
  "Shared with {app}",
  "No rules apply",
  "Shared by {count} threads",
  "Project is unavailable",
  "Thread is running or has pending work",
  "A subagent thread's branch differs from this worktree's branch",
  "Open terminal",
  "Worktree is a symbolic link",
  "Outside the managed worktree folder",
  "Contains a project checkout",
  "Not a linked worktree",
  "Repository or branch changed",
  "Repository or branch changed since check",
  "Commit changed since check",
  "Settings changed since check",
  "Thread or cleanup settings changed since check",
  "Thread activity or shared worktree changed since check",
  "Parent settlement changed since check",
  "Thread deletion is still pending",
  "Provider session is still open",
  "Settled moments ago",
  "No remote is configured for merged-worktree cleanup",
  "Project branch is unavailable",
  "Default branch is unavailable",
  "Has commits beyond the project branch",
  "Has commits beyond the default branch",
  "Inactive for {days} of {limit} days",
  "Settled for {days} of {limit} days",
  "Not settled",
  "Not merged",
  "Local changes exceed the inspection limit",
  "Ignored files exceed the inspection limit",
  "Has uncommitted changes (1 file)",
  "Has uncommitted changes ({count} files)",
  "Has ignored files ({file})",
  "Submodule inspection exceeded the limit",
  "Submodule repository could not be inspected",
  "Submodule has commits not on a remote-tracking ref",
  "Submodule has local files",
  "Submodules could not be inspected",
  "Submodule local changes exceed the inspection limit",
  "Submodule ignored files exceed the inspection limit",
  "Submodule has uncommitted changes (1 file)",
  "Submodule has uncommitted changes ({count} files)",
  "Submodule has ignored files ({file})",
  "Thread was deleted",
  "Inactive for {days} days",
  "Settled for {days} days",
  "No commits beyond the project branch",
  "No commits beyond the default branch",
  "Pull request was merged",
  "No expired files",
  "Removed {count} browser artifacts",
  "Removed {count} rotated logs",
  "Could not parse the pnpm modules manifest.",
] as const;

// The same English is an action elsewhere ("Open terminal" opens one).
const CONTEXTS: Readonly<Record<string, string>> = { "Open terminal": "cleanup reason" };
const FIXED_PARAMS: Readonly<Record<string, string>> = { app: OFFICIAL_APP_NAME };
const NUMERIC_PARAMS: ReadonlySet<string> = new Set(["count", "days", "limit"]);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const compiled = REASON_TEMPLATES.map((source) => {
  const names: string[] = [];
  const pattern = source
    .split(/(\{[A-Za-z]+\})/)
    .map((part) => {
      const name = /^\{([A-Za-z]+)\}$/.exec(part)?.[1];
      if (name === undefined) return escapeRegExp(part);
      const fixed = FIXED_PARAMS[name];
      if (fixed !== undefined) return escapeRegExp(fixed);
      names.push(name);
      return NUMERIC_PARAMS.has(name) ? "(\\d+)" : "(.+)";
    })
    .join("");
  return { source, names, regex: new RegExp(`^${pattern}$`, "s") };
});

/** The English reason templates the server can produce, for the test that keeps them translated. */
export const STORAGE_CLEANUP_REASON_TEMPLATES: readonly string[] = REASON_TEMPLATES;

/** Translates a clean-up reason the server wrote in English, or returns it unchanged. */
export function localizeCleanupReason(reason: string, t: Translator): string {
  for (const { source, names, regex } of compiled) {
    const match = regex.exec(reason);
    if (match === null) continue;
    return t(
      source,
      {
        ...FIXED_PARAMS,
        ...Object.fromEntries(names.map((name, index) => [name, match[index + 1]!])),
      },
      CONTEXTS[source],
    );
  }
  return reason;
}
