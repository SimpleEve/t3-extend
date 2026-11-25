import { createMemoryHistory } from "@tanstack/react-router";
import type { Editor } from "@tiptap/core";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; import it here.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const shortcut = (name: string, content: string, title: string | null = null) => ({
  id: `shortcut-${name}`,
  name,
  title,
  content,
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
});

// Its own file: the app's shell subscription outlives a test, and it must list this thread.
it("typing :name opens saved prompts, and Tab expands one into the composer with its skill as a chip", async () => {
  // The ghost hint is for desktop-width composers; the default test viewport is a phone's.
  await page.viewport(1280, 800);
  const thread = threadWithHistory("thread-prompt-shortcut", 1);
  using _environment = installFakeEnvironment([thread], {
    providers: [
      {
        ...CODEX_PROVIDER,
        skills: [{ name: "babysit", path: "/skills/babysit/SKILL.md", enabled: true }],
      },
    ],
    settings: {
      promptShortcuts: [
        shortcut("review", "Please $babysit this change", "Code review"),
        shortcut("summary", "Summarize the thread"),
      ],
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("Answer 0 for thread-prompt-shortcut.")).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  const menu = () => document.querySelector("[data-composer-command-drawer]");
  const ghost = () => document.querySelector("[data-composer-ghost-text]");
  const proseMirror = () =>
    (document.querySelector(".tiptap") as (HTMLElement & { editor: Editor }) | null)!.editor;

  // Times, URLs and a colon that matches nothing open no menu.
  await userEvent.click(editor);
  await userEvent.keyboard("at 10:30 see http://x :zzz");
  expect(menu()).toBeNull();
  proseMirror().commands.clearContent(true);

  await userEvent.keyboard(":re");
  await expect.element(page.getByText(":review")).toBeVisible();
  expect(page.getByText(":summary").elements()).toHaveLength(0);
  // The ghost hints the rest of the name and a peek at the prompt, outside the document.
  await vi.waitFor(() => expect(ghost()?.textContent).toBe("view — Please $babysit this change"));
  expect(proseMirror().state.doc.textContent).toBe(":re");

  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => expect(menu()).toBeNull());
  expect(ghost()).toBeNull();
  // `$babysit` renders as the same chip it is when typed, and the text around it stays editable.
  await expect.element(editor.getByText("babysit")).toBeVisible();
  expect(proseMirror().state.doc.textContent).not.toContain(":re");
  expect(proseMirror().state.doc.textContent).toContain("Please");
  await userEvent.keyboard(" now");
  expect(proseMirror().state.doc.textContent).toContain("this change now");
});
