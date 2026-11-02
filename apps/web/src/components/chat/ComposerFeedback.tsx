import {
  codexFeedbackNotice,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { MessageSquareIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { Translator } from "@t3tools/client-runtime/i18n";

// fork: `t` translates the banner; the shared notice text stays English for mobile.
export function feedbackBannerItem(
  submission: CodexFeedbackSubmission,
  onDismiss: () => void,
  t: Translator,
): ComposerBannerStackItem | null {
  const notice = codexFeedbackNotice(submission);
  if (!notice) return null;
  const description =
    submission.status === "sent"
      ? t("Thread ID: {id}", { id: submission.feedbackId })
      : notice.description;
  return {
    id: `feedback:${submission.id}`,
    variant:
      submission.status === "failed" ? "error" : submission.status === "sent" ? "success" : "info",
    icon: <MessageSquareIcon />,
    title: t(notice.title),
    description,
    actions:
      submission.status === "sent" ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void writeTextToClipboard(submission.feedbackId, "Codex feedback thread ID").catch(
              (error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: t("Could not copy thread ID"),
                  description: error instanceof Error ? error.message : t("An error occurred."),
                });
              },
            );
          }}
        >
          {t("Copy ID")}
        </Button>
      ) : undefined,
    ...(submission.status !== "uploading"
      ? { dismissLabel: t("Dismiss feedback notice"), onDismiss }
      : {}),
  };
}
