import type { EnvironmentId } from "@t3tools/contracts";
import { promptShortcutInsertionText } from "@t3tools/shared/promptShortcuts";

import ChatMarkdown from "../../components/ChatMarkdown";
import type { MarkdownExtensions } from "~/markdown/wordsHast";
import { useEnvironmentPromptSkills } from "./usePromptShortcutActions";

const PREVIEW_MARKDOWN: MarkdownExtensions = { userMessage: true, leadingWhitespace: true };

/** A saved prompt as a message would show it: `$skill` and `@file` as chips, clipped to two lines. */
export function PromptShortcutPreview({
  environmentId,
  content,
}: {
  environmentId: EnvironmentId;
  content: string;
}) {
  const skills = useEnvironmentPromptSkills(environmentId);
  return (
    <div className="line-clamp-2 max-h-12 overflow-hidden text-xs text-muted-foreground">
      <ChatMarkdown
        text={promptShortcutInsertionText(content)}
        cwd={undefined}
        environmentId={environmentId}
        skills={skills}
        className="user-message-markdown"
        lineBreaks
        parseRawHtml={false}
        extensions={PREVIEW_MARKDOWN}
      />
    </div>
  );
}
