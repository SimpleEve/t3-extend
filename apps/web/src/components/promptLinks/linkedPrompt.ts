import type { LinkedPrompt } from "@t3tools/shared/promptLinks";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";
import { getUiLocale, translate } from "@t3tools/client-runtime/i18n";

export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: translate(getUiLocale(), "This prompt had hidden characters, it may be malicious"),
    description: translate(
      getUiLocale(),
      prompt.hiddenCharacters === 1
        ? "T3 Extend removed {count} hidden character. Read the prompt before you send it."
        : "T3 Extend removed {count} hidden characters. Read the prompt before you send it.",
      { count: prompt.hiddenCharacters },
    ),
    timeout: 0,
  });
}

export function placeLinkedPrompt(
  target: ComposerThreadTarget,
  prompt: LinkedPrompt,
  notes: ReadonlyArray<string> = [],
): void {
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    useComposerDraftStore.getState().setPrompt(target, prompt.text);
    toastManager.add({
      type: "info",
      title: translate(getUiLocale(), "Prompt added from a link"),
      description: ["Read it before you send.", ...notes].join(" "),
    });
  };
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: translate(getUiLocale(), "Linked prompt ready"),
    description: translate(
      getUiLocale(),
      "This thread already has a draft. Replace it with the linked prompt?",
    ),
    timeout: 0,
    actionProps: {
      children: "Replace draft",
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
