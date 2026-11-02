import { describe, expect, it } from "vite-plus/test";

import { resolveConfirmDialogCopy } from "./ConfirmDialogHost";

describe("resolveConfirmDialogCopy", () => {
  it.each([
    [
      "a question line among others",
      'Delete thread "Plan"?\nThis permanently clears conversation history for this thread.',
      {
        title: 'Delete thread "Plan"?',
        description: "This permanently clears conversation history for this thread.",
      },
    ],
    [
      "a question inside one line",
      "Send SIGKILL to process 42? This cannot be handled by the process.",
      {
        title: "Send SIGKILL to process 42?",
        description: "This cannot be handled by the process.",
      },
    ],
    [
      "a translated question line ending in a full-width question mark",
      "删除对话“Plan”？\n这会永久清除这个对话的全部记录。",
      { title: "删除对话“Plan”？", description: "这会永久清除这个对话的全部记录。" },
    ],
    [
      "a translated question inside one line",
      "向进程 42 发送 SIGKILL？进程无法处理这个信号。",
      { title: "向进程 42 发送 SIGKILL？", description: "进程无法处理这个信号。" },
    ],
    [
      "a message without a question",
      "Something happened.",
      { title: "Confirm action", description: "Something happened." },
    ],
  ])("splits %s", (_case, message, expected) => {
    expect(resolveConfirmDialogCopy(message)).toEqual(expected);
  });
});
