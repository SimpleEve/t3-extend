import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { shortcutLabelForCommand } from "../keybindings";
import { announce, cancelAnnouncement } from "../lib/announce";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import {
  getUiLocale,
  translate,
  translatorFor,
  type Translator,
} from "@t3tools/client-runtime/i18n"; // fork: interface language

type UndoOptions = {
  action: "Settled" | "Snoozed" | "Unpinned" | "Archived" | "Discarded";
  undo: () => Promise<AtomCommandResult<unknown, unknown>>;
  failureTitle: string;
  claim: ReturnType<typeof ThreadUndo.begin>;
  commit?: () => void;
};

type UndoNotice = {
  action: UndoOptions["action"];
  count: number;
  undo: () => Promise<void>;
};

export const useThreadUndoNotice = create<{ notice: UndoNotice | null }>(() => ({ notice: null }));

// fork: whole phrases per action and number, so translations never assemble grammar.
const SUMMARY_SOURCES: Record<UndoOptions["action"], readonly [one: string, many: string]> = {
  Settled: ["Settled 1 thread", "Settled {count} threads"],
  Snoozed: ["Snoozed 1 thread", "Snoozed {count} threads"],
  Unpinned: ["Unpinned 1 thread", "Unpinned {count} threads"],
  Archived: ["Archived 1 thread", "Archived {count} threads"],
  Discarded: ["Discarded 1 draft", "Discarded {count} drafts"],
};

// fork: the footer's short form, which drops the noun.
const COMPACT_SUMMARY_SOURCES: Record<UndoOptions["action"], readonly [one: string, many: string]> =
  {
    Settled: ["Settled", "Settled {count}"],
    Snoozed: ["Snoozed", "Snoozed {count}"],
    Unpinned: ["Unpinned", "Unpinned {count}"],
    Archived: ["Archived", "Archived {count}"],
    Discarded: ["Discarded", "Discarded {count}"],
  };

const UNDONE_ACTION = {
  Settled: "settle",
  Snoozed: "snooze",
  Unpinned: "unpin",
  Archived: "archive",
  Discarded: "discard",
} satisfies Record<UndoOptions["action"], string>;

function countLabel(action: UndoOptions["action"], count: number) {
  const noun = action === "Discarded" ? "draft" : "thread";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function threadUndoNoticeSummary(notice: Pick<UndoNotice, "action" | "count">): string {
  const [one, many] = SUMMARY_SOURCES[notice.action];
  return translate(getUiLocale(), notice.count === 1 ? one : many, { count: notice.count });
}

/** The undo notice's short summary in the sidebar footer. */
export function threadUndoCompactSummary(
  notice: Pick<UndoNotice, "action" | "count">,
  t: Translator,
): string {
  const [one, many] = COMPACT_SUMMARY_SOURCES[notice.action];
  return t(notice.count === 1 ? one : many, { count: notice.count }, "undo notice");
}

export function threadUndoLabel(
  keybindings: Parameters<typeof shortcutLabelForCommand>[0],
  t: Translator = translatorFor(getUiLocale()), // fork: interface language
) {
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  return shortcut ? `${shortcut} to undo` : "Undo";
}

let announcedSummary: string | null = null;

// A live region that mounts already filled is skipped by screen readers, and settling
// usually moves focus to the next thread at the same moment, so the notice is announced
// separately from the alert that shows it.
function setNotice(notice: UndoNotice | null) {
  useThreadUndoNotice.setState({ notice });
  const summary = notice ? threadUndoNoticeSummary(notice) : null;
  if (summary === announcedSummary) return;
  announcedSummary = summary;
  if (summary) {
    const label = threadUndoLabel(appAtomRegistry.get(primaryServerKeybindingsAtom));
    announce(
      translate(getUiLocale(), "{summary}, {undo}", { summary, undo: label }), // fork
      "thread-undo-notice",
    );
  } else {
    cancelAnnouncement("thread-undo-notice");
  }
}

let liveUndos: UndoOptions[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
// A new notice owns mod+z even inside a text field, until the user presses
// another key or edits text. After that, mod+z is the field's own undo again.
let shortcutClaimed = false;

function refreshNotice() {
  const stale = liveUndos.filter(({ claim }) => !claim.isCurrent());
  liveUndos = liveUndos.filter((entry) => !stale.includes(entry));
  for (const entry of stale) entry.commit?.();
  const latest = liveUndos.at(-1);
  if (!latest) {
    clearTimeout(expiry);
    setNotice(null);
    return;
  }
  const group: UndoOptions[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  setNotice({
    action: latest.action,
    count: group.length,
    undo: async () => {
      const current = group.filter((entry) => liveUndos.includes(entry) && entry.claim.isCurrent());
      liveUndos = liveUndos.filter((entry) => !group.includes(entry));
      // Claim before awaiting to prevent repeated actions restoring a group twice.
      for (const entry of current) entry.claim.finish();
      refreshNotice();
      let undone = 0;
      await Promise.all(
        current.map(async ({ undo, failureTitle }) => {
          const reportFailure = (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: translate(getUiLocale(), failureTitle), // fork: translated where shown
                description:
                  error instanceof Error
                    ? error.message
                    : translate(getUiLocale(), "An error occurred."),
              }),
            );
          };
          try {
            const result = await undo();
            if (result._tag === "Success") undone++;
            else if (!isAtomCommandInterrupted(result)) {
              reportFailure(squashAtomCommandFailure(result));
            }
          } catch (error) {
            reportFailure(error);
          }
        }),
      );
      // Failures already raise a toast, so only what was actually restored is spoken.
      if (undone > 0) {
        announce(`Undid ${UNDONE_ACTION[latest.action]} of ${countLabel(latest.action, undone)}`);
      }
    },
  });
}

ThreadUndo.subscribe(refreshNotice);

export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  void notice.undo();
  return true;
}

/** Whether mod+z should undo the notice's actions even while a text field is focused. */
export function threadUndoClaimsShortcut(): boolean {
  return shortcutClaimed && useThreadUndoNotice.getState().notice !== null;
}

/** Called on any other keypress or text edit; hands mod+z back to text fields. */
export function releaseThreadUndoShortcut() {
  shortcutClaimed = false;
}

/** Shows one compact confirmation for the currently undoable thread actions. */
export function showThreadUndoNotice(options: UndoOptions) {
  if (!options.claim.isCurrent()) return;
  liveUndos.push(options);
  shortcutClaimed = true;
  refreshNotice();
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    const expired = liveUndos;
    liveUndos = [];
    for (const { claim, commit } of expired) {
      claim.finish();
      commit?.();
    }
    refreshNotice();
  }, 5_000);
}
